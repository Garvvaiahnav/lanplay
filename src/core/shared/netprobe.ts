// Small network probes used by steps, self-check and diagnostics.
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import type { PeerCertificate } from 'node:tls';
import { X509Certificate } from 'node:crypto';

/** TCP connect test. */
export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

/**
 * TLS connect with the SAME verification the REST client uses (ca=[pem], rejectUnauthorized, fingerprint pin).
 * ok=false with the TLS error code when the server certificate is not the pinned one.
 */
export function tlsPinCheck(host: string, port: number, pem: string, timeoutMs: number): Promise<{ ok: boolean; error?: string; fingerprint256?: string }> {
  let expected: string;
  try {
    expected = new X509Certificate(pem).fingerprint256;
  } catch (e) {
    return Promise.resolve({ ok: false, error: `pinned certificate unreadable: ${(e as Error).message}` });
  }
  return new Promise((resolve) => {
    let seen: string | undefined;
    const s = tls.connect({
      host,
      port,
      ca: [pem],
      rejectUnauthorized: true,
      checkServerIdentity: (_h: string, cert: PeerCertificate) => {
        seen = cert?.fingerprint256;
        return seen === expected ? undefined : new Error(`fingerprint ${seen ?? 'none'} != pinned ${expected}`);
      },
    });
    let done = false;
    const finish = (r: { ok: boolean; error?: string; fingerprint256?: string }) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(r);
    };
    s.setTimeout(timeoutMs, () => finish({ ok: false, error: 'timeout' }));
    s.once('secureConnect', () => finish({ ok: true, fingerprint256: expected }));
    s.once('error', (e: NodeJS.ErrnoException) => finish({ ok: false, error: `${e.code ?? ''} ${e.message}`.trim(), ...(seen ? { fingerprint256: seen } : {}) }));
  });
}

/** Plain HTTP GET returning status + parsed JSON (agent / serverinfo). Never sends Origin/Referer. */
export function httpGet(host: string, port: number, path: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const hostHeader = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    const req = http.request({ host, port, path, method: 'GET', headers: { Host: hostHeader, Accept: 'application/json, text/xml' }, setHost: false, timeout: timeoutMs, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size < 1024 * 1024) chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/** Send one UDP datagram and wait for the first reply. */
export function udpQuery(host: string, port: number, payload: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    const t = setTimeout(() => {
      sock.close();
      resolve(null);
    }, timeoutMs);
    sock.on('message', (m) => {
      clearTimeout(t);
      sock.close();
      resolve(m.toString('utf8'));
    });
    sock.on('error', () => {
      clearTimeout(t);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve(null);
    });
    sock.send(Buffer.from(payload), port, host);
  });
}
