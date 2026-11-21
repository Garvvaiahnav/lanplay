// 0.5 W2: the internet switch on a Mac host. No firewall rule exists there: only sunshine.conf (UPnP, IPv6) and a restart.
import { afterEach, describe, expect, it } from 'vitest';
import { MAC_HOST_STEP_ORDER } from '../../src/contracts.js';
import type { SecretKey, SecretStore, ServiceDeps } from '../../src/contracts.js';
import { INTERNET_KEY } from '../../src/core/host/agent.js';
import { MacHostService } from '../../src/core/host/mac/service-mac.js';
import type { MacHostServiceExtras } from '../../src/core/host/mac/service-mac.js';
import { sunshinePaths } from '../../src/core/host/mac/sunshine-mac.js';
import { parseSunshineConf } from '../../src/core/host/sunshine-conf.js';
import { certFingerprint256, createSunshineClient } from '../../src/core/host/sunshine-client.js';
import { MemoryLogger } from '../../src/core/shared/logger.js';
import { MemoryStore } from '../../src/core/shared/stores.js';
import { BUNDLED, FakeMacHost, HOME, LOGS, PATHS, SELF_EXE, SHARED } from '../fixtures/fake-mac-host.js';
import { startMockSunshine, SUNSHINE_TEST_CERT } from '../fixtures/mock-sunshine.js';
import type { MockSunshine } from '../fixtures/mock-sunshine.js';

const P = sunshinePaths(SHARED, LOGS);

let mock: MockSunshine | undefined;
const services: MacHostService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.agent.stop();
  await mock?.close();
  mock = undefined;
});

class MemorySecrets implements SecretStore {
  readonly m = new Map<string, string>();
  async get(k: SecretKey) {
    return this.m.get(k) ?? null;
  }
  async set(k: SecretKey, v: string) {
    this.m.set(k, v);
  }
  async delete(k: SecretKey) {
    this.m.delete(k);
  }
  backend(): 'file-0600' {
    return 'file-0600';
  }
}

function makeService(m: FakeMacHost, extra: Partial<MacHostServiceExtras> = {}) {
  const secrets = new MemorySecrets();
  const settings = new MemoryStore();
  const deps: ServiceDeps = { log: new MemoryLogger(), paths: PATHS, secrets, settings, runner: m };
  const svc = new MacHostService(deps, {
    selfExe: SELF_EXE,
    selfArgsPrefix: [],
    home: HOME,
    uid: 501,
    macOS: m.macOS,
    bundledApp: BUNDLED,
    agentPort: 0,
    agentExtra: { bindAddress: '127.0.0.1', udp: false, ledger: new MemoryStore() },
    localIdentity: () => ({ hostName: 'Mac-mini', addresses: ['127.0.0.1'] }),
    networkInterfaces: () => ({
      en0: [{ address: '192.168.1.30', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '192.168.1.30/24' }],
    }),
    stepsEnv: {
      ...m.fs(),
      createSunshineClient: (o) => createSunshineClient({ ...o, baseUrl: mock!.url }),
      tcpProbe: m.tcpProbe,
      tlsPinCheck: async (_h, _p, pem) => ({ ok: pem === SUNSHINE_TEST_CERT }),
      fingerprint: certFingerprint256,
      sleep: async () => undefined,
      timing: { launchWaitMs: 0, screenWaitMs: 0, webUiWaitMs: 0, pollMs: 0 },
    },
    ...extra,
  });
  services.push(svc);
  return { svc, secrets, settings, m };
}

async function setUp() {
  const m = new FakeMacHost();
  m.screenPermission = true;
  const s = makeService(m);
  mock = await startMockSunshine({ password: 'x' });
  const realSet = s.secrets.set.bind(s.secrets);
  s.secrets.set = async (k, v) => {
    await realSet(k, v);
    mock!.setPassword(v);
  };
  await s.svc.runSetup(() => undefined);
  return s;
}

const conf = (m: FakeMacHost) => parseSunshineConf(m.files.get(P.conf) ?? '');
const kickstarts = (m: FakeMacHost) => m.calls.filter((c) => c.args[0] === 'kickstart');

describe('MacHostService: internet switch', () => {
  it('is off by default and the first setup writes the off values (D08/D09)', async () => {
    const s = await setUp();
    expect(await s.svc.getInternet()).toEqual({ enabled: false, lanAddresses: ['192.168.1.30'], globalIpv6: [] });
    expect(conf(s.m)).toMatchObject({ origin_web_ui_allowed: 'pc', upnp: 'disabled', address_family: 'ipv4' });
  });

  it('on: rewrites sunshine.conf, restarts Sunshine because the conf changed, adds no firewall step; off puts it back', async () => {
    const s = await setUp();
    s.m.calls.length = 0;
    const progress: string[] = [];
    const on = await s.svc.setInternet(true, (r) => progress.push(r.stepId));
    expect(on).toEqual({ enabled: true, lanAddresses: ['192.168.1.30'], globalIpv6: [] });
    expect(s.settings.get<boolean>(INTERNET_KEY, false)).toBe(true);
    expect(conf(s.m)).toMatchObject({ origin_web_ui_allowed: 'pc', upnp: 'enabled', address_family: 'both' });
    expect(kickstarts(s.m)).toHaveLength(1);
    expect(progress).toContain('config');
    expect(progress).not.toContain('firewall-internet');
    expect((await s.svc.setupStatus()).steps.map((x) => x.stepId)).toEqual([...MAC_HOST_STEP_ORDER]);
    // the self-check agrees with the conf
    expect((await s.svc.selfCheck()).steps.find((x) => x.stepId === 'config')!.status).toBe('pass');

    // same position again: nothing to write, no restart
    s.m.calls.length = 0;
    await s.svc.setInternet(true, () => undefined);
    expect(kickstarts(s.m)).toHaveLength(0);

    s.m.calls.length = 0;
    const off = await s.svc.setInternet(false, () => undefined);
    expect(off.enabled).toBe(false);
    expect(conf(s.m)).toMatchObject({ upnp: 'disabled', address_family: 'ipv4' });
    expect(kickstarts(s.m)).toHaveLength(1);
    expect((await s.svc.selfCheck()).steps.find((x) => x.stepId === 'config')!.status).toBe('pass');
  });

  it('the config probe fails while the switch and the file disagree', async () => {
    const s = await setUp();
    s.settings.set(INTERNET_KEY, true);
    expect((await s.svc.selfCheck()).steps.find((x) => x.stepId === 'config')!.status).toBe('fail');
  });

  it('puts the switch back when Sunshine does not come back (another Sunshine holds the ports)', async () => {
    const s = await setUp();
    s.m.loaded = false;
    s.m.pid = null;
    s.m.foreignListener = true;
    const st = await s.svc.setInternet(true, () => undefined);
    expect(st.enabled).toBe(false);
    expect(st.lastError).toMatch(/Another Sunshine is running/);
    expect(s.settings.get<boolean>(INTERNET_KEY, true)).toBe(false);
    // the second run could not restart Sunshine either: said in the error, the conf is back at the off values
    expect(st.lastError).toMatch(/Turning the settings back off also failed/);
    expect(conf(s.m)).toMatchObject({ upnp: 'disabled', address_family: 'ipv4' });
  });

  it('a failing launch step after the conf was written leaves the conf at the off values, not at on', async () => {
    const s = await setUp();
    s.m.loaded = false;
    s.m.pid = null;
    s.m.foreignListener = true;
    const st = await s.svc.setInternet(true, () => undefined);
    expect(st.enabled).toBe(false);
    expect(conf(s.m)).toMatchObject({ upnp: 'disabled', address_family: 'ipv4' });
    // once Sunshine can start again the next switch-on works and the file follows the switch
    s.m.foreignListener = false;
    const again = await s.svc.setInternet(true, () => undefined);
    expect(again.enabled).toBe(true);
    expect(again.lastError).toBeUndefined();
    expect(conf(s.m)).toMatchObject({ upnp: 'enabled', address_family: 'both' });
  });
});
