/**
 * LanPlay v2 contract: LanPlay Link (clipboard + file transfer + exit gesture), updater, Windows client.
 * Pure types and frozen constants, NO runtime imports. Every v2 module codes against THIS file; contracts.ts stays as is
 * (the integrator adds the IPC entries listed at the bottom to contracts.ts).
 *
 * Topology: the HOST (Windows PC running Sunshine + the pair agent on TCP 47920, firewall rule already LocalSubnet) is the
 * only listener. The CLIENT (Mac or Windows) always connects OUT to host:47920, so the client needs no firewall rule.
 * One enrolled client = one "link". Everything below flows over that link in both directions.
 *
 * Transport (implemented once, in src/core/link/transport-*.ts):
 *   enroll   POST /v1/link/enroll   {clientId, clientName, pub}              -> LinkEnrollResponse (guards = existing agent guards 1-6)
 *            GET  /v1/link/enroll/<requestId>                                 -> poll while manual approval is pending
 *   events   GET  /v1/link/events    (host -> client, Server-Sent Events, long lived, "data: <frame>\n\n", ": ka\n\n" every 10 s)
 *   send     POST /v1/link/send      {"f":"<frame>"}  application/json       (client -> host), body limit LINK.maxPostBytes
 * Every link request carries headers (no Origin/Referer, ever):
 *   X-LanPlay-Client: <clientId>   X-LanPlay-Ts: <unix ms>   X-LanPlay-Nonce: <16 random bytes b64url>
 *   X-LanPlay-Auth: b64url(HMAC-SHA256(authKey, method + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + sha256hex(body)))
 * Host rejects: unknown client (401), |now-ts| > 60 s (401), repeated nonce within 5 min (401), bad MAC (401). Constant-time compare.
 * Keys: enroll does X25519 (node:crypto generateKeyPairSync('x25519'), diffieHellman). shared -> HKDF-SHA256(
 *   ikm=shared, salt=clientPubRaw||hostPubRaw, info="lanplay-link-v1") -> 64 bytes: authKey = [0,32), encKey = [32,64).
 * Frame = b64url( nonce12 || AES-256-GCM(encKey, nonce12, aad=<"c2h"|"h2c">+clientId, plaintext=JSON of LinkMessage) || tag16 ).
 *   Fresh random 12-byte nonce per frame. A frame that fails to decrypt/parse is dropped and logged (never throws to the caller).
 * Enroll policy = pairing policy: allowed at once when agent autoApprove is ON or the clientId already enrolled; otherwise it
 * waits for the same manual approval UI as pairing (PendingApproval). Revoking a paired device also deletes its link key.
 * Keys are stored via SecretStore (host: link-key:<clientId>, client: link-key:<hostId>, client also link-priv:<hostId>).
 * Plain HTTP on a trusted LAN: payloads are encrypted+authenticated, but a LAN attacker who is present during the FIRST enroll
 * could MITM it; documented limitation (same trust level as auto-approve pairing).
 */

export const LINK = Object.freeze({
  version: 1,
  agentPort: 47920,
  routes: {
    enroll: '/v1/link/enroll',
    enrollStatusPrefix: '/v1/link/enroll/',
    events: '/v1/link/events',
    send: '/v1/link/send',
  },
  headers: { client: 'x-lanplay-client', ts: 'x-lanplay-ts', nonce: 'x-lanplay-nonce', auth: 'x-lanplay-auth' },
  /** Max accepted POST body on /v1/link/send (an xfer chunk is <= chunkBytes before base64+GCM). */
  maxPostBytes: 1_200_000,
  chunkBytes: 512 * 1024,
  /** Chunks in flight before the sender waits for xfer-ack. */
  window: 8,
  clockSkewMs: 60_000,
  nonceTtlMs: 5 * 60_000,
  keepAliveMs: 10_000,
  /** Client pings every pingMs; no frame for deadMs => link is "down" and the client reconnects with backoff. */
  pingMs: 5_000,
  deadMs: 20_000,
  reconnectBackoffMs: [500, 1000, 2000, 5000, 10_000] as const,
  /** Clipboard limits. */
  maxClipTextBytes: 1_000_000,
  maxClipImageBytes: 16 * 1024 * 1024,
  clipPollMs: 400,
  /** Transfer limits (files dropped or copied). */
  maxFileBytes: 8 * 1024 * 1024 * 1024,
  maxFilesPerTransfer: 500,
  maxClipFilesBytes: 512 * 1024 * 1024,
  maxClipFiles: 50,
  /** Where received files go: <Downloads>/LanPlay/<peerName>/ ; clipboard-files go to <os tmp>/LanPlay-clipboard/<xferId>/ (deleted after 24 h). */
  receivedFolderName: 'LanPlay',
} as const);

export type LinkRole = 'host' | 'client';

export interface LinkEnrollRequest {
  clientId: string; // uuid v4 (same value the pairing flow uses)
  clientName: string; // 1..64 chars, [\p{L}\p{N} ._-]
  pub: string; // base64url raw X25519 public key (32 bytes)
}
export type LinkEnrollResponse =
  | { status: 'enrolled'; hostPub: string; hostName: string; hostId: string }
  | { status: 'pending-approval'; requestId: string; expiresInMs: number }
  | { status: 'denied' }
  | { status: 'failed'; code: string; message: string };

/* ----------------------------- messages (plaintext inside frames) ----------------------------- */
export type ClipPayload =
  | { kind: 'text'; text: string }
  /** Image and file clipboards are sent through the transfer engine (purpose 'clip-image' / 'clip-files'); this only announces them. */
  | { kind: 'image'; xferId: string }
  | { kind: 'files'; xferId: string };

export type XferPurpose = 'files' | 'clip-image' | 'clip-files';
export interface XferFileMeta {
  /** Relative path using "/" separators, sanitised by the receiver (no "..", no absolute, no drive letters, no reserved names). */
  rel: string;
  size: number;
  isDir?: boolean;
}

export type ExitAction = 'resume' | 'minimize' | 'disconnect' | 'disconnect-quit-app';
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export type LinkMessage =
  | { t: 'hello'; v: 1; name: string; platform: string; streaming: boolean; clipboard: boolean; transfer: boolean }
  | { t: 'ping'; n: number }
  | { t: 'pong'; n: number }
  | { t: 'session'; streaming: boolean }
  | { t: 'clip'; seq: number; clip: ClipPayload; hash: string }
  | { t: 'xfer-offer'; id: string; purpose: XferPurpose; files: XferFileMeta[]; totalBytes: number }
  | { t: 'xfer-accept'; id: string }
  | { t: 'xfer-reject'; id: string; reason: string }
  | { t: 'xfer-chunk'; id: string; file: number; seq: number; b64: string; last: boolean }
  | { t: 'xfer-ack'; id: string; file: number; seq: number }
  | { t: 'xfer-done'; id: string; ok: boolean; error?: string }
  | { t: 'xfer-cancel'; id: string }
  /** host -> client: the host user pushed the cursor into a hot corner while streaming. */
  | { t: 'exit-request'; reason: 'hot-corner' | 'hotkey'; corner?: Corner }
  /** client -> host: informational (host may show a toast); the client executes the action itself. */
  | { t: 'exit-taken'; action: ExitAction };

export interface LinkState {
  /** disconnected: not enrolled or offline; connecting; enrolling (waiting for approval); connected. */
  phase: 'disconnected' | 'connecting' | 'enrolling' | 'connected';
  peerName: string | null;
  peerId: string | null;
  lastError?: string;
  /** Peer announced it is streaming (host's view of a client). */
  peerStreaming: boolean;
}

/** One link to one peer. Implemented by the host hub (one per enrolled client) and by the client connector. */
export interface LinkPeer {
  readonly id: string; // peer id (clientId on the host, hostId on the client)
  readonly name: string;
  readonly state: LinkState;
  /** Rejects with Error('link-down') when not connected. Frames are encrypted by the transport. */
  send(msg: LinkMessage): Promise<void>;
  onMessage(cb: (m: LinkMessage) => void): () => void;
  onState(cb: (s: LinkState) => void): () => void;
}

export interface LinkHub {
  /** Host: peers currently connected (SSE open). Client: 0 or 1. */
  peers(): LinkPeer[];
  /** Called for every peer that connects (and immediately for already connected ones). Returns unsubscribe. */
  onPeer(cb: (peer: LinkPeer) => void): () => void;
}

/* ----------------------------- feature modules ----------------------------- */
export interface LinkPrefs {
  clipboardSync: boolean; // default true
  clipboardImages: boolean; // default true
  clipboardFiles: boolean; // default true (beta, best effort)
  receiveFiles: boolean; // default true; false = reject incoming offers
  /** Ask before saving incoming files from a peer? default false (LAN, own devices) */
  confirmIncoming: boolean;
  /** Floating drop pill ("Send to <peer>") always on top. Client default true, host default false. */
  dropPill: boolean;
  /** Hot corner on the host while a stream is running. 'off' disables. Default 'top-right'. */
  hotCorner: Corner | 'off';
  /** How long the cursor must stay in the corner (ms). Default 600, clamp 300..3000. */
  hotCornerDwellMs: number;
  /** Global hotkey on the client that opens the exit overlay. Default 'CommandOrControl+Alt+Shift+E'; '' = off. */
  exitHotkey: string;
}
export const DEFAULT_LINK_PREFS: LinkPrefs = Object.freeze({
  clipboardSync: true,
  clipboardImages: true,
  clipboardFiles: true,
  receiveFiles: true,
  confirmIncoming: false,
  dropPill: true,
  hotCorner: 'top-right',
  hotCornerDwellMs: 600,
  exitHotkey: 'CommandOrControl+Alt+Shift+E',
}) as LinkPrefs;

export interface TransferInfo {
  id: string;
  direction: 'send' | 'receive';
  purpose: XferPurpose;
  peerName: string;
  files: number;
  totalBytes: number;
  doneBytes: number;
  state: 'offered' | 'running' | 'done' | 'failed' | 'cancelled';
  error?: string;
  /** receive side, when done: absolute folder the files are in. */
  savedTo?: string;
}

export interface LinkStatus {
  state: LinkState;
  prefs: LinkPrefs;
  transfers: TransferInfo[];
}

/** Clipboard module: attaches to a peer, polls the local clipboard, applies remote clips. Pure of Electron via injected port. */
export interface ClipboardPort {
  readText(): string;
  writeText(t: string): void;
  /** PNG bytes or null. */
  readImagePng(): Uint8Array | null;
  writeImagePng(png: Uint8Array): void;
  /** Absolute paths of files currently copied in the file manager, [] when none (best effort per OS). */
  readFilePaths(): Promise<string[]>;
  /** Put these files on the clipboard as "copied files" (best effort per OS). */
  writeFilePaths(paths: string[]): Promise<void>;
  /** True when the clipboard content is marked concealed/sensitive (password managers): never synced. */
  isConcealed(): boolean;
}

/** Hot-corner watcher (host). `cursor`/`display` are injected (Electron screen) so it is testable. */
export interface HotCornerDeps {
  getCursor(): { x: number; y: number };
  getPrimaryBounds(): { x: number; y: number; width: number; height: number };
  prefs(): Pick<LinkPrefs, 'hotCorner' | 'hotCornerDwellMs'>;
  /** True while at least one linked client says it is streaming. */
  streaming(): boolean;
  onTrigger(corner: Corner): void;
  now?: () => number;
  pollMs?: number;
}

/** What the client does when the user picks an action in the exit overlay (or the hot corner fires). */
export interface SessionController {
  /** Moonlight process of the running stream, if any. */
  isStreaming(): boolean;
  perform(action: ExitAction): Promise<void>;
}

/* ----------------------------- updater ----------------------------- */
export const UPDATE = Object.freeze({
  /** GitHub "owner/repo" of the releases. Empty = updater disabled until the user sets it in the app. */
  defaultRepo: '',
  /** Asset names looked up in the latest release. {v} = version without leading "v". */
  assets: { win32: 'LanPlay-Setup-{v}.exe', darwin: 'LanPlay-{v}-mac-arm64.zip', checksums: 'SHA256SUMS.txt' },
  allowedHosts: ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'] as const,
  checkEveryMs: 6 * 60 * 60_000,
  maxAssetBytes: 1_500_000_000,
} as const);

export interface UpdateConfig {
  repo: string; // "owner/repo" or ''
  auto: boolean; // check on start + every 6 h and download in background; default true
  /** Optional GitHub token for a PRIVATE repo (stored in SecretStore 'update-token', never logged). */
  hasToken: boolean;
}
export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
export interface UpdateState {
  phase: UpdatePhase;
  current: string;
  latest: string | null;
  notes: string | null;
  progress: number; // 0..1 while downloading
  error?: string;
  lastCheckedAt: string | null;
}
export interface UpdateService {
  getConfig(): UpdateConfig;
  setConfig(c: { repo?: string; auto?: boolean; token?: string | null }): Promise<UpdateConfig>;
  getState(): UpdateState;
  /** Fetch latest release, compare semver, download + verify SHA-256 when newer. */
  check(manual: boolean): Promise<UpdateState>;
  /** Windows: run the verified NSIS installer silently (/S) then relaunch. macOS: replace the .app via a detached helper script then relaunch. */
  installAndRestart(): Promise<void>;
  onChange(cb: (s: UpdateState) => void): () => void;
  start(): void;
  stop(): void;
}

/* ----------------------------- IPC additions (integrator copies these into contracts.ts) ----------------------------- */
export interface LinkIpcInvokeMap {
  'link:status': [void, LinkStatus];
  'link:prefs-set': [Partial<LinkPrefs>, LinkStatus];
  /** Absolute paths from the OS drop (preload webUtils.getPathForFile) or a file picker. Main validates every path. */
  'link:send-paths': [{ paths: string[] }, { transferId: string | null; error?: string }];
  'link:pick-and-send': [void, { transferId: string | null }];
  'link:transfer-cancel': [{ id: string }, void];
  'link:transfer-decide': [{ id: string; accept: boolean }, void];
  'link:open-received': [void, void];
  'link:connect': [{ hostId: string }, LinkStatus];
  'exit:perform': [{ action: ExitAction }, void];
  'exit:state': [void, { streaming: boolean; hostName: string | null }];
  'update:state': [void, UpdateState];
  'update:config-get': [void, UpdateConfig];
  'update:config-set': [{ repo?: string; auto?: boolean; token?: string | null }, UpdateConfig];
  'update:check': [void, UpdateState];
  'update:install': [void, void];
  'app:role-set': [{ role: LinkRole }, { relaunching: boolean }];
}
export interface LinkIpcEventMap {
  'link:status-changed': LinkStatus;
  'update:state-changed': UpdateState;
  /** main -> exit overlay window only */
  'exit:show': { reason: 'hot-corner' | 'hotkey' | 'menu'; hostName: string | null };
}
