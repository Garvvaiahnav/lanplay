// Address helpers for the pair agent guard (contracts: NormalizeAddress, IsPrivateAddress).
import net from 'node:net';
import type { IsPrivateAddress, NormalizeAddress } from '../../contracts.js';

/** "::ffff:192.168.1.5" -> "192.168.1.5"; "[fe80::1%en0]" -> "fe80::1"; IPv6 lower-cased. Non-IP input is returned trimmed. */
export const normalizeAddress: NormalizeAddress = (addr) => {
  let a = String(addr ?? '').trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const pct = a.indexOf('%');
  if (pct >= 0 && a.includes(':')) a = a.slice(0, pct);
  a = a.toLowerCase();
  if (net.isIPv6(a)) {
    const g = expandIPv6(a);
    if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
    }
  }
  return a;
};

/** "::ffff:1.2.3.4" / "fe80::1" -> 8 numeric groups; null if malformed. */
export function expandIPv6(a: string): number[] | null {
  let s = a;
  const m = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (m) {
    if (!net.isIPv4(m[2]!)) return null;
    const o = m[2]!.split('.').map(Number);
    s = `${m[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === '' ? [] : h.split(':').map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)));
  const head = parse(halves[0]!);
  const tailG = halves.length === 2 ? parse(halves[1]!) : [];
  if ([...head, ...tailG].some((x) => Number.isNaN(x))) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tailG.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tailG];
}

const privateList = new net.BlockList();
privateList.addSubnet('10.0.0.0', 8, 'ipv4');
privateList.addSubnet('172.16.0.0', 12, 'ipv4');
privateList.addSubnet('192.168.0.0', 16, 'ipv4');
privateList.addSubnet('169.254.0.0', 16, 'ipv4');
privateList.addSubnet('127.0.0.0', 8, 'ipv4');
privateList.addAddress('::1', 'ipv6');
privateList.addSubnet('fe80::', 10, 'ipv6');
privateList.addSubnet('fc00::', 7, 'ipv6');

/** RFC1918 + link-local + loopback (v4 and v6) + ULA. Unparsable -> false. */
export const isPrivateAddress: IsPrivateAddress = (addr) => {
  const a = normalizeAddress(addr);
  if (net.isIPv4(a)) return privateList.check(a, 'ipv4');
  if (net.isIPv6(a)) return privateList.check(a, 'ipv6');
  return false;
};

/** A valid IP literal that is not private/loopback/link-local/ULA (100.64.0.0/10 and other overlay ranges count as remote). */
export function isRemoteAddress(addr: string): boolean {
  const a = normalizeAddress(addr);
  return net.isIP(a) !== 0 && !isPrivateAddress(a);
}

/**
 * What a player types into "Connect by IP": `1.2.3.4`, `1.2.3.4:47989`, `[2001:db8::1]:47989`, `[2001:db8::1]`,
 * bare `2001:db8::1`, `name`, `name:port`. Host comes back lower-cased without brackets. null if malformed
 * (empty host, port not 1-65535, brackets around a non-IPv6, several colons that are not an IPv6 literal).
 */
export function parseHostPort(input: string): { host: string; port: number | null } | null {
  const v = String(input ?? '').trim();
  if (!v || v.length > 255) return null;
  let host: string;
  let portStr: string | undefined;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end < 0) return null;
    host = v.slice(1, end);
    if (!net.isIPv6(host)) return null;
    const rest = v.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      portStr = rest.slice(1);
    }
  } else {
    const parts = v.split(':');
    if (parts.length === 1) host = v;
    else if (parts.length === 2) {
      host = parts[0]!;
      portStr = parts[1];
    } else {
      if (!net.isIPv6(v)) return null;
      host = v;
    }
  }
  if (!host) return null;
  let port: number | null = null;
  if (portStr !== undefined) {
    if (!/^\d{1,5}$/.test(portStr)) return null;
    port = Number(portStr);
    if (port < 1 || port > 65535) return null;
  }
  return { host: host.toLowerCase(), port };
}

/** "host:port" or "[v6]:port" -> parts; null if malformed. */
export function parseHostHeader(h: string | undefined): { host: string; port: number | null } | null {
  if (!h) return null;
  const v = h.trim();
  if (!v || v.length > 255) return null;
  let host: string;
  let portStr: string | undefined;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end < 0) return null;
    host = v.slice(1, end);
    const rest = v.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      portStr = rest.slice(1);
    }
  } else {
    const parts = v.split(':');
    if (parts.length > 2) return null; // bare IPv6 without brackets is not a valid Host header
    host = parts[0]!;
    portStr = parts[1];
  }
  let port: number | null = null;
  if (portStr !== undefined) {
    if (!/^\d{1,5}$/.test(portStr)) return null;
    port = Number(portStr);
    if (port < 1 || port > 65535) return null;
  }
  return { host: host.toLowerCase(), port };
}

/** IPv4 addresses on the same subnet as each interface (capped). Used for the 47989 port-probe fallback. */
export function subnetHosts(ip: string, netmask: string, cap: number): string[] {
  if (!net.isIPv4(ip) || !net.isIPv4(netmask)) return [];
  const toInt = (s: string) => s.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const toIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  let mask = toInt(netmask);
  // Large subnets: only probe the /24 around our own address.
  const prefix = mask.toString(2).replace(/0+$/, '').length;
  if (prefix < 22) mask = 0xffffff00;
  const me = toInt(ip);
  const base = (me & mask) >>> 0;
  const size = (~mask >>> 0) + 1;
  const out: string[] = [];
  for (let i = 1; i < size - 1 && out.length < cap; i++) {
    const n = (base + i) >>> 0;
    if (n !== me) out.push(toIp(n));
  }
  return out;
}

/** Directed broadcast address for an IPv4 interface. */
export function broadcastAddress(ip: string, netmask: string): string | null {
  if (!net.isIPv4(ip) || !net.isIPv4(netmask)) return null;
  const a = ip.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((o, i) => (o | (~m[i]! & 255)) & 255).join('.');
}
