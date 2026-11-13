// Redactor: masks secrets (passwords, PINs, pairing ids, Authorization headers, --creds/--pin argv values)
// in every string that reaches a log file, a StepRecord, a RestCallRecord or the diagnostics zip.
import type { Redactor } from '../../contracts.js';

export const REDACTED = '[REDACTED]';

/** JSON keys whose values are always masked (case-insensitive). */
const SECRET_KEYS = ['password', 'pin', 'pairing_id', 'pairingid', 'sunshineadminpassword', 'authorization', 'secret', 'token'];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class DefaultRedactor implements Redactor {
  private readonly secrets = new Set<string>();
  private compiled: RegExp | null = null;

  addSecret(value: string): void {
    if (typeof value !== 'string') return;
    const v = value.trim();
    // Very short values would mask unrelated text; a PIN is 4 digits and is matched only as a whole number.
    if (v.length < 4 || this.secrets.has(v)) return;
    this.secrets.add(v);
    this.compiled = null;
  }

  private literalPattern(): RegExp | null {
    if (this.secrets.size === 0) return null;
    if (this.compiled) return this.compiled;
    const parts = [...this.secrets]
      .sort((a, b) => b.length - a.length)
      .map((s) => (/^\d{4,6}$/.test(s) ? `(?<![0-9])${escapeRegExp(s)}(?![0-9])` : escapeRegExp(s)));
    this.compiled = new RegExp(parts.join('|'), 'g');
    return this.compiled;
  }

  redact(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return text;
    let out = text;
    const lit = this.literalPattern();
    if (lit) out = out.replace(lit, REDACTED);
    // Authorization: Basic xxx / "authorization":"Basic xxx"
    out = out.replace(/(authorization\\?["']?\s*[:=]\s*\\?["']?)(?:basic|bearer)?\s*[^"'\\\s,}]+/gi, `$1${REDACTED}`);
    // "password":"..." , \"pin\":\"1234\" (also escaped inside nested JSON strings), and numeric values.
    const keyAlt = SECRET_KEYS.map(escapeRegExp).join('|');
    out = out.replace(new RegExp(`(\\\\?"(?:${keyAlt})\\\\?"\\s*:\\s*)(\\\\?")(.*?)(\\\\?")`, 'gi'), `$1$2${REDACTED}$4`);
    out = out.replace(new RegExp(`(\\\\?"(?:${keyAlt})\\\\?"\\s*:\\s*)(\\d+)`, 'gi'), `$1"${REDACTED}"`);
    // CLI forms in free text: --creds user pass ; --pin 1234 ; --pin=1234
    out = out.replace(/(--creds\s+\S+\s+)\S+/g, `$1${REDACTED}`);
    out = out.replace(/(--pin(?:\s+|=))\S+/g, `$1${REDACTED}`);
    // user:pass@ in URLs
    out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`);
    return out;
  }

  redactArgv(argv: readonly string[]): string[] {
    const out = argv.map((a) => String(a));
    for (let i = 0; i < out.length; i++) {
      const a = out[i]!;
      if (a === '--creds') {
        // --creds <user> <password>: the user name is not secret, the password is.
        if (i + 2 < out.length) out[i + 2] = REDACTED;
      } else if (a === '--pin') {
        if (i + 1 < out.length) out[i + 1] = REDACTED;
      } else if (a.startsWith('--pin=')) {
        out[i] = `--pin=${REDACTED}`;
      }
    }
    return out.map((a) => (a === REDACTED ? a : this.redact(a)));
  }

  /** Deep copy with secret keys masked and every string redacted. Safe for any JSON-like value. */
  redactValue<T>(value: T): T {
    return redactDeep(value, this, 0) as T;
  }
}

function redactDeep(v: unknown, r: DefaultRedactor, depth: number): unknown {
  if (depth > 20) return '[TRUNCATED]';
  if (typeof v === 'string') return r.redact(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, r, depth + 1));
  if (v && typeof v === 'object') {
    if (v instanceof Error) return { name: v.name, message: r.redact(v.message) };
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEYS.includes(k.toLowerCase()) && val !== undefined && val !== null && val !== '') out[k] = REDACTED;
      else out[k] = redactDeep(val, r, depth + 1);
    }
    return out;
  }
  return v;
}

/** Convenience: works with any Redactor (uses DefaultRedactor.redactValue when available). */
export function redactValue<T>(r: Redactor, value: T): T {
  if (r instanceof DefaultRedactor) return r.redactValue(value);
  return JSON.parse(r.redact(JSON.stringify(value ?? null))) as T;
}
