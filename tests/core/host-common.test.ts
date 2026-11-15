import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { PairAgent } from '../../src/contracts.js';
import { generateAdminPassword, probeAgent } from '../../src/core/host/common.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

describe('generateAdminPassword', () => {
  it('is long, starts alphanumeric and differs per call', () => {
    const a = generateAdminPassword();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    expect(generateAdminPassword()).not.toBe(a);
  });
});

describe('probeAgent', () => {
  it('reports http ok and no UDP reply for a plain HTTP listener', async () => {
    server = createServer((_req, res) => res.end('{"ok":true}'));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const r = await probeAgent({ getState: () => ({ port }) } as unknown as PairAgent);
    expect(r.http).toBe(true);
    expect(r.udp).toBe(false);
    expect(r.detail).toContain('GET /v1/info -> 200');
    expect(r.detail).toContain('UDP discovery: no reply');
  });
});
