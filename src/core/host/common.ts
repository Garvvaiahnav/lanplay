// Platform-neutral host pieces shared by the Windows and macOS HostService implementations.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { LANPLAY, SUNSHINE, SunshineApiError } from '../../contracts.js';
import type { PairAgent, SunshineClient, SunshineClientOptions } from '../../contracts.js';
import { httpGet, udpQuery } from '../shared/netprobe.js';
import { createSunshineClient } from './sunshine-client.js';

export const LAST_SETUP_KEY = 'host.lastSetup';
/** LanPlay.exe path the firewall rules were created for (the program-bound rules stop matching when the folder moves). */
export const SETUP_EXE_KEY = 'host.setupExe';
export const PINNED_CERT_NAME = 'sunshine-cert.pem';

export function defaultLocalIdentity(): { hostName: string; addresses: string[] } {
  const addresses: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) addresses.push(a.address);
  return { hostName: os.hostname(), addresses };
}

/**
 * Lazily builds a pinned SunshineClient on each call: the cert copy and password may appear only after setup ran.
 */
export class LazySunshineClient implements SunshineClient {
  constructor(
    private readonly certPath: string,
    private readonly getPassword: () => Promise<string | null>,
    private readonly onCall: SunshineClientOptions['onCall'],
    private readonly baseUrl = `https://127.0.0.1:${SUNSHINE.webUiPort}`,
  ) {}
  private async client(): Promise<SunshineClient> {
    let pem: string;
    try {
      pem = readFileSync(this.certPath, 'utf8');
    } catch {
      throw new SunshineApiError(`LanPlay setup has not finished: no pinned Sunshine certificate at ${this.certPath}`, null, 'network');
    }
    const pw = await this.getPassword();
    if (!pw) throw new SunshineApiError('LanPlay setup has not finished: no stored Sunshine admin password', null, 'auth');
    const o: SunshineClientOptions = { baseUrl: this.baseUrl, username: LANPLAY.sunshineAdminUser, getPassword: async () => pw, pinnedCertPem: pem, timeoutMs: 10_000 };
    if (this.onCall) o.onCall = this.onCall;
    return createSunshineClient(o);
  }
  async getPendingPairings() {
    return (await this.client()).getPendingPairings();
  }
  async submitPin(r: { pairingId: string; pin: string; name: string }) {
    return (await this.client()).submitPin(r);
  }
  async cancelPairing(id: string) {
    return (await this.client()).cancelPairing(id);
  }
  async listClients() {
    return (await this.client()).listClients();
  }
  async unpairClient(uuid: string) {
    return (await this.client()).unpairClient(uuid);
  }
  async getVersion() {
    return (await this.client()).getVersion();
  }
  async getLogsTail(n: number) {
    return (await this.client()).getLogsTail(n);
  }
}

export function generateAdminPassword(): string {
  // base64url may start with "-" or "_"; an argv value that looks like an option is asking for trouble, so re-roll.
  for (;;) {
    const pw = randomBytes(32).toString('base64url');
    if (/^[A-Za-z0-9]/.test(pw)) return pw;
  }
}

export async function probeAgent(agent: PairAgent): Promise<{ http: boolean; udp: boolean; detail: string }> {
  const port = agent.getState().port || LANPLAY.agentPort;
  let http = false;
  let detail = '';
  try {
    const r = await httpGet('127.0.0.1', port, '/v1/info', 3000);
    http = r.status === 200;
    detail = `GET /v1/info -> ${r.status} ${r.body.slice(0, 200)}`;
  } catch (e) {
    detail = `GET /v1/info failed: ${(e as Error).message}`;
  }
  const u = await udpQuery('127.0.0.1', port, LANPLAY.agentDiscoveryMagic, 1500);
  const udp = Boolean(u && u.includes(LANPLAY.agentDiscoveryMagic));
  if (!udp) detail += '; UDP discovery: no reply';
  return { http, udp, detail };
}
