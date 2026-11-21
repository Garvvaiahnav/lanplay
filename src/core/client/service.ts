// ClientService (Mac, or a Windows PC in the client role): discovery, settings, pairing, streaming, self-check.
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_STREAM_SETTINGS, LANPLAY, MOONLIGHT } from '../../contracts.js';
import type {
  ClientService,
  ClientSystemInfo,
  HostInfo,
  MoonlightProcessHandle,
  MoonlightRunner,
  MoonlightRunnerOptions,
  PairProgress,
  PairResult,
  SelfCheckReport,
  ServiceDeps,
  StepRecord,
  StreamSettings,
  StreamState,
} from '../../contracts.js';
import { runRecorded, tail } from '../shared/exec.js';
import { isPrivateAddress } from '../shared/ipnet.js';
import { httpGet } from '../shared/netprobe.js';
import { timedStep } from '../shared/steprec.js';
import { defaultDiscoveryDeps, LanDiscovery, localIPv4Interfaces } from './discovery.js';
import type { DiscoveryDeps } from './discovery.js';
import { createMoonlightRunnerWith, moonlightTarget } from './moonlight.js';
import { MOONLIGHT_WIN, platformLabel, readBundleVersion, readMoonlightVersion } from './platform.js';
import { ClientPairingService } from './pairing.js';
import type { PairingDeps } from './pairing.js';
import { fetchServerInfo } from './serverinfo.js';
import { applyPreset, detectAppleChip, normalizeStreamSettings, resolveCodec } from './settings.js';

export const SETTINGS_KEY = 'client.streamSettings';
export const CLIENT_ID_KEY = 'client.id';
export const LAST_HOST_KEY = 'client.lastHost';
export const RECENT_REMOTE_KEY = 'client.recentRemote';
const RECENT_REMOTE_MAX = 5;
/** A remote stream that dies sooner than this probably connected over TCP but got no UDP video. */
export const REMOTE_STREAM_HINT_MS = 15_000;
export const UDP_HINT = 'The host answered, so TCP works. If there was no picture, UDP 47998-48000 is probably not forwarded.';

export interface ClientServiceExtras {
  /** Absolute Moonlight binary (first existing candidate) or null when none was found. */
  moonlightBinary: string | null;
  /** Tests: [fake-moonlight.mjs]; real: []. */
  prefixArgs?: readonly string[];
  moonlightEnv?: Readonly<Record<string, string>>;
  cpuModel?: string;
  discovery?: Partial<DiscoveryDeps>;
  pairing?: Partial<PairingDeps>;
  /** How long the stream may run before we call it "running" (catches instant failures). */
  streamStartupMs?: number;
  selfCheckDiscoveryMs?: number;
  /** Defaults to process.platform. 'win32' = Windows client (Moonlight.exe, no codesign, %TEMP% logs, taskkill). */
  platform?: NodeJS.Platform;
  /** Tests: clock for the 15 s remote-stream hint window. */
  now?: () => number;
}

export { readBundleVersion };

export function defaultClientName(): string {
  const raw = os.hostname().replace(/\.local$/i, '').replace(/[^\p{L}\p{N} ._-]/gu, '-');
  const s = raw.replace(/-+/g, '-').trim().slice(0, 64);
  return s || 'Mac';
}

export class MacClientService implements ClientService {
  readonly discovery: LanDiscovery;
  private readonly moonlight: MoonlightRunner;
  private readonly pairing: ClientPairingService;
  private readonly streams = new Map<string, MoonlightProcessHandle>();
  private readonly cpuModel: string;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly deps: ServiceDeps,
    private readonly x: ClientServiceExtras,
  ) {
    this.platform = x.platform ?? process.platform;
    this.cpuModel = x.cpuModel ?? os.cpus()[0]?.model ?? '';
    this.discovery = new LanDiscovery({ ...defaultDiscoveryDeps(deps.log.child('client')), onRemoteHost: (_h, typed) => this.rememberRemote(typed), ...(x.discovery ?? {}) });
    const mlOpts: MoonlightRunnerOptions = {
      binary: x.moonlightBinary ?? (this.platform === 'win32' ? MOONLIGHT_WIN.installedDefault : path.join('/Applications', MOONLIGHT.macBundleBinary)),
      prefixArgs: x.prefixArgs ?? [],
      runner: deps.runner,
      log: deps.log.child('client'),
    };
    if (x.moonlightEnv) mlOpts.env = x.moonlightEnv;
    this.moonlight = createMoonlightRunnerWith(mlOpts, { platform: this.platform });
    this.pairing = new ClientPairingService({
      moonlight: this.moonlight,
      log: deps.log.child('client'),
      clientName: defaultClientName,
      clientId: () => this.clientId(),
      clientAddresses: () => localIPv4Interfaces().map((i) => i.address),
      agentPort: LANPLAY.agentPort,
      ...(x.pairing ?? {}),
    });
  }

  private clientId(): string {
    let id = this.deps.settings.get<string | null>(CLIENT_ID_KEY, null);
    if (!id) {
      id = randomUUID();
      this.deps.settings.set(CLIENT_ID_KEY, id);
    }
    return id;
  }

  recentRemote(): string[] {
    const v = this.deps.settings.get<unknown>(RECENT_REMOTE_KEY, []);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_REMOTE_MAX) : [];
  }

  /** Newest first, no duplicates, last 5. The first time an address is typed, the Internet preset is selected (D12); later edits stay. */
  private rememberRemote(typed: string): void {
    const t = typed.trim();
    if (!t) return;
    const before = this.recentRemote();
    const known = before.some((x) => x.toLowerCase() === t.toLowerCase());
    this.deps.settings.set(RECENT_REMOTE_KEY, [t, ...before.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, RECENT_REMOTE_MAX));
    if (!known) this.setSettings(applyPreset('internet', this.getSettings()));
  }

  async systemInfo(): Promise<ClientSystemInfo> {
    const bin = this.x.moonlightBinary;
    const present = Boolean(bin && existsSync(bin));
    return {
      chip: detectAppleChip(this.cpuModel),
      moonlightPath: present ? bin : null,
      moonlightVersion: present && bin ? readMoonlightVersion(bin, this.platform) : null,
    };
  }

  getSettings(): StreamSettings {
    const raw = this.deps.settings.get<unknown>(SETTINGS_KEY, null);
    // Windows default: borderless (windowed fullscreen), so other windows (e.g. the exit menu) can still appear above the stream.
    // System keys are captured separately via --capture-system-keys (see buildStreamArgs).
    if (raw === null && this.platform === 'win32') return normalizeStreamSettings({ ...DEFAULT_STREAM_SETTINGS, displayMode: 'borderless' });
    try {
      return normalizeStreamSettings(raw ?? {});
    } catch {
      return normalizeStreamSettings({});
    }
  }

  setSettings(s: StreamSettings): StreamSettings {
    const n = normalizeStreamSettings(s);
    this.deps.settings.set(SETTINGS_KEY, n);
    return n;
  }

  private host(hostId: string): HostInfo {
    const h = this.discovery.get(hostId);
    if (!h) throw new Error('That PC is no longer in the list. Search again or add it by IP.');
    return h;
  }

  async pair(hostId: string, onProgress: (p: PairProgress) => void): Promise<PairResult> {
    const h = this.host(hostId);
    if (!this.x.moonlightBinary) {
      return { ok: false, hostId, code: 'moonlight-missing', message: this.platform === 'win32' ? `Moonlight is not bundled with this build and not installed in ${MOONLIGHT_WIN.installedDefault}.` : 'Moonlight is not bundled with this build and not in /Applications.', retryable: false, durationMs: 0 };
    }
    const r = await this.pairing.pair(h, onProgress);
    if (r.ok) {
      this.discovery.patch(hostId, { paired: true });
      this.deps.settings.set(LAST_HOST_KEY, { id: h.id, name: h.name, address: h.preferredAddress });
    }
    return r;
  }

  async startStream(hostId: string, settingsIn: StreamSettings, onState: (s: StreamState) => void): Promise<StreamState> {
    const h = this.host(hostId);
    const settings = this.setSettings(settingsIn);
    const chip = detectAppleChip(this.cpuModel);
    const codec = resolveCodec(settings.codec, chip, h.serverCodecModeSupport);
    const log = this.deps.log.child('client');
    if (this.streams.has(hostId)) return { hostId, state: 'running', message: 'Already streaming.' };
    let handle: MoonlightProcessHandle;
    try {
      handle = this.moonlight.startStream({ host: moonlightTarget(h), settings, resolvedCodec: codec });
    } catch (e) {
      return { hostId, state: 'failed', message: (e as Error).message };
    }
    this.deps.settings.set(LAST_HOST_KEY, { id: h.id, name: h.name, address: h.preferredAddress });
    log.log('info', 'stream', 'stream started', { hostId, codec, chip: chip.model, scms: h.serverCodecModeSupport ?? null, argv: handle.argv });
    this.streams.set(hostId, handle);
    onState({ hostId, state: 'starting' });
    const clock = this.x.now ?? Date.now;
    const startedAt = clock();
    const withHint = (msg: string): string => (h.remote && clock() - startedAt < REMOTE_STREAM_HINT_MS ? `${msg} ${UDP_HINT}` : msg);
    const startup = this.x.streamStartupMs ?? 1500;
    const early = await Promise.race([handle.exited, new Promise<null>((r) => setTimeout(() => r(null), startup))]);
    if (early) {
      this.streams.delete(hostId);
      const msg = early.spawnError ? `Moonlight could not start: ${early.spawnError}` : `Moonlight exited right away (code ${early.exitCode}). ${tail(early.stderr || early.stdout, 300).trim()}`;
      const st: StreamState = early.exitCode === 0 && !early.spawnError ? { hostId, state: 'ended', exitCode: 0 } : { hostId, state: 'failed', exitCode: early.exitCode, message: withHint(msg) };
      log.log(st.state === 'failed' ? 'warn' : 'info', 'stream', `stream ${st.state}`, { hostId, exitCode: early.exitCode, stderr: tail(early.stderr, 2000) });
      onState(st);
      return st;
    }
    void handle.exited.then((r) => {
      this.streams.delete(hostId);
      const st: StreamState = { hostId, state: 'ended', exitCode: r.exitCode };
      if (r.exitCode !== 0 && r.exitCode !== null) st.message = withHint(`Moonlight stopped with code ${r.exitCode}. ${tail(r.stderr, 300).trim()}`);
      log.log('info', 'stream', 'stream ended', { hostId, exitCode: r.exitCode, signal: r.signal, stderr: tail(r.stderr, 2000) });
      onState(st);
    });
    const running: StreamState = { hostId, state: 'running' };
    onState(running);
    return running;
  }

  async stopStream(hostId: string): Promise<void> {
    const h = this.streams.get(hostId);
    if (h) await h.terminate(3000);
  }

  async selfCheck(): Promise<SelfCheckReport> {
    const t0 = Date.now();
    const steps: StepRecord[] = [];
    const log = this.deps.log;
    const push = (r: StepRecord) => {
      steps.push(r);
      log.step({ ...r, stepId: `selfcheck:${r.stepId}` });
    };

    push(
      await timedStep('chip', this.platform === 'win32' ? 'Processor' : 'Apple chip', async () => {
        const c = detectAppleChip(this.cpuModel);
        if (this.platform === 'win32') return { status: 'pass', message: `${c.model || 'unknown CPU'}: codec Auto uses HEVC when the PC offers it, else H.264.`, data: { ...c } };
        return { status: c.generation === null ? 'warn' : 'pass', message: `${c.model || 'unknown CPU'}: codec Auto uses ${c.av1HardwareDecode ? 'AV1 when the PC offers it, else HEVC' : 'HEVC (AV1 needs M3 or newer)'}.`, data: { ...c } };
      }),
    );

    push(
      await timedStep('moonlight', 'Bundled Moonlight', async (s) => {
        const bin = this.x.moonlightBinary;
        s.data.binary = bin;
        if (!bin || !existsSync(bin)) return { status: 'fail', message: `Moonlight not found (looked for ${bin ?? (this.platform === 'win32' ? `bundled Moonlight.exe and ${MOONLIGHT_WIN.installedDefault}` : 'bundled app and /Applications')}).` };
        try {
          accessSync(bin, constants.X_OK);
        } catch {
          return { status: 'fail', message: `${bin} is not executable.` };
        }
        const version = readMoonlightVersion(bin, this.platform);
        s.data.version = version;
        // Read-only signature check (the bundled app must keep its notarized signature).
        const app = path.resolve(path.dirname(bin), '..', '..');
        if (this.platform === 'darwin' && app.endsWith('.app') && existsSync('/usr/bin/codesign')) {
          const r = await runRecorded(this.deps.runner, { file: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', app], timeoutMs: 60_000 }, log.redactor, s.commands);
          if (r.exitCode !== 0) return { status: 'warn', message: `Moonlight ${version ?? '?'} found, but its code signature does not verify (macOS may block it): ${tail(r.stderr, 300).trim()}` };
        }
        return { status: version === MOONLIGHT.version || version === null ? 'pass' : 'warn', message: `Moonlight ${version ?? '(version unknown)'} at ${bin}.` };
      }),
    );

    push(
      await timedStep('network', 'Local network', async (s) => {
        const ifs = localIPv4Interfaces();
        s.data.interfaces = ifs;
        return ifs.length ? { status: 'pass', message: `On the LAN as ${ifs.map((i) => i.address).join(', ')}.` } : { status: 'fail', message: 'No private IPv4 address: is Wi-Fi/Ethernet connected?' };
      }),
    );

    push(
      await timedStep('log-dir', 'Log folder', async (s) => {
        s.data.logDir = this.deps.paths.logDir;
        try {
          mkdirSync(this.deps.paths.logDir, { recursive: true });
          accessSync(this.deps.paths.logDir, constants.W_OK);
          return { status: 'pass', message: `Writing logs to ${this.deps.log.currentFile()}.` };
        } catch (e) {
          return { status: 'fail', message: `Cannot write logs to ${this.deps.paths.logDir}: ${(e as Error).message}` };
        }
      }),
    );

    // Discovery (independent of the UI's discovery session).
    let found: HostInfo[] = [];
    push(
      await timedStep('discovery', 'Find PCs on the network', async (s) => {
        const d = new LanDiscovery({ ...defaultDiscoveryDeps(log.child('selfcheck')), ...(this.x.discovery ?? {}) });
        const wait = this.x.selfCheckDiscoveryMs ?? 5000;
        await new Promise<void>((resolve) => {
          d.start(() => undefined);
          setTimeout(resolve, wait);
        });
        d.stop();
        found = d.list();
        s.data.hosts = found.map((h) => ({ name: h.name, addresses: h.addresses, sources: h.sources, agentReachable: h.agentReachable ?? null }));
        if (!found.length) return { status: 'warn', message: `No PC answered within ${wait / 1000} s (mDNS, LanPlay UDP, port scan). ${this.platform === 'win32' ? 'Check that this PC is on the same network and the network is set to Private in Windows Settings.' : 'macOS may be blocking local network access: System Settings > Privacy & Security > Local Network > LanPlay.'}` };
        return { status: 'pass', message: `Found ${found.map((h) => `${h.name} (${h.preferredAddress} via ${h.sources.join('+')})`).join(', ')}.` };
      }),
    );

    const last = this.deps.settings.get<{ id: string; name: string; address: string } | null>(LAST_HOST_KEY, null);
    const targets = new Map<string, { name: string; address: string }>();
    for (const h of found) targets.set(h.preferredAddress, { name: h.name, address: h.preferredAddress });
    if (last && isPrivateAddress(last.address) && !targets.has(last.address)) targets.set(last.address, { name: last.name, address: last.address });
    for (const t of targets.values()) {
      push(
        await timedStep(`host:${t.address}`, `PC ${t.name} (${t.address})`, async (s) => {
          const problems: string[] = [];
          try {
            const info = await fetchServerInfo(t.address);
            s.data.serverinfo = info;
          } catch (e) {
            problems.push(`Sunshine /serverinfo: ${(e as Error).message}`);
          }
          try {
            const r = await httpGet(t.address, LANPLAY.agentPort, '/v1/info', 2000);
            s.data.agent = { status: r.status, body: r.body.slice(0, 500) };
            if (r.status !== 200) problems.push(`LanPlay agent answered HTTP ${r.status}`);
            else if (!(JSON.parse(r.body) as { ready?: boolean }).ready) problems.push('LanPlay agent is up but Sunshine is not ready on the PC (run "Set up this PC" there)');
          } catch (e) {
            problems.push(`LanPlay agent on port ${LANPLAY.agentPort}: ${(e as Error).message}`);
          }
          if (this.x.moonlightBinary) {
            const p = await this.moonlight.isPaired(t.address, 20_000);
            s.data.paired = p.paired;
            s.data.listExit = p.result.exitCode;
            s.data.listStderr = tail(p.result.stderr, 500);
          }
          if (problems.length) return { status: 'fail', message: problems.join('; ') + '.' };
          return { status: 'pass', message: `Sunshine and the LanPlay agent answer${s.data.paired === true ? `; this ${platformLabel(this.platform)} is paired` : s.data.paired === false ? '; not paired yet (Stream will pair)' : ''}.` };
        }),
      );
    }
    return { role: 'client', startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, ok: steps.every((s) => s.status !== 'fail'), steps };
  }
}

export function createMacClientService(deps: ServiceDeps, x: ClientServiceExtras): MacClientService {
  return new MacClientService(deps, x);
}
