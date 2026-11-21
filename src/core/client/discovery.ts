// Host discovery on the LAN: mDNS _nvstream._tcp + LanPlay agent UDP probe in parallel; after 3 s with no host,
// TCP-probe 47989 on the local subnets. Every candidate is confirmed with GET /serverinfo.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import { Bonjour } from 'bonjour-service';
import { LANPLAY, SUNSHINE } from '../../contracts.js';
import type { AgentDiscoveryReply, DiscoveryService, DiscoverySource, HostInfo, Logger } from '../../contracts.js';
import { broadcastAddress, isPrivateAddress, isRemoteAddress, normalizeAddress, parseHostPort, subnetHosts } from '../shared/ipnet.js';
import { httpGet, tcpProbe } from '../shared/netprobe.js';
import { describeInternetProbeError, fetchServerInfo, formatHostPort } from './serverinfo.js';
import type { ServerInfo } from './serverinfo.js';

export interface MdnsBrowser {
  start(onService: (s: { name: string; addresses: string[]; port: number }) => void): void;
  stop(): void;
}

/** bonjour-service@1.4.4 (MIT). Service type from Sunshine platform/common.h#L1286-L1287: "_nvstream._tcp". */
export function createBonjourBrowser(log: Logger): MdnsBrowser {
  let b: Bonjour | null = null;
  return {
    start(onService) {
      try {
        b = new Bonjour({}, (e: Error) => log.log('warn', 'discovery', `mDNS error: ${e?.message}`));
        b.find({ type: SUNSHINE.mdnsServiceType.replace(/^_/, '').replace(/\._tcp$/, ''), protocol: 'tcp' }, (svc) => {
          const addrs = [...(svc.addresses ?? []), ...(svc.referer?.address ? [svc.referer.address] : [])];
          onService({ name: svc.name, addresses: addrs, port: svc.port });
        });
      } catch (e) {
        log.log('warn', 'discovery', `mDNS unavailable: ${(e as Error).message}`);
      }
    },
    stop() {
      try {
        b?.destroy();
      } catch {
        /* ignore */
      }
      b = null;
    },
  };
}

export interface DiscoveryDeps {
  log: Logger;
  fetchServerInfo: (host: string, port: number, timeoutMs?: number) => Promise<ServerInfo>;
  mdns: MdnsBrowser | null;
  /** Broadcast destinations for the agent UDP probe. */
  udpTargets: () => string[];
  agentPort: number;
  /** Hosts for the 47989 port-probe fallback. */
  probeHosts: () => string[];
  tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /** Is the pair agent reachable on this host? */
  agentCheck: (host: string, port: number) => Promise<boolean>;
  sunshinePort: number;
  probeDelayMs: number;
  probeTimeoutMs: number;
  probeConcurrency: number;
  udpRepeatMs: number;
  now: () => number;
  /** Called once per typed internet address that was confirmed as Sunshine (never for discovered hosts). */
  onRemoteHost?: (host: HostInfo, typed: string) => void;
}

export function localIPv4Interfaces(): Array<{ address: string; netmask: string }> {
  const out: Array<{ address: string; netmask: string }> = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateAddress(a.address) && !a.address.startsWith('169.254.')) out.push({ address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

export function defaultDiscoveryDeps(log: Logger): DiscoveryDeps {
  return {
    log,
    fetchServerInfo: (h, p, t) => fetchServerInfo(h, p, t),
    mdns: createBonjourBrowser(log),
    udpTargets: () => {
      const t = new Set<string>(['255.255.255.255']);
      for (const i of localIPv4Interfaces()) {
        const b = broadcastAddress(i.address, i.netmask);
        if (b) t.add(b);
      }
      return [...t];
    },
    agentPort: LANPLAY.agentPort,
    probeHosts: () => {
      const out: string[] = [];
      for (const i of localIPv4Interfaces()) out.push(...subnetHosts(i.address, i.netmask, 1024 - out.length));
      return out.slice(0, 1024);
    },
    tcpProbe,
    agentCheck: async (h, p) => {
      try {
        return (await httpGet(h, p, '/v1/info', 1500)).status === 200;
      } catch {
        return false;
      }
    },
    sunshinePort: SUNSHINE.httpPort,
    probeDelayMs: 3000,
    probeTimeoutMs: 300,
    probeConcurrency: 64,
    udpRepeatMs: 5000,
    now: Date.now,
  };
}

export class LanDiscovery implements DiscoveryService {
  private readonly hosts = new Map<string, HostInfo>();
  private readonly inflight = new Map<string, Promise<HostInfo | null>>();
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private udp: dgram.Socket | null = null;
  private onUpdate: ((hosts: HostInfo[]) => void) | null = null;
  private generation = 0;

  constructor(private readonly d: DiscoveryDeps) {}

  list(): HostInfo[] {
    return [...this.hosts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private emit(): void {
    try {
      this.onUpdate?.(this.list());
    } catch {
      /* ignore */
    }
  }

  start(onUpdate: (hosts: HostInfo[]) => void): void {
    this.stop();
    this.onUpdate = onUpdate;
    this.running = true;
    const gen = ++this.generation;
    this.d.log.log('info', 'discovery', 'start');
    this.d.mdns?.start((s) => {
      // mDNS answers are unauthenticated: never let one point LanPlay at an address outside the home network.
      for (const a of s.addresses) if ((net.isIPv4(a) || net.isIPv6(a)) && isPrivateAddress(a)) void this.confirm(a, 'mdns', s.name);
    });
    this.startUdp(gen);
    const t = setTimeout(() => {
      if (this.running && gen === this.generation && this.hosts.size === 0) void this.portProbe(gen);
    }, this.d.probeDelayMs);
    this.timers.push(t);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    for (const t of this.timers) clearTimeout(t), clearInterval(t);
    this.timers = [];
    this.d.mdns?.stop();
    if (this.udp) {
      try {
        this.udp.close();
      } catch {
        /* ignore */
      }
      this.udp = null;
    }
  }

  private startUdp(gen: number): void {
    const sock = dgram.createSocket({ type: 'udp4' });
    this.udp = sock;
    sock.on('error', (e) => this.d.log.log('warn', 'discovery', `UDP probe error: ${e.message}`));
    sock.on('message', (msg, rinfo) => {
      if (gen !== this.generation) return;
      try {
        const r = JSON.parse(msg.toString('utf8')) as AgentDiscoveryReply;
        if (r.magic !== LANPLAY.agentDiscoveryMagic) return;
        if (!isPrivateAddress(rinfo.address)) return;
        void this.confirm(rinfo.address, 'agent-udp', typeof r.hostName === 'string' ? r.hostName.slice(0, 64) : undefined, true);
      } catch {
        /* not ours */
      }
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        /* ignore */
      }
      const send = () => {
        if (gen !== this.generation) return;
        for (const t of this.d.udpTargets()) {
          sock.send(Buffer.from(LANPLAY.agentDiscoveryMagic), this.d.agentPort, t, (err) => {
            if (err) this.d.log.log('debug', 'discovery', `UDP send to ${t} failed: ${err.message}`);
          });
        }
      };
      send();
      const iv = setInterval(send, this.d.udpRepeatMs);
      this.timers.push(iv);
    });
  }

  private async portProbe(gen: number): Promise<void> {
    const hosts = this.d.probeHosts();
    this.d.log.log('info', 'discovery', `no host after ${this.d.probeDelayMs} ms: probing ${hosts.length} addresses on port ${this.d.sunshinePort}`);
    let i = 0;
    const worker = async () => {
      while (i < hosts.length && gen === this.generation) {
        const h = hosts[i++]!;
        if (await this.d.tcpProbe(h, this.d.sunshinePort, this.d.probeTimeoutMs)) void this.confirm(h, 'port-probe');
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.d.probeConcurrency, hosts.length) }, worker));
  }

  /** Confirm a discovered candidate via /serverinfo and merge it (by Sunshine uniqueid). Discovery sources never produce a remote host. */
  private confirm(addrIn: string, source: Exclude<DiscoverySource, 'manual'>, nameHint?: string, agentKnown = false): Promise<HostInfo | null> {
    const addr = normalizeAddress(addrIn);
    const key = `${addr}|${source}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      try {
        return await this.lookup(addr, source, { port: this.d.sunshinePort, remote: false, timeoutMs: 2500 }, nameHint, agentKnown);
      } catch (e) {
        this.d.log.log('debug', 'discovery', `candidate ${addr} (${source}) not confirmed: ${(e as Error).message}`);
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /** Throws when the address does not answer as Sunshine. A non-private address is only accepted for the 'manual' source. */
  private async lookup(addr: string, source: DiscoverySource, o: { port: number; remote: boolean; timeoutMs: number }, nameHint?: string, agentKnown = false): Promise<HostInfo> {
    if (source !== 'manual' && !isPrivateAddress(addr)) throw new Error(`${addr} is not a private address`);
    const info = await this.d.fetchServerInfo(addr, o.port, o.timeoutMs);
    const agentReachable = o.remote ? false : agentKnown ? true : await this.d.agentCheck(addr, this.d.agentPort);
    return this.merge(addr, source, info, nameHint, agentReachable, o.port, o.remote);
  }

  private merge(addr: string, source: DiscoverySource, info: ServerInfo, nameHint: string | undefined, agentReachable: boolean, port: number, remote: boolean): HostInfo {
    // An internet host is its own entry per typed address: LAN discovery never merges into it, and it never becomes a LAN entry's address.
    const id = remote ? `remote:${formatHostPort(addr, port)}` : info.uniqueId ? info.uniqueId : `addr:${addr}`;
    const prev = this.hosts.get(id);
    const addresses = remote ? [addr] : [...new Set([...(prev?.addresses ?? []), addr])].sort((a, b) => Number(net.isIPv6(a)) - Number(net.isIPv6(b)));
    const host: HostInfo = {
      id,
      name: info.hostname || nameHint || prev?.name || addr,
      addresses,
      preferredAddress: remote ? addr : prev?.preferredAddress && addresses.includes(prev.preferredAddress) && net.isIPv4(prev.preferredAddress) ? prev.preferredAddress : (addresses[0] ?? addr),
      sources: [...new Set([...(prev?.sources ?? []), source])],
      httpPort: port,
      agentReachable: agentReachable || prev?.agentReachable === true,
      lastSeen: new Date(this.d.now()).toISOString(),
    };
    if (remote) host.remote = true;
    if (info.serverCodecModeSupport !== undefined) host.serverCodecModeSupport = info.serverCodecModeSupport;
    if (prev?.paired !== undefined) host.paired = prev.paired;
    // A manual entry is what the user typed: prefer it.
    if (source === 'manual') host.preferredAddress = addr;
    const isNew = !prev;
    this.hosts.set(id, host);
    if (isNew) this.d.log.log('info', 'discovery', `found ${host.name} at ${addr} via ${source}`, { id, agentReachable, remote, scms: info.serverCodecModeSupport ?? null });
    this.emit();
    return host;
  }

  /** Update fields the service learns later (paired state). */
  patch(id: string, patch: Partial<Pick<HostInfo, 'paired' | 'agentReachable' | 'preferredAddress'>>): void {
    const h = this.hosts.get(id);
    if (!h) return;
    Object.assign(h, patch);
    this.emit();
  }

  get(id: string): HostInfo | undefined {
    return this.hosts.get(id);
  }

  /** The only way a non-private address enters the host list: the user typed it. */
  async addManual(address: string): Promise<HostInfo> {
    const a = String(address ?? '').trim();
    const bad = 'Enter an IP address like 192.168.1.20 or a PC name.';
    if (!a || a.length > 253 || /[\s/\\@?#]/.test(a)) throw new Error(bad);
    const hp = parseHostPort(a);
    if (!hp) throw new Error(bad);
    let ip = normalizeAddress(hp.host);
    if (!net.isIP(ip)) {
      if (!/^[A-Za-z0-9.-]+$/.test(hp.host)) throw new Error(bad);
      try {
        const r = await dns.lookup(hp.host, { family: 0, all: true });
        const v4 = r.find((x) => x.family === 4) ?? r[0];
        if (!v4) throw new Error('no address');
        ip = normalizeAddress(v4.address);
      } catch {
        throw new Error(`Could not find a computer named "${hp.host}". Try its IP address.`);
      }
    }
    const remote = isRemoteAddress(ip);
    const port = hp.port ?? this.d.sunshinePort;
    if (!remote && hp.port !== null && hp.port !== this.d.sunshinePort) throw new Error('Custom ports are only supported for internet addresses. Use the plain IP.');
    const timeoutMs = remote ? 5000 : 2500;
    let host: HostInfo;
    try {
      host = await this.lookup(ip, 'manual', { port, remote, timeoutMs });
    } catch (e) {
      this.d.log.log('debug', 'discovery', `manual ${ip}:${port} not confirmed: ${(e as Error).message}`);
      if (remote) throw new Error(describeInternetProbeError(e, ip, port));
      throw new Error(`No Sunshine host answered at ${ip}:${port}. Is LanPlay set up on the PC and is the PC on?`);
    }
    if (remote) {
      try {
        this.d.onRemoteHost?.(host, a);
      } catch (e) {
        this.d.log.log('warn', 'discovery', `onRemoteHost failed: ${(e as Error).message}`);
      }
    }
    return host;
  }
}
