/* Host screen ("This PC hosts games"). Talks to main only through window.lanplay. */
namespace LP.Host {
  import h = Dom.h;

  export interface Handle { destroy(): void }

  export function mount(root: HTMLElement, api: T.Api, opts: { onSwitchMode?: () => void } = {}): Handle {
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
    let confirmUuid: string | null = null;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;
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
    const sunshineEl = h('ul', { class: 'chips', 'aria-label': 'Sunshine status' });
    const setupBtn = h('button', { type: 'button', class: 'btn primary' }, 'Set up / Repair');
    const stepsEl = h('ol', { class: 'steps', 'aria-label': 'Setup steps' });
    const adminWarn = h('p', { class: 'hint err', role: 'status', hidden: true }, 'LanPlay was started with "Run as administrator". That is not needed and can lock its settings files for normal starts. Close LanPlay and start it normally (double-click); setup asks Windows for permission by itself.');
    const autoSwitch = Dom.toggle('Auto-approve devices on my network', (on) => {
      api.invoke('host:agent-set-auto-approve', { on }).then(setAgent, (e: unknown) => {
        autoSwitch.set(!on);
        say('Could not change the switch: ' + msg(e), true);
      });
    });
    const agentLine = h('p', { class: 'hint' });
    const pendingEl = h('ul', { class: 'list', 'aria-label': 'Waiting for approval' });
    const devicesEl = h('ul', { class: 'list', 'aria-label': 'Paired devices' });
    const checkBtn = h('button', { type: 'button', class: 'btn' }, 'Run self-check');
    const checkEl = h('ol', { class: 'steps', 'aria-label': 'Self-check results' });
    const diagBtn = h('button', { type: 'button', class: 'btn' }, 'Copy diagnostics');
    const diagEl = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });

    const card = (id: string, title: string, ...kids: Dom.Child[]): HTMLElement =>
      h('section', { class: 'card', 'aria-labelledby': id }, h('h2', { id }, title), ...kids);

    const screen = h('main', { class: 'screen' },
      h('header', { class: 'top' }, h('h1', null, 'LanPlay host'), opts.onSwitchMode ? h('button', { type: 'button', class: 'link', onClick: () => opts.onSwitchMode?.() }, 'Change mode') : null),
      noteEl,
      card('h-name', 'This PC is called', h('div', { class: 'row' }, hostNameEl, copyNameBtn), h('p', { class: 'hint' }, 'The other computer finds this PC by itself. If it cannot, type this name or the IP address there.')),
      card('h-sun', 'Sunshine', sunshineEl, h('div', { class: 'row' }, setupBtn), h('p', { class: 'hint' }, 'Windows will ask for permission once. This installs Sunshine, opens the firewall for your home network and starts it at login. If Sunshine was already installed, its web page login is replaced by one only LanPlay knows.'), adminWarn, stepsEl),
      card('h-pair', 'Pairing', h('div', { class: 'row between' }, h('span', { class: 'label' }, 'Auto-approve devices on my network'), autoSwitch.el),
        h('p', { class: 'hint' }, 'On: any computer on your home network can pair without a code. Off: you approve each one here.'), agentLine,
        h('p', { class: 'hint' }, 'You can close this window: LanPlay keeps running in the background so the other computer can connect. To stop it completely, use File > Exit.'), pendingEl),
      card('h-dev', 'Paired devices', devicesEl),
      card('h-health', 'Health', h('div', { class: 'row' }, checkBtn, diagBtn), h('p', { class: 'hint' }, 'If something does not work, press Copy diagnostics and send the zip file.'), diagEl, checkEl));
    Dom.setChildren(root, [screen]);

    function chip(label: string, state: boolean | null): HTMLElement {
      const dot = state === null ? 'off' : state ? 'ok' : 'warn';
      const word = state === null ? 'unknown' : state ? 'yes' : 'no';
      return h('li', { class: 'chip' }, h('span', { class: 'dot ' + dot, 'aria-hidden': 'true' }), label + ': ' + word);
    }

    function stepRow(s: T.StepRecord): HTMLElement {
      return h('li', { class: 'step ' + s.status },
        h('span', { class: 'badge ' + s.status }, Model.statusWord(s.status)),
        h('span', { class: 'stitle' }, s.title),
        s.message ? h('span', { class: 'smsg' }, s.message) : null);
    }

    function render(): void {
      if (destroyed) return;
      noteEl.textContent = note;
      noteEl.className = 'status' + (noteIsError ? ' error-text' : '');
      hostNameEl.textContent = info?.hostName ?? '(unknown)';
      copyNameBtn.disabled = !info?.hostName;
      const sum = Model.sunshineSummary(status);
      // No "Administrator rights" chip: LanPlay should NOT be run as administrator (setup asks Windows once); a yellow
      // "no" there only invites people to do exactly that. Admin status is still recorded in self-check and diagnostics.
      Dom.setChildren(sunshineEl, [chip('Installed', sum.installed), chip('Running', sum.running)]);
      adminWarn.hidden = status?.isAdmin !== true;
      setupBtn.disabled = setupBusy;
      setupBtn.textContent = setupBusy ? 'Working...' : sum.installed ? 'Set up / Repair' : 'Install and set up';
      Dom.setChildren(stepsEl, (setupBusy || live.length > 0 ? live : []).map(stepRow));
      autoSwitch.set(agent?.autoApprove ?? true);
      agentLine.textContent = agent ? (agent.listening ? 'Pair agent is listening on port ' + agent.port + '.' : 'Pair agent is not running.' + (agent.lastError ? ' ' + agent.lastError : '')) : '';
      Dom.setChildren(pendingEl, (agent?.pending ?? []).map((p) =>
        h('li', { class: 'item' }, h('span', { class: 'iname' }, p.clientName, h('span', { class: 'sub' }, p.remoteAddress)),
          h('button', { type: 'button', class: 'btn primary', onClick: () => decide(p.requestId, true) }, 'Approve'),
          h('button', { type: 'button', class: 'btn', onClick: () => decide(p.requestId, false) }, 'Deny'))));
      Dom.setChildren(devicesEl, devices.length === 0 ? [h('li', { class: 'empty' }, 'No paired devices yet.')] : devices.map((d) => {
        const sure = confirmUuid === d.uuid;
        return h('li', { class: 'item' }, h('span', { class: 'iname' }, d.name, h('span', { class: 'sub' }, Model.deviceVia(d) + (d.lastAddress ? ', ' + d.lastAddress : ''))),
          h('button', { type: 'button', class: 'btn' + (sure ? ' danger' : ''), 'aria-label': (sure ? 'Confirm revoke ' : 'Revoke ') + d.name, onClick: () => revoke(d) }, sure ? 'Really revoke?' : 'Revoke'));
      }));
      checkBtn.disabled = checkBusy;
      checkBtn.textContent = checkBusy ? 'Checking...' : 'Run self-check';
      Dom.setChildren(checkEl, report ? [h('li', { class: 'step ' + (report.ok ? 'pass' : 'fail') }, h('span', { class: 'stitle' }, report.ok ? 'All checks passed' : 'Some checks failed')), ...report.steps.map(stepRow)] : []);
      diagBtn.disabled = diagBusy;
      diagBtn.textContent = diagBusy ? 'Collecting...' : 'Copy diagnostics';
      Dom.setChildren(diagEl, diagPath ? ['Saved: ' + diagPath + ' ', h('button', { type: 'button', class: 'link', onClick: () => void reveal() }, 'Show file')] : []);
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
      say('Setting up. Approve the Windows prompt if it appears.');
      try {
        status = await api.invoke('host:setup-run');
        live = status.steps;
        say(status.ok ? 'Setup finished. This PC is ready.' : 'Setup finished with problems. See the steps below, then press Copy diagnostics.', !status.ok);
      } catch (e) {
        say('Setup failed: ' + msg(e), true);
      } finally {
        setupBusy = false;
        render();
      }
    });
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
      if (a.pending.length > 0 || devices.length >= 0) void refreshDevices();
      render();
    }));

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
    void refreshDevices();

    return {
      destroy() {
        destroyed = true;
        if (confirmTimer) clearTimeout(confirmTimer);
        for (const u of unsubs) u();
        Dom.clear(root);
      },
    };
  }
}
