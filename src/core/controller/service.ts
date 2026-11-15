// Phone controllers on the host: ties the virtual-pad backend, the player manager, the LAN server and the persisted switch
// together, and exposes one ControllersState for the UI. No Electron; the elevated driver/firewall setup is injected.
import { randomBytes } from 'node:crypto';
import qrcode from 'qrcode-generator';
import type { ControllerLink, ControllersState, KeyValueStore } from '../../contracts.js';
import { LayoutFileStore } from './layout-store.js';
import { ControllerManager } from './manager.js';
import { ControllerServer } from './server.js';
import type { PadBackend } from './vigem.js';

export const CONTROLLER_PORT = 47921;
const ENABLED_KEY = 'controllers.enabled';
const TOKEN_KEY = 'controllers.token';

export interface SetupResult {
  ok: boolean;
  message: string;
}

export interface ControllerServiceDeps {
  backend: PadBackend;
  /** Folder for the per-phone layout files. */
  layoutsDir: string;
  /** dist/controller-ui */
  uiDir: string;
  /** 0 picks a free port (tests). */
  port: number;
  settings: KeyValueStore;
  /** The host's home-network IPv4 addresses, used to build join links. */
  localAddresses(): string[];
  isAllowedAddress(address: string): boolean;
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void;
  /** Elevated (UAC): install the virtual-controller driver and open the LAN port in the firewall. */
  runSetup(): Promise<SetupResult>;
}

function qrDataUrl(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return `data:image/svg+xml;utf8,${encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }))}`;
}

export class ControllerService {
  private readonly manager: ControllerManager;
  private server: ControllerServer | null = null;
  private port: number;
  private error: string | null = null;
  private setupRunning = false;
  private setupPromise: Promise<ControllersState> | null = null;
  private readonly listeners = new Set<(s: ControllersState) => void>();

  constructor(private readonly d: ControllerServiceDeps) {
    this.port = d.port;
    this.manager = new ControllerManager({ createPad: (slot) => d.backend.createPad(slot), now: () => Date.now() });
    this.manager.onChange(() => this.emit());
  }

  onChange(l: (s: ControllersState) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    const s = this.state();
    for (const l of this.listeners) l(s);
  }

  private enabled(): boolean {
    return this.d.settings.get<boolean>(ENABLED_KEY, false) === true;
  }

  private token(): string {
    const have = this.d.settings.get<string>(TOKEN_KEY, '');
    if (typeof have === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(have)) return have;
    const t = randomBytes(18).toString('base64url');
    this.d.settings.set(TOKEN_KEY, t);
    return t;
  }

  state(): ControllersState {
    const running = this.server !== null;
    const links: ControllerLink[] = running
      ? this.d.localAddresses().map((address) => {
          const url = `http://${address}:${this.port}/?t=${this.token()}`;
          return { address, url, qrDataUrl: qrDataUrl(url) };
        })
      : [];
    return {
      enabled: this.enabled(),
      running,
      port: this.port,
      links,
      driver: this.d.backend.status(),
      players: this.manager.list().map((p) => ({ id: p.id, slot: p.slot, name: p.name, address: p.address, stale: p.stale })),
      setupRunning: this.setupRunning,
      error: this.error,
    };
  }

  /** At app start: bring the server up again if it was left on. Never throws. */
  async init(): Promise<void> {
    if (this.enabled()) await this.start();
  }

  async setEnabled(on: boolean): Promise<ControllersState> {
    this.d.settings.set(ENABLED_KEY, on);
    if (on) await this.start();
    else await this.stop();
    this.emit();
    return this.state();
  }

  /** New session token: links and QR codes of the old one stop working (running phones stay connected until they reload). */
  async newLink(): Promise<ControllersState> {
    this.d.settings.set(TOKEN_KEY, '');
    if (this.server) {
      await this.stop();
      await this.start();
    }
    this.emit();
    return this.state();
  }

  kick(id: string): ControllersState {
    this.server?.kick(id);
    return this.state();
  }

  /** Elevated driver + firewall setup, then start if the switch is on. Concurrent calls share one run. */
  setup(): Promise<ControllersState> {
    if (this.setupPromise) return this.setupPromise;
    this.setupRunning = true;
    this.error = null;
    this.emit();
    this.setupPromise = (async () => {
      try {
        const r = await this.d.runSetup();
        this.d.log(r.ok ? 'info' : 'warn', 'controller setup finished', { ok: r.ok, message: r.message });
        if (!r.ok) this.error = r.message;
      } catch (e) {
        this.error = (e as Error).message;
        this.d.log('error', 'controller setup crashed', { error: this.error });
      } finally {
        this.setupRunning = false;
      }
      if (this.enabled() && this.error === null) await this.start();
      this.emit();
      return this.state();
    })().finally(() => {
      this.setupPromise = null;
    });
    return this.setupPromise;
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  private async start(): Promise<void> {
    if (this.server) return;
    this.error = null;
    const driver = this.d.backend.status();
    if (!driver.ok) {
      this.error =
        driver.reason === 'driver-missing'
          ? 'The virtual controller driver is not installed yet. Use "Install driver" below.'
          : `Virtual controllers are not available: ${driver.message}`;
      return;
    }
    const server = new ControllerServer({
      manager: this.manager,
      layouts: new LayoutFileStore(this.d.layoutsDir),
      uiDir: this.d.uiDir,
      port: this.port,
      token: this.token(),
      isAllowedAddress: this.d.isAllowedAddress,
      log: (level, msg, data) => this.d.log(level, msg, data),
    });
    try {
      this.port = await server.start();
      this.server = server;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      this.error = code === 'EADDRINUSE' ? `Port ${this.port} is already used by another program.` : `Could not start the phone controller server: ${(e as Error).message}`;
      this.d.log('warn', 'phone controller server failed to start', { error: (e as Error).message });
      await server.stop().catch(() => undefined);
    }
  }

  private async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await s.stop();
    else this.manager.closeAll();
  }
}
