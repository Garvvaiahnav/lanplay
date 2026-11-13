// Merge LanPlay's managed keys into sunshine.conf ("key = value" lines, '#' comments).
// Keeps unknown keys, comments, order and line endings. Idempotent.
// Format: https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/docs/configuration.md
import type { MergeSunshineConf } from '../../contracts.js';

const KEY_LINE = /^(\s*)([A-Za-z0-9_]+)(\s*=\s*)(.*?)(\s*)$/;

export const mergeSunshineConf: MergeSunshineConf = (existing, managed) => {
  const src = existing ?? '';
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const hadBom = src.startsWith('﻿');
  const body = hadBom ? src.slice(1) : src;
  const lines = body.length ? body.split(/\r?\n/) : [];
  // A trailing newline yields an empty last element; drop it and re-add at the end.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith('#') || t === '') {
      out.push(line);
      continue;
    }
    const m = KEY_LINE.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const key = m[2]!;
    if (Object.prototype.hasOwnProperty.call(managed, key)) {
      // Sunshine keeps the FIRST occurrence of a key (config.cpp parse_config uses emplace), so ours must be the
      // first one; later duplicates are dropped so the file never looks like it says something else.
      if (seen.has(key)) continue;
      seen.add(key);
      const want = managed[key]!;
      out.push(m[4] === want ? line : `${m[1]}${key}${m[3]}${want}`);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(managed)) {
    if (!seen.has(k)) out.push(`${k} = ${v}`);
  }
  const text = (hadBom ? '﻿' : '') + (out.length ? out.join(eol) + eol : '');
  return { text, changed: text !== src };
};

/**
 * Parse "key = value" pairs the way Sunshine does: text after '#' is a comment, and the FIRST occurrence of a key wins
 * (config.cpp parse_config: "emplace"). https://github.com/LizardByte/Sunshine/blob/v2026.914.233613/src/config.cpp
 */
export function parseSunshineConf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const hash = raw.indexOf('#');
    const line = hash >= 0 ? raw.slice(0, hash) : raw;
    if (!line.trim()) continue;
    const m = KEY_LINE.exec(line);
    if (m && !Object.prototype.hasOwnProperty.call(out, m[2]!)) out[m[2]!] = m[4]!;
  }
  return out;
}
