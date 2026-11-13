// Runs the real wrappers with the pinned portable pwsh 7.7 (macOS). Windows-only cmdlets are missing here, so this
// checks the CONTRACT that matters for TypeScript: whatever happens, each wrapper prints exactly one JSON object
// (pure ASCII, non-ASCII escaped) and exits 0/1/2. Skipped when pwsh is not fetched.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const PWSH = path.join(ROOT, 'vendor', 'pwsh-macos', 'pwsh-7.7.0', 'pwsh');
const DIR = path.join(ROOT, 'scripts', 'windows');
const has = existsSync(PWSH);

function run(script: string, args: string[]) {
  const r = spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(DIR, script), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!has)('PowerShell wrappers (pwsh 7.7 runtime smoke test)', () => {
  const cases: Array<[string, string[], number[]]> = [
    ['test-admin.ps1', [], [0, 1]],
    ['get-sunshine-facts.ps1', [], [0, 1]],
    ['get-system-info.ps1', [], [0, 1]],
    ['get-listeners.ps1', ['-Ports', '47984,47989'], [0, 1]],
    ['get-listeners.ps1', ['-Ports', 'äh'], [2]],
    ['get-firewall-rules.ps1', ['-Names', ' , '], [2]],
    ['get-firewall-rules.ps1', ['-Names', 'Sunshine,LanPlay Pair Agent'], [0, 1]],
    ['set-agent-firewall-rule.ps1', ['-Port', '0', '-Name', 'x'], [2]],
    ['invoke-elevated.ps1', ['-FilePath', PWSH, '-ArgumentListB64', '!!notbase64!!'], [2]],
    ['invoke-elevated.ps1', ['-FilePath', PWSH, '-ArgumentListB64', Buffer.from(JSON.stringify(['--version', '"C:\\Users\\J\u00f6rg M\u00fcller\\x"'])).toString('base64')], [1]],
  ];
  it.each(cases)('%s %j prints one JSON object', (script, args, codes) => {
    const r = run(script, args);
    expect(codes, `exit ${r.code} stderr=${r.stderr}`).toContain(r.code);
    const out = r.stdout.trim();
    expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
    const v = JSON.parse(out);
    expect(typeof v).toBe('object');
    if (r.code !== 0) expect(typeof v.error).toBe('string');
    if (args[1] === 'äh') expect(out).toContain('\\u00e4');
  });

  it('every wrapper is covered', () => {
    const scripts = readdirSync(DIR).filter((f) => f.endsWith('.ps1'));
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(scripts));
  });

  it('check-ps rejects PS7-only syntax and missing wrapper rules', () => {
    const bad = path.join(ROOT, 'tests', 'fixtures', 'ps', 'bad-ps7.ps1');
    const out = execFileSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'scripts', 'check-ps.ps1'), '-Files', bad, '-WrapperFiles', bad], { encoding: 'utf8' });
    const res = JSON.parse(out).results;
    const r = Array.isArray(res) ? res[0] : res;
    expect(r.ok).toBe(false);
    const text = r.problems.join('\n');
    expect(text).toMatch(/TernaryExpressionAst/);
    expect(text).toMatch(/PipelineChainAst/);
    expect(text).toMatch(/BinaryExpressionAst/);
    expect(text).toMatch(/MemberExpressionAst/);
    expect(text).toMatch(/Set-StrictMode/);
    expect(text).toMatch(/bare exit/);
  });
});
