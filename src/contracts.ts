/**
 * LanPlay contracts: the ONE file both builders code against.
 *
 *   Builder A (client + app shell): src/client/**, src/main/**, src/preload/**, src/renderer/**,
 *                                   src/shared/logger.ts, src/shared/diagnostics.ts, macOS packaging.
 *   Builder B (host):               src/host/**, src/host/ps/*.ps1, src/shared/ipnet.ts,
 *                                   scripts/build-windows.ps1, scripts/check-ps.mjs, Windows packaging.
 *
 * Rules:
 *  - Do not change a type here without updating SPEC.md "Contract changes" and both sides' tests.
 *  - Every doc-derived constant carries the URL it came from. Sources are pinned to the exact tags we ship:
 *      Sunshine  v2026.914.233613 (commit 63d35f702ee9e362e43263742981836ec0710384)
 *      moonlight-qt v6.2.0        (commit de2467e433821664cdd2224aad8c89a625be1ad9)
 *  - This file has NO runtime imports (pure types + frozen constants) so it can be imported from
 *    main, preload, renderer (bundled), tests and the fake CLIs alike.
 */

/* ------------------------------------------------------------------------------------------------
 * 0. Source URL bases (used in comments only)
 * ---------------------------------------------------------------------------------------------- */
// SUN = https://github.com/LizardByte/Sunshine/blob/v2026.914.233613
// ML  = https://github.com/moonlight-stream/moonlight-qt/blob/v6.2.0
// MLC = https://github.com/moonlight-stream/moonlight-common-c/blob/f900dd4767759c7b9d0e93bcea666b55c69ea62f

/* ------------------------------------------------------------------------------------------------
 * 1. Doc-derived constants: Sunshine
 * ---------------------------------------------------------------------------------------------- */
export const SUNSHINE = Object.freeze({
  /** Pinned release. https://github.com/LizardByte/Sunshine/releases/tag/v2026.914.233613 */
  version: '2026.914.233613',

  /** Base port. "port ... Default 47989" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/configuration.md#L1595 */
  basePort: 47989,
  /** nvhttp HTTPS = base - 5. "constexpr auto PORT_HTTPS = -5;" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/nvhttp.h#L52 */
  httpsPort: 47984,
  /** nvhttp HTTP = base + 0 (GET /serverinfo works unpaired). https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/nvhttp.h#L47 */
  httpPort: 47989,
  /** Web UI / REST = base + 1. "constexpr auto PORT_HTTPS = 1;" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/confighttp.h#L29 */
  webUiPort: 47990,
  /** RTSP = base + 21. "RTSP_SETUP_PORT = 21" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/rtsp.h#L15 */
  rtspPort: 48010,
  /** UDP video/control/audio = base + 9/10/11. https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/stream.h#L19-L21 */
  udpPorts: [47998, 47999, 48000] as const,

  /** mDNS. "SERVICE_NAME = "Sunshine"; SERVICE_TYPE = "_nvstream._tcp";" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/platform/common.h#L1286-L1287 */
  mdnsServiceType: '_nvstream._tcp',
  mdnsInstanceName: 'Sunshine',

  /** "set SERVICE_NAME=SunshineService" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src_assets/windows/misc/service/install-service.bat#L7 */
  windowsServiceName: 'SunshineService',
  /** Service binary = <root>\tools\sunshinesvc.exe ("set "SERVICE_BIN=%ROOT_DIR%\tools\sunshinesvc.exe"") same file #L8 */
  serviceBinaryRelative: 'tools\\sunshinesvc.exe',
  /** "set RULE_NAME=Sunshine" (TCP + UDP, program=<root>\sunshine.exe) https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src_assets/windows/misc/firewall/add-firewall-rule.bat#L6 */
  firewallRuleName: 'Sunshine',
  /** Default install dir name under %ProgramFiles%: CPACK_PACKAGE_INSTALL_DIRECTORY "${CPACK_PACKAGE_NAME}" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/cmake/packaging/windows.cmake#L63 */
  defaultInstallDirName: 'Sunshine',
  /**
   * Config dir = folder of sunshine.exe + "config":
   * "return std::filesystem::path {sunshine_path}.remove_filename() / L"config"sv;"
   * https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/platform/windows/misc.cpp#L147-L150
   * Docs: "Windows | %ProgramFiles%\Sunshine\config" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/configuration.md
   */
  configDirRelative: 'config',
  /** "appdata() + "/sunshine.conf"" and "+ "/sunshine.log"" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/config.cpp#L883-L888 */
  configFileName: 'sunshine.conf',
  logFileName: 'sunshine.log',
  /** Web UI + nvhttp TLS cert: "CERTIFICATE_FILE = CA_DIR + "/cacert.pem"" (CA_DIR = "credentials") https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/config.cpp#L58-L60 ; web UI uses it: "https_server_t server {config::nvhttp.cert, config::nvhttp.pkey};" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/confighttp.cpp#L2320 */
  certRelativeToConfigDir: 'credentials\\cacert.pem',
  /** credentials_file default "sunshine_state.json" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/configuration.md#L1893 */
  stateFileName: 'sunshine_state.json',

  /** "--creds username password | set user credentials for the Web manager" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/logging.cpp#L272 (handler: src/entry_handler.cpp#L42-L47) */
  credsFlag: '--creds',

  /** Silent MSI: custom action CA_SunshineInstallSilent runs "sunshine-setup.ps1 -Action install -Silent" when "UILevel &lt;= 3"; Return="ignore" (failures are swallowed -> we must verify every effect ourselves). https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/cmake/packaging/wix_resources/sunshine-installer.wxs#L55-L67 */
  msiAsset: 'Sunshine-Windows-AMD64-installer.msi',
  /** Installer log dir: "%TEMP%/Sunshine/logs/install/" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/getting_started.md */
  installerLogDirRelativeToTemp: 'Sunshine\\logs\\install',

  /** Pairing limits. https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/nvhttp.h#L57-L72 */
  maxPendingPairings: 32,
  pairingIdHexLength: 32,
  maxClientNameBytes: 128,
  pairingSessionTimeoutMs: 5 * 60_000,
  /** "pin.size() == 4 && all digits" https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/nvhttp.cpp#L625-L629 */
  pinLength: 4,
  /** POST /api/pin "remains open for up to the configured ping_timeout"; ping_timeout example 10000 ms https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/configuration.md#L1783 */
  pingTimeoutDefaultMs: 10_000,

  /** Default app names in apps.json (Windows). https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src_assets/windows/assets/apps.json */
  defaultAppName: 'Desktop',
} as const);

/**
 * sunshine.conf keys LanPlay writes (merge, never clobber unknown keys). Format "key = value".
 * Sources: https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/configuration.md
 *  - origin_web_ui_allowed (#L1623): choices pc | lan | wan; "lan: Only LAN devices may access the web ui"
 *  - upnp (#L1499): default disabled. We pin it to disabled (LAN only, no port forwarding).
 *  - hevc_mode (#L2094): "0 advertise support for HEVC based on encoder capabilities (recommended)"
 *  - av1_mode (#L2136): same 0..3 scheme as hevc_mode
 *  - encoder (#L2239): "Default: Sunshine will use the first encoder that is available." -> we do NOT write it (= auto)
 */
export const SUNSHINE_MANAGED_CONFIG: Readonly<Record<string, string>> = Object.freeze({
  origin_web_ui_allowed: 'lan',
  upnp: 'disabled',
  hevc_mode: '0',
  av1_mode: '0',
});

/**
 * Sunshine REST endpoints we call (all on https://127.0.0.1:47990, Basic auth, JSON).
 * Route table: https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/confighttp.cpp#L2357-L2382
 * Auth: Basic "username:password"; caller must pass origin_web_ui_allowed (confighttp.cpp#L595-L635).
 * CSRF: "Requests with no Origin or Referer header ... are automatically allowed without a CSRF token"
 *       https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/api.md -> NEVER send Origin/Referer.
 * POST/DELETE bodies need "Content-Type: application/json" (check_content_type, confighttp.cpp#L684).
 * If no admin user exists yet, authenticate() redirects to /welcome (HTTP 307) instead of 401.
 */
export const SUNSHINE_API = Object.freeze({
  /** GET -> {"pairings":[{"id","name","address"}]}  (confighttp.cpp#L1741-L1763) */
  pendingPairings: { method: 'GET', path: '/api/pin' },
  /** POST {"pairing_id":32hex,"pin":"dddd","name":1..128 bytes} -> {"status":bool} (confighttp.cpp#L1810-L1869) */
  submitPin: { method: 'POST', path: '/api/pin' },
  /** DELETE {"pairing_id"} -> {"status":bool} (confighttp.cpp#L1765-L1808) */
  cancelPairing: { method: 'DELETE', path: '/api/pin' },
  /** GET -> {"named_certs":[{"name","uuid","enabled"}],"status":true} (confighttp.cpp#L1255-L1275; nvhttp.cpp#L1276-L1287) */
  listClients: { method: 'GET', path: '/api/clients/list' },
  /** POST {"uuid"} -> {"status":bool} (confighttp.cpp#L1332-L1380) */
  unpairClient: { method: 'POST', path: '/api/clients/unpair' },
  /** GET -> {"status":true,"platform","version",...config keys} (confighttp.cpp#L1409-L1435) */
  getConfig: { method: 'GET', path: '/api/config' },
  /** GET -> plain text log (used only for diagnostics) */
  getLogs: { method: 'GET', path: '/api/logs' },
} as const);

/* ------------------------------------------------------------------------------------------------
 * 2. Doc-derived constants: moonlight-qt
 * ---------------------------------------------------------------------------------------------- */
export const MOONLIGHT = Object.freeze({
  /** https://github.com/moonlight-stream/moonlight-qt/releases/tag/v6.2.0 */
  version: '6.2.0',
  /** Verified by mounting the DMG: Moonlight.app/Contents/MacOS/Moonlight (universal x86_64+arm64). */
  macBundleBinary: 'Moonlight.app/Contents/MacOS/Moonlight',
  /** Observed: "Redirecting log output to /tmp/Moonlight-<epoch>.log" (app/main.cpp#L460-L503 prunes to 10). */
  macLogGlobDir: '/tmp',
  macLogPrefix: 'Moonlight-',
  /**
   * pair: "parser.addValueOption("pin", "4 digit pairing PIN");" -> `pair <host> --pin dddd`
   * https://github.com/moonlight-stream/moonlight-qt/blob/v6.2.0/app/cli/commandlineparser.cpp#L260-L283
   * The PIN is NOT printed to stdout: it is shown in a Qt window ("Please enter '%1' on %2.",
   * app/gui/CliPair.qml#L11-L13). LanPlay therefore GENERATES the PIN and passes --pin.
   * On success the window shows "Pairing completed successfully" and only quits when the dialog closes
   * (CliPair.qml pairCompleteDialog.onClosed -> Qt.quit()). Host state is persisted by a delayed flush thread
   * (app/backend/computermanager.cpp#L248-L323), so do not SIGKILL right after success: see PAIR_TIMING.
   */
  pairPinFlag: '--pin',
  /** list: exit 0 = paired + apps printed; exit -1 (255) = "has not been paired" or connect failure; 1 = error. app/cli/listapps.cpp#L77-L112 */
  listExitOk: 0,
  /** stream options (moonlight-qt/app/cli/commandlineparser.cpp#L338-L373, verified with `Moonlight stream --help`). */
  streamFlags: {
    res1080: '--1080',
    res1440: '--1440',
    res4k: '--4K',
    fps: '--fps', // int 10..480 (commandlineparser.cpp: inRange(fps, 10, 480))
    bitrateKbps: '--bitrate', // "Specify bitrate in Kbps"; inRange(bitrateKbps, 500, 500000)
    videoCodec: '--video-codec', // auto | H.264 | HEVC | AV1 (m_VideoCodecMap, #L308-L313; case-sensitive keys)
    audioConfig: '--audio-config', // stereo | 5.1-surround | 7.1-surround (#L303-L307)
    displayMode: '--display-mode', // fullscreen | windowed | borderless (#L298-L302)
    vsync: '--vsync',
    noVsync: '--no-vsync',
    framePacing: '--frame-pacing',
    noFramePacing: '--no-frame-pacing',
    quitAfter: '--quit-after',
    noQuitAfter: '--no-quit-after',
    gameOptimization: '--game-optimization',
    noGameOptimization: '--no-game-optimization',
    performanceOverlay: '--performance-overlay',
    noPerformanceOverlay: '--no-performance-overlay',
    hdr: '--hdr',
    noHdr: '--no-hdr',
    videoDecoder: '--video-decoder', // auto | software | hardware
  },
  fpsRange: [10, 480] as const,
  bitrateKbpsRange: [500, 500_000] as const,
} as const);

/**
 * ServerCodecModeSupport bits returned by GET http://<host>:47989/serverinfo (XML root.ServerCodecModeSupport,
 * Sunshine nvhttp.cpp#L1168-L1258). Values: https://github.com/moonlight-stream/moonlight-common-c/blob/f900dd4767759c7b9d0e93bcea666b55c69ea62f/src/Limelight.h#L506-L520
 */
export const SCM = Object.freeze({
  H264: 0x00000001,
  HEVC: 0x00000100,
  HEVC_MAIN10: 0x00000200,
  AV1_MAIN8: 0x00010000,
  AV1_MAIN10: 0x00020000,
  MASK_H264: 0x00000001 | 0x00040000,
  MASK_HEVC: 0x00000100 | 0x00000200 | 0x00080000 | 0x00100000,
  MASK_AV1: 0x00010000 | 0x00020000 | 0x00200000 | 0x00400000,
} as const);

/* ------------------------------------------------------------------------------------------------
 * 3. LanPlay's own constants
 * ---------------------------------------------------------------------------------------------- */
export const LANPLAY = Object.freeze({
  appId: 'dev.lanplay.app',
  productName: 'LanPlay',
  /** Pair agent: TCP (HTTP API) and UDP (discovery reply) on the same port. Outside all Sunshine ports above. */
  agentPort: 47920,
  agentApiPrefix: '/v1',
  /** UDP discovery probe payload (ASCII). Agent answers with AgentDiscoveryReply JSON (unicast). */
  agentDiscoveryMagic: 'LANPLAY-DISCOVER-1',
  /** Rate limits for the pair agent. */
  agentRateLimit: { perIpPerMinute: 6, globalPerMinute: 30, maxBodyBytes: 4096 },
  /** How long the agent waits for Moonlight's pairing to show up in GET /api/pin. */
  agentPendingPollMs: 500,
  agentPendingWaitMs: 20_000,
  /** How long a pairing request may wait for manual approval when auto-approve is OFF. */
  manualApprovalTimeoutMs: 120_000,
  /** Sunshine admin user name LanPlay creates (password: 32 random bytes, base64url). */
  sunshineAdminUser: 'lanplay',
  /** Firewall rule display name for the agent (TCP+UDP 47920, remoteip=LocalSubnet). */
  agentFirewallRuleName: 'LanPlay Pair Agent',
  /** Log file name pattern; <date> = YYYY-MM-DD (local time). Elevated helper writes "lanplay-<date>.elevated.log". */
  logFilePattern: 'lanplay-<date>.log',
  elevatedLogFilePattern: 'lanplay-<date>.elevated.log',
  /** Keep this many bytes from the end of each log in diagnostics. */
  diagnosticsTailBytes: 256 * 1024,
  /** Ports checked for "listening" in diagnostics/self-check. */
  listenPortsToCheck: [47984, 47989, 47990, 48010, 47920] as const,
} as const);

/** Pairing timing on the client (see MOONLIGHT.pairPinFlag notes). */
export const PAIR_TIMING = Object.freeze({
  /** Give `Moonlight pair` this long to reach the host and register a pending pairing. */
  moonlightSeekMs: 10_000, // pair.cpp "#define COMPUTER_SEEK_TIMEOUT 10000"
  /** After the agent reports success, wait this long for Moonlight to flush its settings before asking it to quit. */
  postSuccessFlushMs: 3_000,
  /** Then send SIGTERM; after this grace, SIGKILL. */
  terminateGraceMs: 3_000,
  /** Overall budget for one pairing attempt. */
  overallTimeoutMs: 60_000,
} as const);

/* ------------------------------------------------------------------------------------------------
 * 4. Domain types: client side
 * ---------------------------------------------------------------------------------------------- */
export type Role = 'client' | 'host';
export type DiscoverySource = 'mdns' | 'agent-udp' | 'port-probe' | 'manual';

export interface HostInfo {
  /** Stable id: Sunshine serverinfo `uniqueid` when known, else `addr:<ip>`. */
  id: string;
  /** Display name (serverinfo `hostname` or mDNS instance name or the IP). */
  name: string;
  /** IPv4 first, then IPv6; never hostnames. */
  addresses: string[];
  /** Address the user/agent last succeeded with; used for moonlight `<host>` argument. */
  preferredAddress: string;
  sources: DiscoverySource[];
  /** Sunshine HTTP port (serverinfo). */
  httpPort: number;
  /** Pair agent reachable on LANPLAY.agentPort? undefined = not probed yet. */
  agentReachable?: boolean;
  /** Raw ServerCodecModeSupport bitmask from serverinfo, if fetched. */
  serverCodecModeSupport?: number;
  /** Paired according to `Moonlight list` (exit 0). undefined = unknown. */
  paired?: boolean;
  /** ISO timestamp. */
  lastSeen: string;
}

export type ResolutionId = '1080p' | '1440p' | '4k';
export type FpsOption = 60 | 120;
export type CodecChoice = 'auto' | 'hevc' | 'av1' | 'h264';
export type ResolvedCodec = Exclude<CodecChoice, 'auto'>;
export type AudioConfig = 'stereo'; // v1 scope: stereo only
export type DisplayMode = 'fullscreen' | 'borderless' | 'windowed';
export type PresetId = 'lowest-latency' | 'balanced' | 'best-picture' | 'custom';

export const BITRATE_LIMITS_MBPS = Object.freeze({ min: 20, max: 150, advancedMax: 500, step: 5 } as const);

export interface StreamSettings {
  presetId: PresetId;
  resolution: ResolutionId;
  fps: FpsOption;
  /** Integer Mbps. 20..150, or up to 500 when `advancedBitrate` is true. Passed to moonlight as Kbps (x1000). */
  bitrateMbps: number;
  advancedBitrate: boolean;
  codec: CodecChoice;
  audio: AudioConfig;
  displayMode: DisplayMode;
  vsync: boolean;
  framePacing: boolean;
  /** Sunshine app to launch; default SUNSHINE.defaultAppName ("Desktop"). */
  appName: string;
}

export interface Preset {
  id: Exclude<PresetId, 'custom'>;
  label: string;
  description: string;
  settings: Omit<StreamSettings, 'presetId' | 'appName' | 'advancedBitrate' | 'audio'>;
}

/** Canonical presets. UI shows these three; any manual change flips presetId to 'custom'. */
export const PRESETS: readonly Preset[] = Object.freeze([
  {
    id: 'lowest-latency',
    label: 'Lowest latency',
    description: '1080p at 120 fps, no V-Sync, no frame pacing.',
    settings: { resolution: '1080p', fps: 120, bitrateMbps: 50, codec: 'auto', displayMode: 'fullscreen', vsync: false, framePacing: false },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: '1440p at 120 fps with frame pacing.',
    settings: { resolution: '1440p', fps: 120, bitrateMbps: 80, codec: 'auto', displayMode: 'fullscreen', vsync: false, framePacing: true },
  },
  {
    id: 'best-picture',
    label: 'Best picture',
    description: '4K at 60 fps, high bitrate, V-Sync on.',
    settings: { resolution: '4k', fps: 60, bitrateMbps: 150, codec: 'auto', displayMode: 'fullscreen', vsync: true, framePacing: true },
  },
] as const);

export const DEFAULT_STREAM_SETTINGS: StreamSettings = Object.freeze({
  presetId: 'balanced',
  resolution: '1440p',
  fps: 120,
  bitrateMbps: 80,
  advancedBitrate: false,
  codec: 'auto',
  audio: 'stereo',
  displayMode: 'fullscreen',
  vsync: false,
  framePacing: true,
  appName: 'Desktop',
}) as StreamSettings;

export interface AppleChipInfo {
  /** os.cpus()[0].model on macOS, e.g. "Apple M4" (verified on the Mac mini). */
  model: string;
  /** Parsed generation: "Apple M4 Pro" -> 4; non-Apple or unparsable -> null. */
  generation: number | null;
  /** generation >= 3 (AV1 hardware decode is M3 and later). */
  av1HardwareDecode: boolean;
}

/**
 * Codec resolution rule (pure function, Builder A: src/client/codec.ts):
 *   choice != 'auto'                                   -> choice
 *   chip.av1HardwareDecode && host advertises MASK_AV1 -> 'av1'
 *   host advertises MASK_HEVC (or support unknown)     -> 'hevc'
 *   else                                               -> 'h264'
 */
export type ResolveCodec = (choice: CodecChoice, chip: AppleChipInfo, serverCodecModeSupport: number | undefined) => ResolvedCodec;

/* ------------------------------------------------------------------------------------------------
 * 5. Process execution + step records (shared by both sides; feeds logs and diagnostics)
 * ---------------------------------------------------------------------------------------------- */
export interface ExecRequest {
  /** Absolute path (path.win32 on Windows). Never a shell string. */
  file: string;
  /** Argument array; passed verbatim to child_process.execFile/spawn with shell:false. */
  args: readonly string[];
  cwd?: string;
  timeoutMs: number;
  /** Strings that must be replaced by "[REDACTED]" in every log/diagnostic copy of argv/stdout/stderr. */
  secrets?: readonly string[];
  /** windowsHide: true is always set; env is inherited unless provided. */
  env?: Readonly<Record<string, string>>;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** spawn error (ENOENT, EACCES...) if the process never ran. */
  spawnError?: string;
}

/** Injected everywhere a process is run so tests can fake it. */
export interface ProcessRunner {
  run(req: ExecRequest): Promise<ExecResult>;
}

export type StepStatus = 'pass' | 'fail' | 'skip' | 'warn';

export interface StepRecord {
  stepId: string;
  title: string;
  status: StepStatus;
  startedAt: string;
  durationMs: number;
  /** Human sentence: what happened and, on failure, what to do. */
  message: string;
  /** Every process this step ran (redacted). */
  commands: Array<{
    file: string;
    argv: string[];
    exitCode: number | null;
    durationMs: number;
    stdoutTail: string; // last 4 KiB, redacted
    stderrTail: string; // last 4 KiB, redacted
    timedOut: boolean;
    spawnError?: string;
  }>;
  /** Structured extra facts (paths resolved, versions, rule names). Must contain no secrets. */
  data?: Record<string, unknown>;
}

/* ------------------------------------------------------------------------------------------------
 * 6. Host side: Sunshine location, setup steps, REST client
 * ---------------------------------------------------------------------------------------------- */
export interface SunshineInstall {
  /** Install root, e.g. "C:\\Program Files\\Sunshine". Always path.win32-normalised. */
  root: string;
  exe: string; // <root>\sunshine.exe
  serviceExe: string; // <root>\tools\sunshinesvc.exe
  configDir: string; // <root>\config
  configFile: string; // <root>\config\sunshine.conf
  logFile: string; // <root>\config\sunshine.log (or log_path override from sunshine.conf)
  certFile: string; // <root>\config\credentials\cacert.pem
  /** How root was found (first hit wins, in this order). */
  foundVia: 'service-binpath' | 'uninstall-registry' | 'fallback-path';
  version?: string; // uninstall DisplayVersion or GET /api/config "version"
}

/** Facts gathered by host/ps/get-sunshine-facts.ps1 (one JSON object on stdout). TS decides; PS only reports. */
export interface SunshineFactsPs {
  service: null | { name: string; pathName: string; startMode: string; state: string };
  uninstallEntries: Array<{ displayName: string; displayVersion?: string; installLocation?: string; uninstallString?: string }>;
  env: { ProgramFiles?: string; 'ProgramFiles(x86)'?: string; ProgramW6432?: string; ProgramData?: string; LOCALAPPDATA?: string; TEMP?: string };
}

/** Pure resolver (Builder B: src/host/sunshine-locate.ts). Uses path.win32 only. */
export type LocateSunshine = (facts: SunshineFactsPs, fileExists: (p: string) => boolean) => SunshineInstall | null;

export type HostStepId =
  | 'admin' // running elevated?
  | 'locate-sunshine'
  | 'install-sunshine' // msiexec /i <msi> /qn /norestart /l*v <log>
  | 'service' // SunshineService exists, start=auto, running
  | 'config' // SUNSHINE_MANAGED_CONFIG merged into sunshine.conf
  | 'credentials' // sunshine.exe --creds lanplay <random>; secret stored
  | 'restart-service'
  | 'web-ui' // 47990 listening, TLS cert == pinned cacert.pem fingerprint
  | 'api-auth' // GET /api/clients/list -> 200 with our creds
  | 'firewall-sunshine' // rule "Sunshine" present (re-add via netsh if missing)
  | 'firewall-agent' // rule "LanPlay Pair Agent" TCP+UDP 47920 LocalSubnet
  | 'agent-autostart' // app.setLoginItemSettings({openAtLogin:true,args:['--agent']})
  | 'agent-listening'; // TCP 47920 accepts, GET /v1/info ok, UDP probe answered

export const HOST_STEP_ORDER: readonly HostStepId[] = Object.freeze([
  'admin',
  'locate-sunshine',
  'install-sunshine',
  'service',
  'config',
  'credentials',
  'restart-service',
  'web-ui',
  'api-auth',
  'firewall-sunshine',
  'firewall-agent',
  'agent-autostart',
  'agent-listening',
] as const);

export interface HostStep {
  id: HostStepId;
  title: string;
  needsAdmin: boolean;
  /** Read-only probe used by self-check. Must never change the machine. */
  probe(ctx: HostStepContext): Promise<StepRecord>;
  /** Idempotent apply. Must be safe to run again after partial failure. */
  apply(ctx: HostStepContext): Promise<StepRecord>;
}

export interface HostStepContext {
  runner: ProcessRunner;
  log: Logger;
  paths: AppPaths;
  /** Path to the bundled MSI (resources/vendor/Sunshine-Windows-AMD64-installer.msi). */
  bundledMsiPath: string;
  /** Path to the bundled PS wrappers dir (resources/ps). */
  psDir: string;
  /** process.env.SystemRoot (e.g. "C:\\Windows"); base for powershell.exe, msiexec.exe, netsh.exe, sc.exe. */
  systemRoot: string;
  secrets: SecretStore;
  /** Filled by locate-sunshine; later steps read it. */
  install: SunshineInstall | null;
  isAdmin: boolean;
}

/** Thin PowerShell wrappers (src/host/ps/*.ps1). Each: Set-StrictMode -Version Latest; $ErrorActionPreference='Stop'; prints ONE JSON object; exit 0 ok / 1 failed / 2 bad arguments. */
export type PsScriptName =
  | 'get-sunshine-facts' // service (Get-CimInstance Win32_Service) + uninstall registry entries + env
  | 'test-admin' // {isAdmin:boolean}
  | 'get-firewall-rules' // -Names <a>,<b> -> {rules:[{name,enabled,direction,action,protocol,localPort,remoteAddress,program}]}
  | 'set-agent-firewall-rule' // -Port 47920 -Name "LanPlay Pair Agent" (idempotent New/Set-NetFirewallRule)
  | 'get-listeners' // -Ports 47984,... -> {listeners:[{port,protocol,pid,process}]}
  | 'get-system-info' // {os,build,gpus:[{name,driverVersion}],isAdmin,userName}
  | 'invoke-elevated'; // -File <exe> -ArgumentList <json array> -> Start-Process -Verb RunAs -Wait -PassThru; {exitCode}

export interface PsInvocation {
  script: PsScriptName;
  /** Named parameters, rendered as ['-Name', value] pairs; never concatenated into one string. */
  params: Record<string, string | number | boolean | readonly string[] | readonly number[]>;
  timeoutMs: number;
}

/**
 * argv used for every PS wrapper: file = path.win32.join(env.SystemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')
 * (Windows PowerShell 5.1; never rely on PATH), args = ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', <script>, ...params].
 * Wrappers must parse under 5.1: no ternary, no ??, no && / || pipeline chains (scripts/check-ps.mjs enforces via AST).
 */
export type BuildPsArgv = (systemRoot: string, psDir: string, inv: PsInvocation) => { file: string; args: string[] };

/**
 * Pure: quote ONE argument per CommandLineToArgvW / MSVCRT rules (spaces, tabs, quotes, trailing backslashes).
 * Needed only where Windows forces a single command-line string: Start-Process -ArgumentList in invoke-elevated.ps1
 * (PowerShell 5.1 joins array elements with spaces WITHOUT quoting). Must round-trip paths like
 * 'C:\\Users\\Jörg Müller\\Downloads\\LanPlay\\LanPlay.exe' and 'C:\\Program Files\\Sunshine\\'.
 */
export type QuoteWindowsArg = (arg: string) => string;

/** Pure: ['/i', msiPath, '/qn', '/norestart', '/l*v', logPath]; file = <SystemRoot>\System32\msiexec.exe. Exit 0 ok, 3010 ok+reboot, 1603 fatal, 1618 another install running. */
export type BuildMsiexecArgs = (systemRoot: string, msiPath: string, logPath: string) => { file: string; args: string[] };

/** Pure: merge managed keys into existing sunshine.conf text; keeps unknown lines, comments and order; idempotent (same input -> same output). */
export type MergeSunshineConf = (existing: string, managed: Readonly<Record<string, string>>) => { text: string; changed: boolean };

/** Pure (src/shared/ipnet.ts): strips "::ffff:" from IPv4-mapped IPv6 and zone ids ("%eth0"), lower-cases IPv6. */
export type NormalizeAddress = (addr: string) => string;
/** Pure: RFC1918 + 169.254/16 + 127/8 + ::1 + fe80::/10 + fc00::/7 (after NormalizeAddress). Anything unparsable -> false. */
export type IsPrivateAddress = (addr: string) => boolean;

export interface SunshinePendingPairing {
  /** 32 hex chars. */
  id: string;
  /** Untrusted device name reported by Moonlight. */
  name: string;
  /** Normalised remote address of the Moonlight client, as Sunshine saw it. */
  address: string;
}

export interface SunshineClientEntry {
  name: string;
  uuid: string;
  enabled: boolean;
}

export interface RestCallRecord {
  at: string;
  method: string;
  /** URL without credentials. */
  url: string;
  status: number | null;
  durationMs: number;
  /** Request body with "pin" and "password" values replaced by "[REDACTED]". */
  requestBody?: string;
  /** Response body (first 4 KiB), redacted. */
  responseBody?: string;
  error?: string;
}

export interface SunshineClientOptions {
  /** Default https://127.0.0.1:47990 */
  baseUrl: string;
  username: string;
  /** Read lazily so it never sits in a long-lived object that gets logged. */
  getPassword: () => Promise<string>;
  /** PEM of <configDir>\credentials\cacert.pem. TLS: ca=[pem], rejectUnauthorized=true, checkServerIdentity compares fingerprint256. Verified locally with Node 26 against an extension-less self-signed cert. */
  pinnedCertPem: string;
  timeoutMs: number;
  onCall?: (rec: RestCallRecord) => void;
}

export class SunshineApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly kind: 'auth' | 'redirect-welcome' | 'forbidden-origin' | 'bad-request' | 'tls-pin-mismatch' | 'network' | 'timeout' | 'bad-response',
  ) {
    super(message);
    this.name = 'SunshineApiError';
  }
}

export interface SunshineClient {
  getPendingPairings(): Promise<SunshinePendingPairing[]>;
  /** Resolves true only when Sunshine reports {"status":true}. Can take up to ping_timeout. */
  submitPin(req: { pairingId: string; pin: string; name: string }): Promise<boolean>;
  cancelPairing(pairingId: string): Promise<boolean>;
  listClients(): Promise<SunshineClientEntry[]>;
  unpairClient(uuid: string): Promise<boolean>;
  getVersion(): Promise<string>;
  getLogsTail(maxBytes: number): Promise<string>;
}

export type CreateSunshineClient = (opts: SunshineClientOptions) => SunshineClient;

/* ------------------------------------------------------------------------------------------------
 * 7. Pair agent (host, LAN HTTP on LANPLAY.agentPort) + client side of it
 * ---------------------------------------------------------------------------------------------- */
/**
 * Agent HTTP API (JSON only, prefix /v1). Request guards, in this order, for EVERY request:
 *   1. remote address (after unmapping ::ffff:a.b.c.d) is private: 10/8, 172.16/12, 192.168/16, 169.254/16,
 *      127/8, ::1, fe80::/10, fc00::/7. Else 403 {error:'forbidden-source'}.
 *   2. Host header is "<literal IP of a local interface>:<agentPort>" or "<os.hostname()>[.local]:<agentPort>"
 *      (case-insensitive). Else 421 {error:'bad-host'}  (DNS-rebinding guard).
 *   3. Any Origin or Referer header present (including "null") => 403 {error:'browser-origin'}
 *      (CSRF guard: LanPlay's client uses Node http from the main process, which sends neither).
 *   4. POST requires "Content-Type: application/json" exactly (forces a CORS preflight that we never answer). Else 415.
 *   5. Body <= LANPLAY.agentRateLimit.maxBodyBytes. Else 413.
 *   6. Rate limit (token bucket per IP + global) on POST. Else 429 with Retry-After seconds.
 *   No CORS headers are ever sent. OPTIONS -> 405.
 */
export const AGENT_ROUTES = Object.freeze({
  info: { method: 'GET', path: '/v1/info' },
  pair: { method: 'POST', path: '/v1/pair' },
  /** GET /v1/pair/<requestId> : poll while waiting for manual approval. */
  pairStatus: { method: 'GET', pathPrefix: '/v1/pair/' },
} as const);

export interface AgentInfoResponse {
  agentVersion: string;
  hostName: string;
  sunshineVersion: string | null;
  autoApprove: boolean;
  /** Sunshine API usable right now (creds + pinned TLS ok). */
  ready: boolean;
}

export interface AgentPairRequest {
  /** 4 digits, generated by the client with crypto.randomInt(0, 10000), zero-padded. */
  pin: string;
  /** Shown in the paired-devices list; 1..64 chars, [\p{L}\p{N} ._-]. Sent to Sunshine as "name". */
  clientName: string;
  /** Random per-install client id (uuid v4), used to correlate retries; not a secret. */
  clientId: string;
}

export type AgentPairResponse =
  | { status: 'paired'; sunshineClientName: string }
  | { status: 'pending-approval'; requestId: string; expiresInMs: number }
  | { status: 'denied' }
  | { status: 'failed'; code: PairErrorCode; message: string };

export interface AgentDiscoveryReply {
  magic: 'LANPLAY-DISCOVER-1';
  hostName: string;
  agentPort: number;
  sunshineHttpPort: number;
  addresses: string[];
}

export interface PendingApproval {
  requestId: string;
  clientName: string;
  remoteAddress: string;
  requestedAt: string;
  expiresAt: string;
}

export interface PairedDevice {
  /** Sunshine uuid (from /api/clients/list). */
  uuid: string;
  name: string;
  enabled: boolean;
  /** Known only for devices paired through LanPlay (agent keeps a small JSON ledger in %ProgramData%\LanPlay). */
  pairedVia?: 'lanplay' | 'other';
  pairedAt?: string;
  lastAddress?: string;
}

export interface AgentState {
  listening: boolean;
  port: number;
  autoApprove: boolean;
  pending: PendingApproval[];
  lastError?: string;
}

export interface PairAgent {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): AgentState;
  setAutoApprove(on: boolean): Promise<void>;
  decide(requestId: string, approve: boolean): Promise<void>;
  listDevices(): Promise<PairedDevice[]>;
  revoke(uuid: string): Promise<void>;
  /** Emits whenever state/pending changes (for IPC push). Returns unsubscribe. */
  onChange(cb: (s: AgentState) => void): () => void;
}

export interface PairAgentOptions {
  port: number;
  sunshine: SunshineClient;
  log: Logger;
  settings: KeyValueStore;
  /** Injected for tests: list of local interface addresses + hostname. */
  localIdentity: () => { hostName: string; addresses: string[] };
  now?: () => number;
}

export type CreatePairAgent = (opts: PairAgentOptions) => PairAgent;

/* ------------------------------------------------------------------------------------------------
 * 8. Pairing (client) + Moonlight runner
 * ---------------------------------------------------------------------------------------------- */
export type PairErrorCode =
  | 'agent-unreachable'
  | 'agent-forbidden'
  | 'agent-rate-limited'
  | 'approval-denied'
  | 'approval-timeout'
  | 'no-pending-pairing' // agent never saw Moonlight's request in GET /api/pin from our IP
  | 'wrong-pin' // Sunshine returned {"status":false}
  | 'sunshine-not-ready'
  | 'sunshine-api-error'
  | 'moonlight-missing'
  | 'moonlight-failed'
  | 'verify-failed' // `Moonlight list` still says not paired
  | 'timeout';

export type PairResult =
  | { ok: true; hostId: string; alreadyPaired: boolean; durationMs: number }
  | { ok: false; hostId: string; code: PairErrorCode; message: string; retryable: boolean; durationMs: number };

export type PairPhase = 'checking' | 'starting-moonlight' | 'contacting-agent' | 'waiting-approval' | 'confirming' | 'verifying' | 'done';

export interface PairProgress {
  hostId: string;
  phase: PairPhase;
  message: string;
}

export interface MoonlightStreamArgsInput {
  host: string; // IP literal (preferredAddress)
  settings: StreamSettings;
  resolvedCodec: ResolvedCodec;
}

export interface MoonlightRunner {
  /** Absolute path of the binary it will run (bundled first, then /Applications/Moonlight.app). */
  binaryPath(): string;
  /** Pure: argv for `stream`. Order: ['stream', host, appName, ...flags]. Flags per MOONLIGHT.streamFlags. */
  buildStreamArgs(input: MoonlightStreamArgsInput): string[];
  /** ['pair', host, '--pin', pin] */
  buildPairArgs(host: string, pin: string): string[];
  /** ['list', host] */
  buildListArgs(host: string): string[];
  /** Spawn pair (GUI window appears). Returns a handle so the caller can end it after the agent confirms. */
  startPair(host: string, pin: string): MoonlightProcessHandle;
  /** `list <host>`: exit 0 => paired. */
  isPaired(host: string, timeoutMs: number): Promise<{ paired: boolean; result: ExecResult }>;
  /** Spawn stream detached from our window; resolves once spawned (not when it ends). */
  startStream(input: MoonlightStreamArgsInput): MoonlightProcessHandle;
}

export interface MoonlightProcessHandle {
  pid: number | undefined;
  argv: string[];
  /** Resolves when the process exits. */
  exited: Promise<ExecResult>;
  /** SIGTERM, then SIGKILL after graceMs. */
  terminate(graceMs: number): Promise<void>;
}

export interface MoonlightRunnerOptions {
  /** Executable to spawn. Real: <vendor>/Moonlight.app/Contents/MacOS/Moonlight. Tests: process.execPath. */
  binary: string;
  /** Inserted before every argv. Tests: [<repo>/tests/fixtures/fake-moonlight.mjs]. Real: []. */
  prefixArgs: readonly string[];
  runner: ProcessRunner;
  log: Logger;
  /** Extra env for the child (tests point the fake CLI at its state file). */
  env?: Readonly<Record<string, string>>;
}
export type CreateMoonlightRunner = (opts: MoonlightRunnerOptions) => MoonlightRunner;

/** Pure: os.cpus()[0].model -> AppleChipInfo. "Apple M4" -> gen 4; "Apple M1 Max" -> 1; "Intel(R) Core(TM) i7" -> null. */
export type DetectAppleChip = (cpuModel: string) => AppleChipInfo;

export interface PairingService {
  pair(host: HostInfo, onProgress: (p: PairProgress) => void): Promise<PairResult>;
}

export interface DiscoveryService {
  /** Starts mDNS browse + agent UDP probe + (after 3 s with no result) /24 port-probe of 47989. */
  start(onUpdate: (hosts: HostInfo[]) => void): void;
  stop(): void;
  /** Manual entry: IPv4/IPv6 literal or hostname; resolves via GET http://<addr>:47989/serverinfo. */
  addManual(address: string): Promise<HostInfo>;
  list(): HostInfo[];
}

/* ------------------------------------------------------------------------------------------------
 * 9. Self-check, diagnostics, logging, secrets, paths
 * ---------------------------------------------------------------------------------------------- */
export interface SelfCheckReport {
  role: Role;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  steps: StepRecord[];
}

export interface DiagnosticsManifest {
  createdAt: string;
  app: { name: string; version: string; electron: string; node: string; chrome: string };
  os: { platform: string; release: string; arch: string; version?: string; build?: string };
  isAdmin: boolean | null;
  gpus: Array<{ name: string; driverVersion?: string }>;
  cpuModel: string;
  role: Role;
  /** Files inside the zip, with byte sizes. */
  files: Array<{ name: string; bytes: number }>;
}

/**
 * Zip layout produced by "Copy diagnostics" / --diagnostics (one file: LanPlay-diagnostics-<host>-<yyyymmdd-hhmmss>.zip):
 *   manifest.json           DiagnosticsManifest
 *   selfcheck.json          SelfCheckReport (fresh run)
 *   steps.jsonl             every StepRecord from the last setup run(s) (from logs)
 *   rest-calls.jsonl        RestCallRecord[] (host)
 *   network.json            {interfaces, hostName, listeners:[{port,proto,listening,pid}] for LANPLAY.listenPortsToCheck}
 *   firewall.json           (host) get-firewall-rules output for "Sunshine" and "LanPlay Pair Agent"
 *   sunshine.json           (host) SunshineInstall + service state + version
 *   paths.json              AppPaths + resolved Sunshine/Moonlight paths
 *   logs/lanplay-*.log      tails (LANPLAY.diagnosticsTailBytes) of the last 3 days, incl. *.elevated.log
 *   logs/sunshine.log       tail (host)
 *   logs/sunshine-install/  tail of newest file in %TEMP%\Sunshine\logs\install (host)
 *   logs/msiexec.log        tail of LanPlay's own msiexec /l*v log (host)
 *   logs/moonlight/*.log    tails of the 3 newest /tmp/Moonlight-*.log (client)
 * Everything passes through Redactor before it is written.
 */
export interface DiagnosticsService {
  collect(outDir?: string): Promise<{ zipPath: string; bytes: number }>;
}

export interface Redactor {
  /** Registers a literal secret (password, PIN). Replaced by "[REDACTED]" everywhere. */
  addSecret(value: string): void;
  /** Also masks: Authorization headers, "password"/"pin"/"pairing_id" JSON values, --creds argv values, --pin argv value. */
  redact(text: string): string;
  redactArgv(argv: readonly string[]): string[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One JSONL line. */
export interface LogEntry {
  ts: string; // ISO with ms
  level: LogLevel;
  /** Component, e.g. "host.step", "agent", "client.pair", "main". */
  scope: string;
  msg: string;
  /** Redacted structured data. */
  data?: Record<string, unknown>;
  /** Present for step records. */
  step?: StepRecord;
  /** Present for REST calls. */
  rest?: RestCallRecord;
}

export interface Logger {
  log(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void;
  step(rec: StepRecord): void;
  rest(rec: RestCallRecord): void;
  child(scope: string): Logger;
  /** Absolute path of today's file. */
  currentFile(): string;
  redactor: Redactor;
}

export interface AppPaths {
  /** win32: %ProgramData%\LanPlay\logs (fallback %LOCALAPPDATA%\LanPlay\logs if not writable). darwin: ~/Library/Logs/LanPlay */
  logDir: string;
  /** Electron app.getPath('userData'). */
  userData: string;
  /** win32: %ProgramData%\LanPlay (agent ledger, settings shared with elevated helper). darwin: userData. */
  sharedData: string;
  /** Packaged: process.resourcesPath. Dev: <repo>. */
  resources: string;
  /** resources/vendor */
  vendorDir: string;
  /** resources/ps (win32 only) */
  psDir: string;
  /** Default output dir for diagnostics zip: Desktop. */
  diagnosticsOutDir: string;
  logDirFellBack: boolean;
}

/**
 * Secrets: Electron safeStorage (macOS Keychain / Windows DPAPI) when isEncryptionAvailable(); otherwise a file
 * created with mode 0o600 (POSIX) / inherited user-only ACL under userData. Values never logged.
 */
export interface SecretStore {
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  delete(key: SecretKey): Promise<void>;
  backend(): 'keychain' | 'dpapi' | 'file-0600';
}
export type SecretKey = 'sunshine-admin-password';

export interface KeyValueStore {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
}

/* ------------------------------------------------------------------------------------------------
 * 10. CLI flags (same binary, both platforms). Parsed in src/main/cli.ts (Builder A); host flags dispatch to Builder B.
 * ---------------------------------------------------------------------------------------------- */
export const CLI_FLAGS = Object.freeze({
  selfCheck: '--self-check', // runs SelfCheckReport, prints JSON to stdout, exit 0 if ok else 1, no window
  diagnostics: '--diagnostics', // writes zip (optional "--out <dir>"), prints path, exit 0/1, no window
  out: '--out',
  role: '--role', // "client" | "host" override (default: darwin=client, win32=host)
  agent: '--agent', // host: headless pair agent (login item); no window
  hostSetup: '--host-setup', // host, ELEVATED child: run HOST_STEP_ORDER apply(); see handoff
  handoff: '--handoff', // path to a JSON HostSetupHandoff file (deleted by the child after reading)
  result: '--result', // path where the elevated child writes HostSetupResult JSON
  json: '--json',
} as const);

/** File written by the non-elevated app for the elevated child. Contains the admin password: delete after read. */
export interface HostSetupHandoff {
  version: 1;
  createdAt: string;
  sunshineAdminUser: string;
  sunshineAdminPassword: string;
  logDir: string;
  sharedData: string;
}

export interface HostSetupResult {
  version: 1;
  ok: boolean;
  steps: StepRecord[];
  install: SunshineInstall | null;
  /** SHA-256 fingerprint (colon hex, as Node X509Certificate.fingerprint256) of cacert.pem after setup. */
  certFingerprint256: string | null;
}

/* ------------------------------------------------------------------------------------------------
 * 11. IPC (renderer <-> main). Invoke channels return Promise<Res>; event channels are main -> renderer pushes.
 * ---------------------------------------------------------------------------------------------- */
export interface AppInfo {
  role: Role;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  logFile: string;
  /** Added by ui builder (additive, optional): os.hostname(), shown on the host screen so the client can be told the name. */
  hostName?: string;
  /** Added by ui builder (additive, optional): local IPv4 addresses for the host screen. */
  localAddresses?: string[];
}

export interface ClientSystemInfo {
  chip: AppleChipInfo;
  moonlightPath: string | null;
  moonlightVersion: string | null;
}

export interface HostSetupStatus {
  /** From the last setup or self-check run; null = never run. */
  lastRunAt: string | null;
  ok: boolean;
  steps: StepRecord[];
  install: SunshineInstall | null;
  isAdmin: boolean;
}

export interface StreamState {
  hostId: string;
  state: 'starting' | 'running' | 'ended' | 'failed';
  exitCode?: number | null;
  message?: string;
}

/** Invoke channels: name -> [request, response]. */
export interface IpcInvokeMap {
  'app:info': [void, AppInfo];
  'client:system-info': [void, ClientSystemInfo];
  'client:discover-start': [void, HostInfo[]];
  'client:discover-stop': [void, void];
  'client:add-manual-host': [{ address: string }, HostInfo];
  'client:settings-get': [void, StreamSettings];
  'client:settings-set': [StreamSettings, StreamSettings];
  'client:pair': [{ hostId: string }, PairResult];
  'client:stream-start': [{ hostId: string; settings: StreamSettings }, StreamState];
  'client:stream-stop': [{ hostId: string }, void];
  'host:setup-status': [void, HostSetupStatus];
  'host:setup-run': [void, HostSetupStatus];
  'host:agent-state': [void, AgentState];
  'host:agent-set-auto-approve': [{ on: boolean }, AgentState];
  'host:agent-decide': [{ requestId: string; approve: boolean }, AgentState];
  'host:devices-list': [void, PairedDevice[]];
  'host:devices-revoke': [{ uuid: string }, PairedDevice[]];
  'selfcheck:run': [void, SelfCheckReport];
  'diagnostics:collect': [void, { zipPath: string; bytes: number }];
  /** Only accepts a zipPath previously returned by diagnostics:collect (main keeps the allow-list). */
  'diagnostics:reveal': [{ zipPath: string }, void];
}

/** Event channels: name -> payload. */
export interface IpcEventMap {
  'client:hosts-updated': HostInfo[];
  'client:pair-progress': PairProgress;
  'client:stream-state': StreamState;
  'host:setup-progress': StepRecord;
  'host:agent-state-changed': AgentState;
}

export type IpcInvokeChannel = keyof IpcInvokeMap;
export type IpcEventChannel = keyof IpcEventMap;
export type IpcRequest<C extends IpcInvokeChannel> = IpcInvokeMap[C][0];
export type IpcResponse<C extends IpcInvokeChannel> = IpcInvokeMap[C][1];

/** Runtime allow-lists used by preload (only these strings may cross the bridge). Keep in sync with the maps above (a test enforces it). */
export const IPC_INVOKE_CHANNELS = Object.freeze([
  'app:info',
  'client:system-info',
  'client:discover-start',
  'client:discover-stop',
  'client:add-manual-host',
  'client:settings-get',
  'client:settings-set',
  'client:pair',
  'client:stream-start',
  'client:stream-stop',
  'host:setup-status',
  'host:setup-run',
  'host:agent-state',
  'host:agent-set-auto-approve',
  'host:agent-decide',
  'host:devices-list',
  'host:devices-revoke',
  'selfcheck:run',
  'diagnostics:collect',
  'diagnostics:reveal',
] as const satisfies readonly IpcInvokeChannel[]);

export const IPC_EVENT_CHANNELS = Object.freeze([
  'client:hosts-updated',
  'client:pair-progress',
  'client:stream-state',
  'host:setup-progress',
  'host:agent-state-changed',
] as const satisfies readonly IpcEventChannel[]);

/** Every IPC reply is wrapped so errors cross the bridge as data (no stack traces / paths with secrets). */
export type IpcEnvelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

/**
 * Preload API exposed as window.lanplay via contextBridge.exposeInMainWorld('lanplay', api).
 * Preload validates the channel against IPC_*_CHANNELS and unwraps IpcEnvelope (throws Error(message) on ok:false).
 * main validates every request payload shape before use (renderer is untrusted).
 */
export interface LanPlayPreloadApi {
  invoke<C extends IpcInvokeChannel>(channel: C, ...req: IpcRequest<C> extends void ? [] : [IpcRequest<C>]): Promise<IpcResponse<C>>;
  on<E extends IpcEventChannel>(channel: E, listener: (payload: IpcEventMap[E]) => void): () => void;
}

declare global {
  interface Window {
    lanplay: LanPlayPreloadApi;
  }
}

/* ------------------------------------------------------------------------------------------------
 * 12. Main-process service facades (what main.ts wires to IPC). One per side.
 * ---------------------------------------------------------------------------------------------- */
export interface ClientService {
  systemInfo(): Promise<ClientSystemInfo>;
  discovery: DiscoveryService;
  getSettings(): StreamSettings;
  setSettings(s: StreamSettings): StreamSettings; // clamps + validates
  pair(hostId: string, onProgress: (p: PairProgress) => void): Promise<PairResult>;
  startStream(hostId: string, settings: StreamSettings, onState: (s: StreamState) => void): Promise<StreamState>;
  stopStream(hostId: string): Promise<void>;
  selfCheck(): Promise<SelfCheckReport>;
}

export interface HostService {
  setupStatus(): Promise<HostSetupStatus>;
  /** Non-elevated: writes handoff, runs invoke-elevated with [exe, --host-setup, --handoff, f, --result, r], reads result. */
  runSetup(onProgress: (s: StepRecord) => void): Promise<HostSetupStatus>;
  /** Elevated child entry point (CLI --host-setup). Returns process exit code. */
  runElevatedSetup(handoffPath: string, resultPath: string): Promise<number>;
  agent: PairAgent;
  selfCheck(): Promise<SelfCheckReport>;
}

export interface ServiceDeps {
  log: Logger;
  paths: AppPaths;
  secrets: SecretStore;
  settings: KeyValueStore;
  runner: ProcessRunner;
}

export type CreateClientService = (deps: ServiceDeps) => ClientService;
export type CreateHostService = (deps: ServiceDeps) => HostService;

/* ------------------------------------------------------------------------------------------------
 * 13. Electron security policy (Builder A implements in src/main/security.ts)
 * ---------------------------------------------------------------------------------------------- */
export const SECURITY = Object.freeze({
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, spellcheck: false },
  /** Renderer is loaded from a file:// URL inside the app; navigation to anything else is blocked. */
  allowedNavigationPrefixes: ['file://'] as const,
  /** window.open: denied, except these exact external URLs opened via shell.openExternal (license/source offer). */
  allowedExternalUrls: [
    'https://github.com/LizardByte/Sunshine/tree/v2026.914.233613',
    'https://github.com/moonlight-stream/moonlight-qt/tree/v6.2.0',
    'https://www.gnu.org/licenses/gpl-3.0.html',
  ] as const,
  csp: "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  /** Deny all permission requests (camera, notifications, ...). */
  denyAllPermissions: true,
} as const);
