// Minimal, read-only PE (Windows executable) parsing for the vendor scripts. Nothing is executed or loaded; every offset
// read from the file is bounds-checked, because the input is a downloaded binary (only ever parsed after its SHA256 matched).
//   parsePe(buf)               headers: machine, isDll, sections, data directories
//   peExports(buf)             names in the export table
//   peImports(buf)             DLL names in the import table
//   clrResources(buf)          the blobs of a .NET assembly's embedded managed resource area
//   extractEmbeddedNativeDll   the embedded native PE of a given machine type (Costura-style single-file assemblies)
export const MACHINE_X64 = 0x8664;
export const MACHINE_X86 = 0x14c;

function need(cond, msg) {
  if (!cond) throw new Error(`malformed PE: ${msg}`);
}

export function parsePe(buf) {
  need(buf.length > 0x40 && buf[0] === 0x4d && buf[1] === 0x5a, 'no MZ header');
  const pe = buf.readUInt32LE(0x3c);
  need(pe + 24 <= buf.length && buf.toString('latin1', pe, pe + 4) === 'PE\0\0', 'no PE signature');
  const machine = buf.readUInt16LE(pe + 4);
  const nsec = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const characteristics = buf.readUInt16LE(pe + 22);
  const opt = pe + 24;
  need(opt + optSize <= buf.length, 'optional header past EOF');
  const magic = buf.readUInt16LE(opt);
  need(magic === 0x10b || magic === 0x20b, 'unknown optional header magic');
  const dirBase = opt + (magic === 0x20b ? 112 : 96);
  const nDirs = buf.readUInt32LE(dirBase - 4);
  const sections = [];
  let so = opt + optSize;
  for (let i = 0; i < nsec; i++, so += 40) {
    need(so + 40 <= buf.length, 'section table past EOF');
    sections.push({
      name: buf.toString('latin1', so, so + 8).replace(/\0+$/, ''),
      vsize: buf.readUInt32LE(so + 8),
      va: buf.readUInt32LE(so + 12),
      rawSize: buf.readUInt32LE(so + 16),
      raw: buf.readUInt32LE(so + 20),
    });
  }
  const rvaToOffset = (rva) => {
    const s = sections.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize));
    need(s, `RVA 0x${rva.toString(16)} is in no section`);
    const off = rva - s.va + s.raw;
    need(off < buf.length, 'RVA maps past EOF');
    return off;
  };
  const dataDirectory = (i) => {
    if (i >= nDirs || dirBase + i * 8 + 8 > buf.length) return { rva: 0, size: 0 };
    return { rva: buf.readUInt32LE(dirBase + i * 8), size: buf.readUInt32LE(dirBase + i * 8 + 4) };
  };
  return { machine, is64: magic === 0x20b, isDll: (characteristics & 0x2000) !== 0, timestamp: buf.readUInt32LE(pe + 8), sections, rvaToOffset, dataDirectory };
}

function cString(buf, off) {
  const end = buf.indexOf(0, off);
  need(end > off - 1 && end < buf.length, 'unterminated string');
  return buf.toString('latin1', off, end);
}

export function peExports(buf) {
  const p = parsePe(buf);
  const dir = p.dataDirectory(0);
  if (dir.rva === 0) return [];
  const e = p.rvaToOffset(dir.rva);
  need(e + 40 <= buf.length, 'export directory past EOF');
  const count = buf.readUInt32LE(e + 24);
  const names = p.rvaToOffset(buf.readUInt32LE(e + 32));
  need(names + count * 4 <= buf.length, 'export names past EOF');
  const out = [];
  for (let i = 0; i < count; i++) out.push(cString(buf, p.rvaToOffset(buf.readUInt32LE(names + i * 4))));
  return out;
}

export function peImports(buf) {
  const p = parsePe(buf);
  const dir = p.dataDirectory(1);
  if (dir.rva === 0) return [];
  const out = [];
  for (let o = p.rvaToOffset(dir.rva); o + 20 <= buf.length && buf.readUInt32LE(o + 12) !== 0; o += 20) out.push(cString(buf, p.rvaToOffset(buf.readUInt32LE(o + 12))));
  return out;
}

/** Blobs of the CLR managed-resource area: a run of [uint32 length][bytes] records (ECMA-335 II.25.3.3). */
export function clrResources(buf) {
  const p = parsePe(buf);
  const clr = p.dataDirectory(14);
  need(clr.rva !== 0, 'not a .NET assembly (no CLR header)');
  const h = p.rvaToOffset(clr.rva);
  need(h + 32 <= buf.length, 'CLR header past EOF');
  const res = { rva: buf.readUInt32LE(h + 24), size: buf.readUInt32LE(h + 28) };
  if (res.rva === 0 || res.size === 0) return [];
  const start = p.rvaToOffset(res.rva);
  need(start + res.size <= buf.length, 'resource area past EOF');
  const blobs = [];
  let pos = start;
  while (pos < start + res.size) {
    need(pos + 4 <= start + res.size, 'truncated resource record');
    const len = buf.readUInt32LE(pos);
    need(pos + 4 + len <= start + res.size, 'resource record longer than the area');
    blobs.push(buf.subarray(pos + 4, pos + 4 + len));
    pos += 4 + len;
  }
  return blobs;
}

/** The single embedded native PE of the given machine type; throws unless there is exactly one. */
export function extractEmbeddedNativeDll(assembly, machine) {
  const hits = clrResources(assembly).filter((b) => {
    if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return false;
    try {
      return parsePe(b).machine === machine;
    } catch {
      return false;
    }
  });
  if (hits.length !== 1) throw new Error(`expected exactly one embedded PE with machine 0x${machine.toString(16)}, found ${hits.length}`);
  return Buffer.from(hits[0]);
}
