#!/usr/bin/env node
// Fake moonlight-qt CLI for tests, run as: node fake-moonlight.mjs <moonlight argv...>
// (MoonlightRunnerOptions.prefixArgs = [this file], binary = process.execPath).
// Behaviour copied from moonlight-qt v6.2.0:
//  - `pair <host> --pin dddd`: registers a pending pairing on the host (here: the mock Sunshine test hook, like
//    Sunshine's nvhttp would on Moonlight's first pairing request) and stays open until terminated (the real one keeps
//    its window open until the dialog is closed, CliPair.qml). "PIN must be 4 digits" otherwise (commandlineparser.cpp).
//  - `list <host>`: exit 0 when paired, "Computer %1 has not been paired." + exit -1 (255) otherwise (listapps.cpp#L100-L112).
//  - `stream ...`: records argv and exits 0.
// Env: FAKE_ML_STATE (JSON state file, required), FAKE_ML_HOOK (mock Sunshine hook base URL),
//      FAKE_ML_ADDRESS (address Sunshine "sees", default 127.0.0.1), FAKE_ML_MODE (normal|crash|no-register|ignore-term).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const stateFile = process.env.FAKE_ML_STATE;
if (!stateFile) {
  console.error('FAKE_ML_STATE not set');
  process.exit(1);
}
const load = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { paired: {}, calls: [], streams: [] });
const save = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2));
const mode = process.env.FAKE_ML_MODE ?? 'normal';
const argv = process.argv.slice(2);
const st = load();
st.calls.push(argv);
save(st);

const [cmd, host] = argv;

if (cmd === 'list') {
  if (load().paired[host]) {
    console.log('Desktop\nSteam Big Picture');
    process.exit(0);
  }
  console.error(`Computer ${host} has not been paired.`);
  process.exit(255);
}

if (cmd === 'stream') {
  const s = load();
  s.streams.push(argv);
  save(s);
  setTimeout(() => process.exit(0), Number(process.env.FAKE_ML_STREAM_MS ?? 0));
} else if (cmd === 'pair') {
  const i = argv.indexOf('--pin');
  const pin = i >= 0 ? argv[i + 1] : undefined;
  if (!pin || !/^\d{4}$/.test(pin)) {
    console.error('PIN must be 4 digits');
    process.exit(1);
  }
  if (mode === 'crash') {
    console.error('Failed to connect to host');
    process.exit(1);
  }
  const hook = process.env.FAKE_ML_HOOK;
  const address = process.env.FAKE_ML_ADDRESS ?? '127.0.0.1';
  let pendingId = null;
  if (hook && mode !== 'no-register') {
    const r = await fetch(`${hook}/hook/pair`, { method: 'POST', body: JSON.stringify({ address, name: 'Moonlight', pin }) });
    pendingId = (await r.json()).id;
  }
  // Watch the host: once our pending pairing is gone and a client exists, the handshake completed.
  const iv = setInterval(async () => {
    if (!hook || !pendingId) return;
    try {
      const s = await (await fetch(`${hook}/hook/state`)).json();
      if (!s.pending.some((p) => p.id === pendingId) && s.clients.length > 0) {
        const cur = load();
        cur.paired[host] = true;
        save(cur);
        pendingId = null;
      }
    } catch {
      /* host gone */
    }
  }, 50);
  process.on('SIGTERM', () => {
    if (mode === 'ignore-term') return;
    clearInterval(iv);
    process.exit(0);
  });
  setInterval(() => {}, 1 << 30);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}
