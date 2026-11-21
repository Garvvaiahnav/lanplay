/* Client screen ("Play on this screen"). Talks to main only through window.lanplay (the preload API). */
namespace LP.Client {
  import h = Dom.h;

  export interface Handle { destroy(): void }

  interface ErrorInfo { message: string }

  export function mount(root: HTMLElement, api: T.Api, opts: { onSwitchMode?: () => void; switchLabel?: string } = {}): Handle {
    let hosts: T.HostInfo[] = [];
    let selectedId: string | null = null;
    let settings: T.StreamSettings | null = null;
    let chip: T.AppleChipInfo | null = null;
    let searchTimedOut = false;
    let pairing = false;
    let pairText = '';
    let pairCode = '';
    let recent: string[] = [];
    let stream: T.StreamState | null = null;
    let error: ErrorInfo | null = null;
    let manualBusy = false;
    let manualError = '';
    let destroyed = false;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubs: Array<() => void> = [];

    /* ---------- static skeleton (built once so focus is never lost) ---------- */
    const statusEl = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const errorEl = h('div', { class: 'error', role: 'alert', hidden: true });
    const hostList = h('ul', { class: 'hosts', 'aria-label': 'Computers found' });
    const manualInput = h('input', { type: 'text', id: 'manual-ip', class: 'text', inputmode: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: Model.MANUAL_PLACEHOLDER });
    const manualBtn = h('button', { type: 'button', class: 'btn' }, 'Add');
    const manualMsg = h('p', { class: 'hint err', role: 'status', 'aria-live': 'polite' });
    const recentEl = h('div', { class: 'recent', 'aria-label': 'Recent internet addresses' });
    const searchBtn = h('button', { type: 'button', class: 'btn ghost' }, 'Search again');

    const presetSeg = Dom.segmented<string>('Preset', [...Model.PRESETS.map((p) => ({ value: p.id as string, label: p.label })), { value: 'custom', label: 'Custom' }], (v) => {
      if (!settings || v === 'custom') return;
      update(Model.applyPreset(settings, v as Exclude<T.PresetId, 'custom'>));
    }, 'wide');
    const presetHint = h('p', { class: 'hint' });
    const resSeg = Dom.segmented<T.ResolutionId>('Resolution', Model.RESOLUTIONS, (v) => settings && update(Model.change(settings, { resolution: v })));
    const fpsSeg = Dom.segmented<T.FpsOption>('Frames per second', Model.FPS, (v) => settings && update(Model.change(settings, { fps: v })));
    const bitrate = h('input', { type: 'range', id: 'bitrate', min: Model.BITRATE.min, max: Model.BITRATE.max, step: Model.BITRATE.step, value: '80' });
    bitrate.addEventListener('input', () => settings && update(Model.change(settings, { bitrateMbps: Number(bitrate.value) })));
    const bitrateOut = h('output', { for: 'bitrate', class: 'out' });
    const advanced = h('input', { type: 'checkbox', id: 'adv' });
    advanced.addEventListener('change', () => settings && update(Model.change(settings, { advancedBitrate: advanced.checked })));
    const codecSeg = Dom.segmented<T.CodecChoice>('Video codec', Model.CODECS, (v) => settings && update(Model.change(settings, { codec: v })));
    const codecHint = h('p', { class: 'hint' });
    const streamBtn = h('button', { type: 'button', class: 'stream-btn' }, 'Stream');
    const stopBtn = h('button', { type: 'button', class: 'btn danger', hidden: true }, 'Stop streaming');
    // Moonlight captures the mouse: always say how to get out of the stream (also shown before streaming starts).
    const escapeHint = h('p', { class: 'stream-escape', role: 'note' }, Model.STREAM_ESCAPE_HINT);

    const field = (label: string, control: Node, hint?: string | Node, id?: string): HTMLElement =>
      h('div', { class: 'field' }, h('label', id ? { for: id, class: 'label' } : { class: 'label' }, label), control, typeof hint === 'string' ? h('p', { class: 'hint' }, hint) : hint);

    const settingsBox = h('section', { class: 'card', 'aria-labelledby': 'h-settings' },
      h('h2', { id: 'h-settings' }, 'Picture'),
      field('Preset', presetSeg.el, presetHint),
      h('details', { class: 'more' },
        h('summary', null, 'More settings'),
        h('div', { class: 'more-body' },
          h('div', { class: 'two' }, field('Resolution', resSeg.el), field('Frames per second', fpsSeg.el)),
          field('Bitrate', h('div', { class: 'slider' }, bitrate, bitrateOut), Model.HINTS.bitrate, 'bitrate'),
          h('label', { class: 'check', for: 'adv' }, advanced, 'Allow up to 500 Mbps'),
          field('Video codec', codecSeg.el, codecHint))));

    const hostBox = h('section', { class: 'card', 'aria-labelledby': 'h-host' },
      h('div', { class: 'row between' }, h('h2', { id: 'h-host' }, 'Computer'), searchBtn),
      hostList,
      h('div', { class: 'manual' }, h('label', { for: 'manual-ip', class: 'label' }, 'Connect by IP'), h('div', { class: 'row' }, manualInput, manualBtn), recentEl, manualMsg));

    const screen = h('main', { class: 'screen' },
      h('header', { class: 'top' }, h('h1', null, 'LanPlay'), opts.onSwitchMode ? h('button', { type: 'button', class: 'link', onClick: () => opts.onSwitchMode?.() }, opts.switchLabel ?? 'Change mode') : null),
      statusEl, errorEl, hostBox, settingsBox,
      h('div', { class: 'stream-row' }, escapeHint, streamBtn, stopBtn));
    Dom.setChildren(root, [screen]);

    /* ---------- rendering ---------- */
    const selected = (): T.HostInfo | null => hosts.find((x) => x.id === selectedId) ?? null;

    function phase(): Model.ClientPhase {
      return Model.clientPhase({ hostCount: hosts.length, searchTimedOut, pairing, stream, hasError: error !== null });
    }

    function renderHosts(): void {
      const active = document.activeElement;
      const focusId = active instanceof HTMLElement && hostList.contains(active) ? active.id : '';
      const items: Dom.Child[] = hosts.map((host) => {
        const st = Model.hostStatus(host);
        const id = 'host-' + host.id.replace(/[^A-Za-z0-9_-]/g, '_');
        const radio = h('input', { type: 'radio', name: 'host', id, value: host.id, checked: host.id === selectedId });
        radio.addEventListener('change', () => {
          selectedId = host.id;
          error = null;
          render();
        });
        return h('li', { class: 'host' + (host.id === selectedId ? ' on' : '') },
          radio,
          h('label', { for: id },
            h('span', { class: 'dot ' + st.dot, 'aria-hidden': 'true' }),
            h('span', { class: 'hname' }, host.name),
            host.remote === true ? h('span', { class: 'badge tag' }, 'Internet') : null,
            h('span', { class: 'haddr' }, host.preferredAddress),
            h('span', { class: 'hstate' }, st.label),
            host.remote === true ? h('span', { class: 'hwarn' }, Model.REMOTE_WARNING) : null));
      });
      if (items.length === 0) items.push(h('li', { class: 'empty' }, searchTimedOut ? 'Nothing found.' : 'Searching...'));
      Dom.setChildren(hostList, items);
      if (focusId) document.getElementById(focusId)?.focus();
    }

    function renderRecent(): void {
      Dom.setChildren(recentEl, recent.map((addr) =>
        h('button', { type: 'button', class: 'btn ghost recent-btn', disabled: manualBusy, onClick: () => addManual(addr) }, addr)));
      recentEl.hidden = recent.length === 0;
    }

    function render(): void {
      if (destroyed) return;
      const ph = phase();
      const sel = selected();
      if (ph === 'pairing' && pairCode) {
        const [lead, code, tail] = Model.pairCodeParts(pairCode);
        Dom.setChildren(statusEl, [lead, h('strong', { class: 'pair-code' }, code), tail]);
      } else statusEl.textContent = ph === 'pairing' && pairText ? pairText : Model.phaseMessage(ph, sel?.name ?? null);
      statusEl.className = 'status ph-' + ph;
      if (error) {
        errorEl.hidden = false;
        Dom.setChildren(errorEl, [error.message]);
      } else errorEl.hidden = true;
      renderHosts();
      manualBtn.disabled = manualBusy;
      manualMsg.textContent = manualError;
      renderRecent();

      if (settings) {
        presetSeg.set(settings.presetId);
        resSeg.set(settings.resolution);
        fpsSeg.set(settings.fps);
        codecSeg.set(settings.codec);
        bitrate.max = String(settings.advancedBitrate ? Model.BITRATE.advancedMax : Model.BITRATE.max);
        bitrate.value = String(settings.bitrateMbps);
        bitrate.setAttribute('aria-valuetext', Model.bitrateText(settings.bitrateMbps));
        bitrateOut.textContent = Model.bitrateText(settings.bitrateMbps);
        advanced.checked = settings.advancedBitrate;
        const preset = Model.PRESETS.find((p) => p.id === settings?.presetId);
        presetHint.textContent = preset ? preset.description : '';
        presetHint.hidden = !preset;
        codecHint.textContent = Model.codecHint(settings.codec, chip);
      }
      const busy = ph === 'pairing' || ph === 'streaming';
      for (const s of [presetSeg, resSeg, fpsSeg, codecSeg]) s.setDisabled(busy);
      bitrate.disabled = busy;
      advanced.disabled = busy;
      streamBtn.disabled = busy || sel === null || settings === null;
      streamBtn.textContent = ph === 'pairing' ? 'Pairing...' : ph === 'streaming' ? (stream?.state === 'starting' ? 'Starting...' : 'Streaming') : sel && sel.paired !== true && sel.remote !== true ? 'Pair and stream' : 'Stream';
      stopBtn.hidden = ph !== 'streaming';
      escapeHint.classList.toggle('live', ph === 'streaming');
    }

    /* ---------- actions ---------- */
    function update(next: T.StreamSettings): void {
      settings = next;
      render();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void persist(), 250);
    }

    async function persist(): Promise<void> {
      saveTimer = undefined;
      if (!settings || destroyed) return;
      try {
        settings = await api.invoke('client:settings-set', settings);
        render();
      } catch (e) {
        showError('Could not save settings: ' + msg(e));
      }
    }

    function msg(e: unknown): string {
      return e instanceof Error ? e.message : String(e);
    }
    function showError(m: string): void {
      error = { message: m };
      render();
    }

    function setHosts(list: T.HostInfo[]): void {
      hosts = list;
      if (!selected()) selectedId = (list.find((x) => x.paired === true) ?? list[0])?.id ?? null;
      if (list.length > 0) searchTimedOut = false;
      render();
    }

    function startSearch(): void {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimedOut = false;
      searchTimer = setTimeout(() => {
        searchTimedOut = true;
        render();
      }, 6000);
      api.invoke('client:discover-start').then(setHosts, (e: unknown) => showError('Search failed: ' + msg(e)));
      render();
    }

    async function doStream(): Promise<void> {
      const host = selected();
      if (!host || !settings) return;
      error = null;
      try {
        if (host.paired !== true) {
          pairing = true;
          pairCode = '';
          pairText = Model.pairPhaseText({ hostId: host.id, phase: 'checking', message: '' });
          render();
          const r = await api.invoke('client:pair', { hostId: host.id });
          pairing = false;
          pairCode = '';
          if (!r.ok) {
            showError(Model.pairErrorMessage(r));
            return;
          }
          hosts = hosts.map((x) => (x.id === host.id ? { ...x, paired: true } : x));
        }
        const flush = saveTimer ? (clearTimeout(saveTimer), persist()) : Promise.resolve();
        await flush;
        stream = { hostId: host.id, state: 'starting' };
        render();
        const st = await api.invoke('client:stream-start', { hostId: host.id, settings });
        onStreamState(st);
      } catch (e) {
        pairing = false;
        pairCode = '';
        stream = null;
        showError(msg(e));
      }
    }

    function onStreamState(st: T.StreamState): void {
      if (st.state === 'failed') {
        stream = null;
        error = { message: st.message ?? 'Streaming could not start.' };
      } else if (st.state === 'ended') {
        stream = null;
        if (st.exitCode !== undefined && st.exitCode !== null && st.exitCode !== 0) error = { message: st.message ?? 'Streaming stopped (code ' + st.exitCode + ').' };
      } else stream = st;
      render();
    }

    streamBtn.addEventListener('click', () => void doStream());
    stopBtn.addEventListener('click', () => {
      const host = selected();
      if (host) api.invoke('client:stream-stop', { hostId: host.id }).catch((e: unknown) => showError(msg(e)));
    });
    searchBtn.addEventListener('click', () => {
      api.invoke('client:discover-stop').catch(() => undefined).then(startSearch);
    });
    function addManual(typed: string = manualInput.value): void {
      if (manualBusy) return;
      const addr = Model.validAddress(typed);
      if (!addr) {
        manualError = 'That does not look like an IP address.';
        render();
        return;
      }
      manualBusy = true;
      manualError = '';
      render();
      api.invoke('client:add-manual-host', { address: addr }).then(
        (hi) => {
          manualBusy = false;
          manualInput.value = '';
          selectedId = hi.id;
          const known = hosts.some((x) => x.id === hi.id);
          setHosts(known ? hosts.map((x) => (x.id === hi.id ? hi : x)) : [...hosts, hi]);
          // The service moves the settings to the Internet preset the first time an address is typed (once per address, D12): the
          // renderer must not do it again every app session, which would overwrite a Custom choice. It only reads the result.
          if (hi.remote === true) {
            void loadRecent();
            void syncSettings();
          }
        },
        (e: unknown) => {
          manualBusy = false;
          manualError = Model.manualFailure(addr, msg(e));
          render();
        },
      );
    }

    /** Show what the service holds (it may just have applied the Internet preset). A pending local edit wins until it is saved. */
    async function syncSettings(): Promise<void> {
      if (saveTimer) return;
      try {
        const s = await api.invoke('client:settings-get');
        if (destroyed || saveTimer) return;
        settings = s;
        render();
      } catch {
        /* keep what is shown */
      }
    }

    async function loadRecent(): Promise<void> {
      try {
        recent = await api.invoke('client:recent-remote');
      } catch {
        recent = [];
      }
      render();
    }

    manualBtn.addEventListener('click', () => addManual());
    manualInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addManual();
    });

    /* ---------- wiring ---------- */
    unsubs.push(api.on('client:hosts-updated', setHosts));
    unsubs.push(api.on('client:pair-progress', (p) => {
      if (p.hostId === selectedId) {
        pairText = Model.pairPhaseText(p);
        pairCode = p.phase === 'show-code' && p.code ? p.code : '';
      }
      render();
    }));
    unsubs.push(api.on('client:stream-state', onStreamState));

    render();
    Promise.all([api.invoke('client:settings-get'), api.invoke('client:system-info')]).then(
      ([s, info]) => {
        settings = s;
        chip = info.chip;
        render();
      },
      (e: unknown) => showError('Could not load settings: ' + msg(e)),
    );
    startSearch();
    void loadRecent();

    return {
      destroy() {
        destroyed = true;
        if (searchTimer) clearTimeout(searchTimer);
        if (saveTimer) {
          clearTimeout(saveTimer);
          if (settings) void api.invoke('client:settings-set', settings).catch(() => undefined);
        }
        for (const u of unsubs) u();
        api.invoke('client:discover-stop').catch(() => undefined);
        Dom.clear(root);
      },
    };
  }
}
