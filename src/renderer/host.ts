/* Host screen ("This PC hosts games"). Talks to main only through window.lanplay. */
namespace LP.Host {
  import h = Dom.h;

  export interface Handle { destroy(): void }

  /** Wording that differs per platform. Windows is the default until app:info says otherwise. */
  const WORDS = {
    win: {
      thing: 'this PC',
      nameTitle: 'This PC',
      nameHint: 'If the other computer cannot find this PC, type this name or address there.',
      sunHint: 'Setup asks Windows for permission once, installs Sunshine, opens the firewall for your home network, starts it at login and replaces an existing Sunshine web login.',
      pairHint: 'Closing this window keeps LanPlay running in the background. To stop it, use File > Exit.',
      install: 'Install and set up',
      running: 'Setting up. Approve the Windows prompt if it appears.',
      ready: 'Setup finished. This PC is ready.',
      applying: 'Applying. Approve the Windows prompt if it appears.',
    },
    mac: {
      thing: 'this Mac',
      nameTitle: 'This Mac',
      nameHint: 'If the other computer cannot find this Mac, type this name or address there.',
      sunHint: 'Setup installs a copy of Sunshine, starts it at login and then asks you to allow Screen Recording and Accessibility.',
      pairHint: 'Closing this window keeps LanPlay running in the background. To stop it, choose LanPlay > Quit LanPlay.',
      install: 'Set up this Mac',
      running: 'Setting up. macOS may say "Background items added": that is Sunshine and LanPlay starting at login.',
      ready: 'Setup finished. This Mac is ready.',
      applying: 'Applying...',
    },
  } as const;
  /** How often to re-read the setup status while a permission is being granted in System Settings. */
  const GRANT_POLL_MS = 2000;
  /** How often to look for devices that started pairing (Sunshine has no push for it) while the window is visible. */
  const PENDING_POLL_MS = 3000;

  export function mount(root: HTMLElement, api: T.Api, opts: { onSwitchMode?: () => void; switchLabel?: string } = {}): Handle {
    let info: T.AppInfo | null = null;
    let status: T.HostSetupStatus | null = null;
    let agent: T.AgentState | null = null;
    let devices: T.PairedDevice[] = [];
    let live: T.StepRecord[] = [];
    let report: T.SelfCheckReport | null = null;
    let setupBusy = false;
    let checkBusy = false;
    let diagBusy = false;
    let diagPath = '';
    let note = '';
    let noteIsError = false;
    let ctl: T.ControllersState | null = null;
    let confirmUuid: string | null = null;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let pollBusy = false;
    let restartBusy = false;
    let inet: T.InternetHostState | null = null;
    let netBusy = false;
    let pending: T.PendingCodePairing[] = [];
    const pins = new Map<string, string>();
    const rowBusy = new Set<string>();
    const rowMsg = new Map<string, string>();
    let pendingSig = '';
    let pendingTimer: ReturnType<typeof setInterval> | undefined;
    const unsubs: Array<() => void> = [];

    const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    const say = (m: string, isErr = false): void => {
      note = m;
      noteIsError = isErr;
      render();
    };

    const noteEl = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    const hostNameEl = h('code', { class: 'copyable' }, '...');
    const copyNameBtn = h('button', { type: 'button', class: 'btn ghost' }, 'Copy');
    const addressEl = h('p', { class: 'hint' });
    const sunshineEl = h('ul', { class: 'chips', 'aria-label': 'Sunshine status' });
    const setupBtn = h('button', { type: 'button', class: 'btn primary' }, 'Set up / Repair');
    const stepsEl = h('ol', { class: 'steps', 'aria-label': 'Setup steps' });
    const sunHint = h('p', { class: 'hint' });
    const updateText = h('span', null);
    const restartBtn = h('button', { type: 'button', class: 'btn primary' }, 'Restart Sunshine');
    const updateBanner = h('div', { class: 'banner', role: 'status', hidden: true }, updateText, restartBtn);
    const adminWarn = h('p', { class: 'hint err', role: 'status', hidden: true }, 'LanPlay was started with "Run as administrator". That is not needed and can lock its settings files for normal starts. Close LanPlay and start it normally (double-click); setup asks Windows for permission by itself.');
    const autoSwitch = Dom.toggle('Auto-approve devices on my network', (on) => {
      api.invoke('host:agent-set-auto-approve', { on }).then(setAgent, (e: unknown) => {
        autoSwitch.set(!on);
        say('Could not change the switch: ' + msg(e), true);
      });
    });
    const agentLine = h('p', { class: 'hint' });
    const approvalsEl = h('ul', { class: 'list', 'aria-label': 'Waiting for approval' });
    const devicesEl = h('ul', { class: 'list', 'aria-label': 'Paired devices' });
    const codesEl = h('ul', { class: 'list', 'aria-label': 'Devices waiting for a code' });
    const netSwitch = Dom.toggle('Allow connections from the internet', (on) => void setInternet(on));
    const netOffBtn = h('button', { type: 'button', class: 'btn', onClick: () => void setInternet(false) }, 'Switch off');
    const netBanner = h('div', { class: 'notice', role: 'status', hidden: true }, h('span', null, 'Internet play is on. Switch it off when you are not playing.'), netOffBtn);
    const netExposure = h('div', { class: 'warn-lines' });
    const netError = h('p', { class: 'hint err', role: 'status', 'aria-live': 'polite', hidden: true });
    const netForward = h('p', null);
    const netPorts = h('table', { class: 'ports', 'aria-label': 'Ports to forward' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Protocol'), h('th', { scope: 'col' }, 'Ports'), h('th', { scope: 'col' }, 'Use'))),
      h('tbody', null, ...Model.INTERNET_PORTS.map((r) => h('tr', null, h('td', null, r.protocol), h('td', null, r.ports), h('td', null, r.use)))));
    const netNever = h('p', { class: 'hint' }, 'Never forward ' + Model.INTERNET_NEVER_PORTS + '.');
    const netIpv6 = h('div', { class: 'ipv6' });
    const netFacts = h('p', { class: 'hint' }, 'If your router shows a WAN address that differs from your public IP, your provider uses CGNAT and IPv4 hosting cannot work. Players x bitrate x 1.12 must stay under 70% of your upload speed.');
    const netBody = h('div', { class: 'net-body', hidden: true }, netForward, netPorts, netNever, netIpv6, netFacts);
    const padSwitch = Dom.toggle('Let phones act as game controllers', (on) => {
      api.invoke('host:controllers-set-enabled', { on }).then(setCtl, (e: unknown) => {
        padSwitch.set(!on);
        say('Could not change the switch: ' + msg(e), true);
      });
    });
    const padLine = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const padDriverBtn = h('button', { type: 'button', class: 'btn primary' }, 'Install driver');
    const padLinksEl = h('div', { class: 'pad-links', 'aria-label': 'Phone controller links' });
    const padPlayersEl = h('ul', { class: 'list', 'aria-label': 'Connected phones' });
    const padNewLinkBtn = h('button', { type: 'button', class: 'btn' }, 'New link');
    const padRow = h('div', { class: 'row' }, padDriverBtn, padNewLinkBtn);
    const checkBtn = h('button', { type: 'button', class: 'btn' }, 'Run self-check');
    const checkEl = h('ol', { class: 'steps', 'aria-label': 'Self-check results' });
    const diagBtn = h('button', { type: 'button', class: 'btn' }, 'Copy diagnostics');
    const diagEl = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });

    // The headings that read differently per platform are kept so render() can reword them.
    const nameTitle = h('h2', { id: 'h-name' }, 'This PC');
    const nameHint = h('p', { class: 'hint' });
    const pairHint = h('p', { class: 'hint' });
    const card = (id: string, title: string | HTMLElement, ...kids: Dom.Child[]): HTMLElement =>
      h('section', { class: 'card', 'aria-labelledby': id }, typeof title === 'string' ? h('h2', { id }, title) : title, ...kids);
    const padCard = card('h-pad', 'Phone controllers', h('div', { class: 'row between' }, h('span', { class: 'label' }, 'Let phones act as game controllers'), padSwitch.el), padLine,
      padRow, padLinksEl, padPlayersEl,
      h('p', { class: 'hint' }, 'Open the link on each phone on the same Wi-Fi, or scan the code.'));

    const screen = h('main', { class: 'screen' },
      h('header', { class: 'top' }, h('h1', null, 'LanPlay host'), opts.onSwitchMode ? h('button', { type: 'button', class: 'link', onClick: () => opts.onSwitchMode?.() }, opts.switchLabel ?? 'Change mode') : null),
      noteEl,
      netBanner,
      card('h-name', nameTitle, h('div', { class: 'row' }, hostNameEl, copyNameBtn), addressEl, nameHint, sunshineEl, h('div', { class: 'row' }, setupBtn), sunHint, updateBanner, adminWarn, stepsEl, pairHint),
      card('h-dev', 'Devices', devicesEl,
        h('h3', { id: 'h-codes' }, 'Add a device with a code'), codesEl,
        h('div', { class: 'row between' }, h('span', { class: 'label' }, 'Auto-approve devices on my network'), autoSwitch.el),
        agentLine, approvalsEl),
      card('h-net', 'Internet', h('div', { class: 'row between' }, h('span', { class: 'label' }, 'Allow connections from the internet'), netSwitch.el), netExposure, netError, netBody),
      padCard,
      card('h-health', 'Health', h('div', { class: 'row' }, checkBtn, diagBtn), diagEl, checkEl));
    Dom.setChildren(root, [screen]);

    function chip(label: string, state: boolean | null): HTMLElement {
      const dot = state === null ? 'off' : state ? 'ok' : 'warn';
      const word = state === null ? 'unknown' : state ? 'yes' : 'no';
      return h('li', { class: 'chip' }, h('span', { class: 'dot ' + dot, 'aria-hidden': 'true' }), label + ': ' + word);
    }

    /** `actionable`: macOS setup steps that the user has to finish in System Settings get their buttons. */
    function stepRow(s: T.StepRecord, actionable = false): HTMLElement {
      const act = actionable ? Model.stepAction(s) : null;
      return h('li', { class: 'step ' + s.status },
        h('span', { class: 'badge ' + s.status }, Model.statusWord(s.status)),
        h('span', { class: 'stitle' }, s.title),
        s.message ? h('span', { class: 'smsg' }, s.message) : null,
        act ? h('span', { class: 'sactions' },
          act.pane ? h('button', { type: 'button', class: 'btn', onClick: () => openSettings(act.pane as T.SettingsPane) }, act.paneLabel) : null,
          act.confirmInput ? h('button', { type: 'button', class: 'btn primary', onClick: confirmInput }, 'I did this') : null,
          act.restartSunshine ? h('button', { type: 'button', class: 'btn primary', disabled: restartBusy, onClick: () => void restartSunshine() }, 'Restart Sunshine') : null) : null);
    }

    function render(): void {
      if (destroyed) return;
      const mac = isMac();
      const w = mac ? WORDS.mac : WORDS.win;
      nameTitle.textContent = w.nameTitle;
      nameHint.textContent = w.nameHint;
      sunHint.textContent = w.sunHint;
      pairHint.textContent = w.pairHint;
      padCard.hidden = mac; // the Mac has no virtual gamepad backend yet
      noteEl.textContent = note;
      noteEl.className = 'status' + (noteIsError ? ' error-text' : '');
      hostNameEl.textContent = info?.hostName ?? '(unknown)';
      copyNameBtn.disabled = !info?.hostName;
      const addrs = info?.localAddresses?.length ? info.localAddresses : inet?.lanAddresses ?? [];
      addressEl.textContent = addrs.length ? 'Address: ' + addrs.join(', ') : '';
      addressEl.hidden = addrs.length === 0;
      const sum = Model.sunshineSummary(status);
      // No "Administrator rights" chip: LanPlay should NOT be run as administrator (setup asks Windows once); a yellow
      // "no" there only invites people to do exactly that. Admin status is still recorded in self-check and diagnostics.
      Dom.setChildren(sunshineEl, [chip('Installed', sum.installed), chip('Running', sum.running)]);
      adminWarn.hidden = mac || status?.isAdmin !== true;
      setupBtn.disabled = setupBusy || netBusy;
      setupBtn.textContent = setupBusy ? 'Working...' : sum.installed ? 'Set up / Repair' : w.install;
      // Steps show during a run, after a run that failed, and (Mac) while a permission or confirmation is still open.
      const stored = mac && !setupBusy ? status?.steps ?? [] : live;
      const shown = setupBusy || netBusy || stored.some((s) => s.status !== 'pass' && (mac || s.status === 'fail')) ? stored : [];
      Dom.setChildren(stepsEl, shown.map((s) => stepRow(s, mac)));
      stepsEl.hidden = shown.length === 0;
      const update = mac ? Model.sunshineUpdate(status) : null;
      updateBanner.hidden = !update;
      if (update) updateText.textContent = 'Sunshine update ready. Version ' + update.bundled + ' is waiting; this Mac still runs ' + update.installed + '. Restarting Sunshine ends a stream that is running.';
      restartBtn.disabled = restartBusy;
      restartBtn.textContent = restartBusy ? 'Restarting...' : 'Restart Sunshine';
      autoSwitch.set(agent?.autoApprove ?? true);
      agentLine.textContent = agent ? (agent.listening ? 'Pair agent is listening on port ' + agent.port + '.' : 'Pair agent is not running.' + (agent.lastError ? ' ' + agent.lastError : '')) : '';
      Dom.setChildren(approvalsEl, (agent?.pending ?? []).map((p) =>
        h('li', { class: 'item' }, h('span', { class: 'iname' }, p.clientName, h('span', { class: 'sub' }, p.remoteAddress)),
          h('button', { type: 'button', class: 'btn primary', onClick: () => decide(p.requestId, true) }, 'Approve'),
          h('button', { type: 'button', class: 'btn', onClick: () => decide(p.requestId, false) }, 'Deny'))));
      Dom.setChildren(devicesEl, devices.length === 0 ? [h('li', { class: 'empty' }, 'No paired devices yet.')] : devices.map((d) => {
        const sure = confirmUuid === d.uuid;
        return h('li', { class: 'item' }, h('span', { class: 'iname' }, d.name, h('span', { class: 'sub' }, Model.deviceVia(d) + (d.lastAddress ? ', ' + d.lastAddress : ''))),
          h('button', { type: 'button', class: 'btn' + (sure ? ' danger' : ''), 'aria-label': (sure ? 'Confirm revoke ' : 'Revoke ') + d.name, onClick: () => revoke(d) }, sure ? 'Really revoke?' : 'Revoke'));
      }));
      renderPending();
      renderNet(mac, w);
      renderPad();
      checkBtn.disabled = checkBusy;
      checkBtn.textContent = checkBusy ? 'Checking...' : 'Run self-check';
      Dom.setChildren(checkEl, report ? [h('li', { class: 'step ' + (report.ok ? 'pass' : 'fail') }, h('span', { class: 'stitle' }, report.ok ? 'All checks passed' : 'Some checks failed')), ...report.steps.map((s) => stepRow(s))] : []);
      diagBtn.disabled = diagBusy;
      diagBtn.textContent = diagBusy ? 'Collecting...' : 'Copy diagnostics';
      Dom.setChildren(diagEl, diagPath ? ['Saved: ' + diagPath + ' ', h('button', { type: 'button', class: 'link', onClick: () => void reveal() }, 'Show file')] : []);
      syncPoll();
    }

    function renderNet(mac: boolean, w: { thing: string }): void {
      const on = inet?.enabled === true;
      if (!netBusy) netSwitch.set(on);
      netSwitch.el.disabled = netBusy;
      netOffBtn.disabled = netBusy;
      netBanner.hidden = !on;
      netBody.hidden = !on;
      Dom.setChildren(netExposure, Model.exposureText(mac).map((l) => h('p', { class: 'warn-line' }, l)));
      netError.hidden = !inet?.lastError;
      netError.textContent = inet?.lastError ?? '';
      const lan = inet?.lanAddresses ?? [];
      Dom.setChildren(netForward, ['Forward these to ' + w.thing + (lan.length ? ' at ' : ''), lan.length ? h('code', { class: 'copyable' }, lan.join(', ')) : null, ', the same port outside and inside.']);
      const v6 = inet?.globalIpv6 ?? [];
      Dom.setChildren(netIpv6, v6.length ? [h('p', { class: 'label' }, 'Global IPv6'), h('ul', { class: 'list', 'aria-label': 'Global IPv6 addresses' }, ...v6.map((a) => h('li', null, h('code', { class: 'copyable' }, a))))] : []);
      netIpv6.hidden = v6.length === 0;
    }

    async function setInternet(on: boolean): Promise<void> {
      if (netBusy) return;
      netBusy = true;
      live = [];
      say((isMac() ? WORDS.mac : WORDS.win).applying);
      try {
        inet = await api.invoke('host:internet-set', { on });
        // Main answers with the real state: when the PC refused the change the switch is back where it was.
        if (inet.enabled === on) say(on ? 'Internet play is on.' : 'Internet play is off.', false);
        else say((inet.enabled ? 'Internet play is still on.' : 'Internet play is still off.') + (inet.lastError ? ' ' + inet.lastError : ''), true);
      } catch (e) {
        netSwitch.set(!on);
        say('Could not change internet play: ' + msg(e), true);
      } finally {
        netBusy = false;
        render();
      }
    }

    function pendingSignature(): string {
      return JSON.stringify([pending, [...rowBusy], [...rowMsg]]);
    }

    /** Rebuilt only when the list or a row's state changed, so a poll never wipes a code that is being typed. */
    function renderPending(): void {
      const sig = pendingSignature();
      if (sig === pendingSig) return;
      pendingSig = sig;
      const active = document.activeElement;
      const focusId = active instanceof HTMLInputElement && codesEl.contains(active) ? active.id : '';
      Dom.setChildren(codesEl, pending.length === 0 ? [h('li', { class: 'empty' }, 'Nothing waiting for a code.')] : pending.map(pendingRow));
      if (focusId) document.getElementById(focusId)?.focus();
    }

    function pendingRow(p: T.PendingCodePairing): HTMLElement {
      const busy = rowBusy.has(p.id);
      const pin = h('input', { type: 'text', id: 'pin-' + p.id.replace(/[^A-Za-z0-9_-]/g, '_'), class: 'text pin', inputmode: 'numeric', maxlength: 4, autocomplete: 'off', placeholder: '0000', 'aria-label': 'Code for ' + p.name, value: pins.get(p.id) ?? '', disabled: busy });
      const pairBtn = h('button', { type: 'button', class: 'btn primary', disabled: busy || !Model.validPin(pins.get(p.id) ?? '') }, busy ? 'Pairing...' : 'Pair');
      const submit = (): void => pairWithCode(p);
      pin.addEventListener('input', () => {
        const v = pin.value.replace(/\D/g, '').slice(0, 4);
        if (v !== pin.value) pin.value = v;
        pins.set(p.id, v);
        pairBtn.disabled = !Model.validPin(v);
      });
      pin.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && Model.validPin(pins.get(p.id) ?? '')) submit();
      });
      pairBtn.addEventListener('click', submit);
      const msgText = rowMsg.get(p.id);
      return h('li', { class: 'item' },
        h('span', { class: 'iname' }, p.name, h('span', { class: 'sub' }, p.address)),
        p.remote ? h('span', { class: 'badge tag' }, 'Internet') : null,
        pin, pairBtn,
        h('button', { type: 'button', class: 'btn', disabled: busy, 'aria-label': 'Reject ' + p.name, onClick: () => rejectPending(p) }, 'Reject'),
        msgText ? h('span', { class: 'smsg err', role: 'alert' }, msgText) : null);
    }

    function pairWithCode(p: T.PendingCodePairing): void {
      const pin = pins.get(p.id) ?? '';
      if (!Model.validPin(pin) || rowBusy.has(p.id)) return;
      rowBusy.add(p.id);
      rowMsg.delete(p.id);
      render();
      api.invoke('host:pending-pair', { id: p.id, pin, name: p.name }).then(
        (r) => {
          rowBusy.delete(p.id);
          pending = r.pending;
          devices = r.devices;
          pins.delete(p.id);
          if (r.ok) say(p.name + ' is paired.');
          else rowMsg.set(p.id, r.message ?? 'That code did not work.');
          render();
        },
        (e: unknown) => {
          rowBusy.delete(p.id);
          rowMsg.set(p.id, msg(e));
          render();
        },
      );
    }

    function rejectPending(p: T.PendingCodePairing): void {
      api.invoke('host:pending-reject', { id: p.id }).then(
        (list) => {
          pins.delete(p.id);
          rowMsg.delete(p.id);
          pending = list;
          render();
        },
        (e: unknown) => say('Could not reject ' + p.name + ': ' + msg(e), true),
      );
    }

    async function refreshPending(): Promise<void> {
      try {
        pending = await api.invoke('host:pending-list');
        for (const id of [...pins.keys()]) if (!pending.some((p) => p.id === id)) pins.delete(id);
        for (const id of [...rowMsg.keys()]) if (!pending.some((p) => p.id === id)) rowMsg.delete(id);
        if (!destroyed) render();
      } catch {
        /* Sunshine may not be ready yet; the list stays as it was. */
      }
    }

    function isMac(): boolean {
      return info?.platform === 'darwin';
    }

    function adopt(s: T.HostSetupStatus): void {
      status = s;
      render();
    }

    /** Sunshine only gets the Screen Recording grant after macOS restarts it, so the screen re-reads the status until the step passes. */
    function syncPoll(): void {
      const want = isMac() && Model.waitingForGrant(status);
      if (want && pollTimer === undefined) pollTimer = setInterval(() => void poll(), GRANT_POLL_MS);
      else if (!want && pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    }

    async function poll(): Promise<void> {
      if (pollBusy || setupBusy) return;
      pollBusy = true;
      try {
        adopt(await api.invoke('host:setup-status'));
      } catch {
        /* Sunshine may be restarting; the next tick tries again. */
      } finally {
        pollBusy = false;
      }
    }

    function openSettings(pane: T.SettingsPane): void {
      api.invoke('host:open-settings', { pane }).catch((e: unknown) => say('Could not open System Settings: ' + msg(e), true));
    }

    function confirmInput(): void {
      api.invoke('host:confirm-input', { ok: true }).then(adopt, (e: unknown) => say('Could not save that: ' + msg(e), true));
    }

    function renderPad(): void {
      padSwitch.set(ctl?.enabled ?? false);
      const needDriver = ctl !== null && !ctl.driver.ok && ctl.driver.reason === 'driver-missing';
      padDriverBtn.hidden = !needDriver;
      padDriverBtn.disabled = ctl?.setupRunning === true;
      padDriverBtn.textContent = ctl?.setupRunning ? 'Installing...' : 'Install driver';
      padNewLinkBtn.hidden = !ctl?.running;
      padRow.hidden = padDriverBtn.hidden && padNewLinkBtn.hidden;
      const lines: string[] = [];
      if (ctl?.error) lines.push(ctl.error);
      else if (needDriver) lines.push('The virtual controller driver (ViGEmBus) is not installed. Windows will ask for permission once.');
      else if (ctl && !ctl.driver.ok) lines.push('Virtual controllers are not available: ' + ctl.driver.message);
      else if (ctl?.running) lines.push('Ready on port ' + ctl.port + '. Up to 4 phones.');
      else if (ctl?.enabled) lines.push('Turning on...');
      padLine.textContent = lines.join(' ');
      padLine.className = 'hint' + (ctl?.error ? ' err' : '');
      Dom.setChildren(padLinksEl, (ctl?.links ?? []).map((l) =>
        h('div', { class: 'pad-link' },
          h('img', { class: 'qr', src: l.qrDataUrl, alt: 'QR code for ' + l.address, width: 140, height: 140 }),
          h('div', { class: 'pad-link-text' },
            h('code', { class: 'copyable' }, l.url),
            h('button', { type: 'button', class: 'btn ghost', onClick: () => void copyLink(l.url) }, 'Copy link')))));
      Dom.setChildren(padPlayersEl, (ctl?.players ?? []).map((p) =>
        h('li', { class: 'item' },
          h('span', { class: 'iname' }, 'Player ' + p.slot + ': ' + p.name, h('span', { class: 'sub' }, p.address + (p.stale ? ', not responding' : ''))),
          h('button', { type: 'button', class: 'btn', 'aria-label': 'Remove ' + p.name, onClick: () => kickPlayer(p.id) }, 'Remove'))));
    }

    function setCtl(s: T.ControllersState): void {
      ctl = s;
      render();
    }

    async function copyLink(url: string): Promise<void> {
      say((await Dom.copyText(url)) ? 'Link copied.' : 'Could not copy. Select the link and copy it by hand.', false);
    }

    function kickPlayer(id: string): void {
      api.invoke('host:controllers-kick', { id }).then(setCtl, (e: unknown) => say('Could not remove the phone: ' + msg(e), true));
    }

    function setAgent(a: T.AgentState): void {
      agent = a;
      render();
    }

    function decide(requestId: string, approve: boolean): void {
      api.invoke('host:agent-decide', { requestId, approve }).then(setAgent, (e: unknown) => say(msg(e), true));
    }

    function revoke(d: T.PairedDevice): void {
      if (confirmTimer) clearTimeout(confirmTimer);
      if (confirmUuid !== d.uuid) {
        confirmUuid = d.uuid;
        confirmTimer = setTimeout(() => {
          confirmUuid = null;
          render();
        }, 4000);
        render();
        return;
      }
      confirmUuid = null;
      api.invoke('host:devices-revoke', { uuid: d.uuid }).then(
        (list) => {
          devices = list;
          say(d.name + ' can no longer connect.');
        },
        (e: unknown) => say('Could not revoke: ' + msg(e), true),
      );
    }

    async function reveal(): Promise<void> {
      try {
        await api.invoke('diagnostics:reveal', { zipPath: diagPath });
      } catch (e) {
        say('Could not open the folder: ' + msg(e), true);
      }
    }

    setupBtn.addEventListener('click', async () => {
      setupBusy = true;
      live = [];
      say((isMac() ? WORDS.mac : WORDS.win).running);
      try {
        status = await api.invoke('host:setup-run');
        live = status.steps;
        const todo = status.steps.some((s) => Model.stepAction(s));
        const broken = status.steps.some((s) => s.status === 'fail' && !Model.stepAction(s));
        if (isMac() && todo && !broken) say('Setup finished. Allow Sunshine in System Settings with the buttons below to finish.');
        else say(status.ok ? (isMac() ? WORDS.mac : WORDS.win).ready : 'Setup finished with problems. See the steps below, then press Copy diagnostics.', !status.ok);
      } catch (e) {
        say('Setup failed: ' + msg(e), true);
      } finally {
        setupBusy = false;
        render();
      }
    });
    async function restartSunshine(): Promise<void> {
      if (restartBusy) return;
      restartBusy = true;
      render();
      try {
        adopt(await api.invoke('host:sunshine-restart'));
        say('Sunshine restarted.');
      } catch (e) {
        say('Could not restart Sunshine: ' + msg(e), true);
      } finally {
        restartBusy = false;
        render();
      }
    }
    restartBtn.addEventListener('click', () => void restartSunshine());
    checkBtn.addEventListener('click', async () => {
      checkBusy = true;
      render();
      try {
        report = await api.invoke('selfcheck:run');
      } catch (e) {
        say('Self-check failed to run: ' + msg(e), true);
      } finally {
        checkBusy = false;
        render();
      }
    });
    diagBtn.addEventListener('click', async () => {
      diagBusy = true;
      diagPath = '';
      render();
      try {
        const r = await api.invoke('diagnostics:collect');
        diagPath = r.zipPath;
        const copied = await Dom.copyText(r.zipPath);
        say(copied ? 'Diagnostics saved. The file path is copied.' : 'Diagnostics saved.');
      } catch (e) {
        say('Could not collect diagnostics: ' + msg(e), true);
      } finally {
        diagBusy = false;
        render();
      }
    });
    padDriverBtn.addEventListener('click', () => {
      say('Installing the controller driver. Approve the Windows prompt if it appears.');
      api.invoke('host:controllers-setup').then(
        (s) => {
          setCtl(s);
          say(s.error ? s.error : 'Phone controllers are ready.', s.error !== null);
        },
        (e: unknown) => say('Driver install failed: ' + msg(e), true),
      );
    });
    padNewLinkBtn.addEventListener('click', () => {
      api.invoke('host:controllers-new-link').then((s) => {
        setCtl(s);
        say('New link created. Phones that used the old link must open the new one.');
      }, (e: unknown) => say('Could not create a new link: ' + msg(e), true));
    });
    copyNameBtn.addEventListener('click', async () => {
      if (!info?.hostName) return;
      say((await Dom.copyText(info.hostName)) ? 'Name copied.' : 'Could not copy. Select the name and copy it by hand.', false);
    });

    unsubs.push(api.on('host:setup-progress', (s) => {
      live = [...live.filter((x) => x.stepId !== s.stepId), s];
      render();
    }));
    unsubs.push(api.on('host:agent-state-changed', (a) => {
      agent = a;
      void refreshDevices();
      void refreshPending();
      render();
    }));
    unsubs.push(api.on('host:internet-changed', (s) => {
      inet = s;
      render();
    }));

    unsubs.push(api.on('host:controllers-changed', setCtl));

    async function refreshDevices(): Promise<void> {
      try {
        devices = await api.invoke('host:devices-list');
        render();
      } catch {
        /* Sunshine may not be ready yet; the list stays as it was. */
      }
    }

    render();
    api.invoke('app:info').then((i) => { info = i; render(); }, () => undefined);
    api.invoke('host:setup-status').then((s) => { status = s; render(); }, (e: unknown) => say('Could not read setup status: ' + msg(e), true));
    api.invoke('host:agent-state').then(setAgent, () => undefined);
    api.invoke('host:controllers-state').then(setCtl, () => undefined);
    api.invoke('host:internet-get').then((s) => { inet = s; render(); }, () => undefined);
    void refreshDevices();
    void refreshPending();
    pendingTimer = setInterval(() => {
      if (!document.hidden) void refreshPending();
    }, PENDING_POLL_MS);

    return {
      destroy() {
        destroyed = true;
        if (pollTimer !== undefined) clearInterval(pollTimer);
        if (pendingTimer !== undefined) clearInterval(pendingTimer);
        if (confirmTimer) clearTimeout(confirmTimer);
        for (const u of unsubs) u();
        Dom.clear(root);
      },
    };
  }
}
