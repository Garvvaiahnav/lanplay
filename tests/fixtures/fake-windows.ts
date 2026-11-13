// A fake Windows PC for host-step tests: answers the PowerShell wrappers with JSON shaped exactly like the
// scripts in scripts/windows/*.ps1 print, and simulates msiexec / sc.exe / cmd.exe /c <bat> / sunshine.exe --creds.
import path from 'node:path';
import type { ExecRequest, ExecResult, ProcessRunner, SunshineFactsPs } from '../../src/contracts.js';
import type { FirewallRuleFact } from '../../src/core/host/steps.js';

const w = path.win32;

export interface FakeMachineState {
  isAdmin: boolean;
  /** Install root once installed. */
  root: string | null;
  service: SunshineFactsPs['service'];
  uninstallEntries: SunshineFactsPs['uninstallEntries'];
  firewall: FirewallRuleFact[];
  files: Map<string, string>;
  credsSet: string | null;
  /** What the silent MSI does (Return="ignore": partial effects are possible). */
  msiExit: number;
  msiCreatesService: boolean;
  msiCreatesFirewall: boolean;
  installRoot: string;
  scStartFails?: boolean;
  env: SunshineFactsPs['env'];
}

export function freshMachine(over: Partial<FakeMachineState> = {}): FakeMachineState {
  return {
    isAdmin: true,
    root: null,
    service: null,
    uninstallEntries: [],
    firewall: [],
    files: new Map(),
    credsSet: null,
    msiExit: 0,
    msiCreatesService: true,
    msiCreatesFirewall: false,
    installRoot: 'C:\\Program Files\\Sunshine',
    env: { ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' },
    ...over,
  };
}

export function installSunshineFiles(m: FakeMachineState, root: string, certPem: string): void {
  m.root = root;
  m.files.set(w.join(root, 'sunshine.exe'), 'MZ');
  m.files.set(w.join(root, 'tools', 'sunshinesvc.exe'), 'MZ');
  for (const b of ['install-service.bat', 'autostart-service.bat', 'add-firewall-rule.bat']) m.files.set(w.join(root, 'scripts', b), '@echo off');
  m.files.set(w.join(root, 'config', 'credentials', 'cacert.pem'), certPem);
  m.uninstallEntries = [{ displayName: 'Sunshine', displayVersion: '2026.914.233613', installLocation: root, uninstallString: 'MsiExec.exe /X{6A1C9E33-0000-0000-0000-000000000000}' }];
}

const ok = (stdout: string, exitCode = 0): ExecResult => ({ exitCode, signal: null, stdout, stderr: '', durationMs: 5, timedOut: false });

export class FakeWindowsRunner implements ProcessRunner {
  readonly calls: ExecRequest[] = [];
  /** Extra hook for invoke-elevated (tests wire the elevated child here). */
  onInvokeElevated?: (file: string, argsB64: string) => Promise<ExecResult>;
  /** Pretend this process is (not) elevated regardless of the machine default. */
  adminOverride?: boolean;

  constructor(
    readonly m: FakeMachineState,
    private readonly certPem: string,
  ) {}

  private param(args: readonly string[], name: string): string | undefined {
    // Script parameters start after "-File <script>" (index 7).
    const i = args.indexOf(`-${name}`, 7);
    return i >= 0 ? args[i + 1] : undefined;
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    this.calls.push(req);
    const base = w.basename(req.file).toLowerCase();
    if (base === 'powershell.exe') return this.ps(req);
    if (base === 'msiexec.exe') return this.msi(req);
    if (base === 'sc.exe') return this.sc(req);
    if (base === 'cmd.exe') return this.bat(req);
    if (base === 'sunshine.exe') {
      if (req.args[0] === '--creds' && req.args.length === 3) {
        this.m.credsSet = req.args[2]!;
        return ok('Credentials saved\n');
      }
      return ok('', 1);
    }
    return { exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, spawnError: `ENOENT: ${req.file}` };
  }

  private async ps(req: ExecRequest): Promise<ExecResult> {
    const a = req.args;
    if (a.slice(0, 6).join(' ') !== '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File') return ok('{"error":"bad argv"}', 2);
    const script = w.basename(a[6]!).replace(/\.ps1$/, '');
    switch (script) {
      case 'test-admin':
        return ok(JSON.stringify({ isAdmin: this.adminOverride ?? this.m.isAdmin, userName: 'PC\\Jörg' }));
      case 'get-sunshine-facts':
        return ok(JSON.stringify({ service: this.m.service, uninstallEntries: this.m.uninstallEntries, env: this.m.env }));
      case 'get-firewall-rules': {
        const names = (this.param(a, 'Names') ?? '').split(',');
        const program = this.param(a, 'Program');
        const rules: FirewallRuleFact[] = this.m.firewall.filter((r) => names.includes(r.name)).map((r) => ({ ...r, matchedBy: 'name' }));
        if (program) rules.push(...this.m.firewall.filter((r) => r.program.toLowerCase() === program.toLowerCase()).map((r) => ({ ...r, matchedBy: 'program' })));
        return ok(JSON.stringify({ rules }));
      }
      case 'set-agent-firewall-rule': {
        if (!this.m.isAdmin) return ok('{"error":"Access is denied."}', 1);
        const port = this.param(a, 'Port')!;
        const name = this.param(a, 'Name')!;
        for (const proto of ['TCP', 'UDP']) {
          const id = `LanPlay-PairAgent-${proto}`;
          this.m.firewall = this.m.firewall.filter((r) => r.id !== id);
          this.m.firewall.push({ id, name, enabled: true, direction: 'Inbound', action: 'Allow', profile: 'Any', protocol: proto, localPort: port, remoteAddress: 'LocalSubnet', program: 'Any' });
        }
        return ok(JSON.stringify({ rules: [{ id: 'LanPlay-PairAgent-TCP', action: 'created' }] }));
      }
      case 'get-listeners':
        return ok(JSON.stringify({ listeners: [{ port: 47989, protocol: 'tcp', address: '0.0.0.0', pid: 1234, process: 'sunshine' }] }));
      case 'get-system-info':
        return ok(JSON.stringify({ os: 'Microsoft Windows 11 Pro', version: '10.0.26100', build: '26100', gpus: [{ name: 'NVIDIA GeForce RTX 4070', driverVersion: '32.0.15.6094' }], isAdmin: this.m.isAdmin, userName: 'PC\\Jörg', psVersion: '5.1.26100.1' }));
      case 'invoke-elevated': {
        if (!this.onInvokeElevated) return ok('{"error":"no hook","exitCode":null,"cancelled":false}', 1);
        return this.onInvokeElevated(this.param(a, 'FilePath')!, this.param(a, 'ArgumentListB64')!);
      }
      default:
        return ok(`{"error":"unknown script ${script}"}`, 2);
    }
  }

  private async msi(req: ExecRequest): Promise<ExecResult> {
    if (req.args[0] !== '/i' || req.args[2] !== '/qn' || req.args[3] !== '/norestart' || req.args[4] !== '/l*v') return ok('', 1639);
    if (this.m.msiExit === 0 || this.m.msiExit === 3010) {
      installSunshineFiles(this.m, this.m.installRoot, this.certPem);
      if (this.m.msiCreatesService) this.m.service = { name: 'SunshineService', pathName: `"${w.join(this.m.installRoot, 'tools', 'sunshinesvc.exe')}"`, startMode: 'Manual', state: 'Stopped' };
      if (this.m.msiCreatesFirewall) this.addSunshineRules();
    }
    return ok('', this.m.msiExit);
  }

  private addSunshineRules() {
    for (const proto of ['TCP', 'UDP']) {
      this.m.firewall.push({ id: `{${proto}}`, name: 'Sunshine', enabled: true, direction: 'Inbound', action: 'Allow', profile: 'Any', protocol: proto, localPort: 'Any', remoteAddress: 'Any', program: w.join(this.m.root ?? '', 'sunshine.exe') });
    }
  }

  private async sc(req: ExecRequest): Promise<ExecResult> {
    const [verb, name, ...rest] = req.args;
    if (name !== 'SunshineService') return ok('', 1060);
    const svc = this.m.service;
    if (!svc) return ok('', 1060);
    if (verb === 'config' && rest[0] === 'start=' && rest[1] === 'auto') {
      svc.startMode = 'Auto';
      return ok('[SC] ChangeServiceConfig SUCCESS');
    }
    if (verb === 'start') {
      if (this.m.scStartFails) return ok('', 1053);
      if (svc.state === 'Running') return ok('', 1056);
      svc.state = 'Running';
      return ok('');
    }
    if (verb === 'stop') {
      if (svc.state !== 'Running') return ok('', 1062);
      svc.state = 'Stopped';
      return ok('');
    }
    return ok('', 87);
  }

  private async bat(req: ExecRequest): Promise<ExecResult> {
    if (req.args[0] !== '/d' || req.args[1] !== '/c') return ok('', 1);
    const bat = w.basename(req.args[2]!).toLowerCase();
    if (bat === 'install-service.bat') {
      this.m.service = { name: 'SunshineService', pathName: `"${w.join(this.m.root!, 'tools', 'sunshinesvc.exe')}"`, startMode: 'Manual', state: 'Running' };
      return ok('');
    }
    if (bat === 'autostart-service.bat') {
      if (this.m.service) this.m.service.startMode = 'Auto';
      return ok('');
    }
    if (bat === 'add-firewall-rule.bat') {
      this.addSunshineRules();
      return ok('Ok.');
    }
    return ok('', 1);
  }
}
