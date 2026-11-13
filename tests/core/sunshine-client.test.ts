import { afterEach, describe, expect, it } from 'vitest';
import { SunshineApiError } from '../../src/contracts.js';
import type { RestCallRecord } from '../../src/contracts.js';
import { certFingerprint256, createSunshineClient } from '../../src/core/host/sunshine-client.js';
import { startMockSunshine, SUNSHINE_TEST_CERT, WRONG_TEST_CERT } from '../fixtures/mock-sunshine.js';
import type { MockSunshine } from '../fixtures/mock-sunshine.js';

let mock: MockSunshine | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function client(m: MockSunshine, password = 'test-password-0123456789', pem = SUNSHINE_TEST_CERT, calls: RestCallRecord[] = []) {
  return createSunshineClient({ baseUrl: m.url, username: 'lanplay', getPassword: async () => password, pinnedCertPem: pem, timeoutMs: 5000, onCall: (r) => calls.push(r) });
}

describe('SunshineClient against the mock Sunshine', () => {
  it('lists, pairs with pairing_id, unpairs; never sends Origin/Referer', async () => {
    mock = await startMockSunshine();
    const calls: RestCallRecord[] = [];
    const c = client(mock, undefined, undefined, calls);
    const p = mock.addPending({ name: 'Mac mini', address: '192.168.1.20', expectedPin: '4821' });
    const pend = await c.getPendingPairings();
    expect(pend).toEqual([{ id: p.id, name: 'Mac mini', address: '192.168.1.20' }]);
    expect(await c.submitPin({ pairingId: p.id, pin: '4821', name: 'Mac mini' })).toBe(true);
    const list = await c.listClients();
    expect(list).toHaveLength(1);
    expect(await c.unpairClient(list[0]!.uuid)).toBe(true);
    expect(await c.listClients()).toHaveLength(0);
    expect(await c.getVersion()).toBe('2026.914.233613');
    expect(await c.getLogsTail(20)).toHaveLength(20);
    for (const r of mock.requests) {
      expect(r.headers.origin).toBeUndefined();
      expect(r.headers.referer).toBeUndefined();
    }
    const post = mock.requests.find((r) => r.method === 'POST' && r.url === '/api/pin')!;
    expect(post.headers['content-type']).toBe('application/json');
    expect(JSON.parse(post.body)).toEqual({ pairing_id: p.id, pin: '4821', name: 'Mac mini' });
    // REST records are redacted
    const rec = calls.find((x) => x.method === 'POST' && x.url.endsWith('/api/pin'))!;
    expect(rec.requestBody).not.toContain('4821');
    expect(rec.requestBody).not.toContain(p.id);
    expect(JSON.stringify(calls)).not.toContain('test-password-0123456789');
  });

  it('returns false on a wrong PIN', async () => {
    mock = await startMockSunshine();
    const p = mock.addPending({ name: 'Mac', address: '10.0.0.5', expectedPin: '1111' });
    expect(await client(mock).submitPin({ pairingId: p.id, pin: '2222', name: 'Mac' })).toBe(false);
  });

  it('validates input before sending', async () => {
    mock = await startMockSunshine();
    const c = client(mock);
    await expect(c.submitPin({ pairingId: 'xyz', pin: '1234', name: 'a' })).rejects.toMatchObject({ kind: 'bad-request' });
    await expect(c.submitPin({ pairingId: 'a'.repeat(32), pin: '12345', name: 'a' })).rejects.toMatchObject({ kind: 'bad-request' });
    await expect(c.submitPin({ pairingId: 'a'.repeat(32), pin: '1234', name: 'x'.repeat(129) })).rejects.toMatchObject({ kind: 'bad-request' });
    expect(mock.requests).toHaveLength(0);
  });

  it('maps auth errors: 401 and 307 /welcome', async () => {
    mock = await startMockSunshine();
    await expect(client(mock, 'wrong').listClients()).rejects.toMatchObject({ kind: 'auth', status: 401 });
    mock.setNoUser(true);
    await expect(client(mock).listClients()).rejects.toMatchObject({ kind: 'redirect-welcome', status: 307 });
  });

  it('maps 403 origin refusal', async () => {
    mock = await startMockSunshine({ forbidOrigin: true });
    await expect(client(mock).listClients()).rejects.toMatchObject({ kind: 'forbidden-origin' });
  });

  it('refuses a server whose certificate is not the pinned one', async () => {
    mock = await startMockSunshine({ wrongCert: true });
    const err = await client(mock).listClients().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SunshineApiError);
    expect((err as SunshineApiError).kind).toBe('tls-pin-mismatch');
    expect(mock.requests).toHaveLength(0);
  });

  it('pins by fingerprint even if the wrong cert is passed as CA', async () => {
    mock = await startMockSunshine();
    const err = await client(mock, undefined, WRONG_TEST_CERT).listClients().catch((e: unknown) => e);
    expect((err as SunshineApiError).kind).toBe('tls-pin-mismatch');
  });

  it('reports network errors', async () => {
    const c = createSunshineClient({ baseUrl: 'https://127.0.0.1:1', username: 'lanplay', getPassword: async () => 'x', pinnedCertPem: SUNSHINE_TEST_CERT, timeoutMs: 2000 });
    await expect(c.listClients()).rejects.toMatchObject({ kind: 'network' });
    expect(() => createSunshineClient({ baseUrl: 'http://127.0.0.1:47990', username: 'u', getPassword: async () => 'x', pinnedCertPem: SUNSHINE_TEST_CERT, timeoutMs: 1 })).toThrow();
  });

  it('computes colon-hex fingerprints', () => {
    expect(certFingerprint256(SUNSHINE_TEST_CERT)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(certFingerprint256(SUNSHINE_TEST_CERT)).not.toBe(certFingerprint256(WRONG_TEST_CERT));
  });
});
