// KeyValueStore (JSON file, atomic writes) and SecretStore implementations.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KeyValueStore, SecretKey, SecretStore } from '../../contracts.js';

function atomicWrite(file: string, text: string, mode?: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode });
  if (mode !== undefined) {
    try {
      chmodSync(tmp, mode);
    } catch {
      /* Windows: ACL inherited from the user-only parent folder */
    }
  }
  renameSync(tmp, file);
}

export class MemoryStore implements KeyValueStore {
  private readonly m = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T {
    return this.m.has(key) ? (structuredClone(this.m.get(key)) as T) : fallback;
  }
  set<T>(key: string, value: T): void {
    this.m.set(key, structuredClone(value));
  }
}

/** Small JSON-file store. Re-reads the file on every get so two processes (GUI + agent) see each other's writes. */
export class JsonFileStore implements KeyValueStore {
  constructor(private readonly file: string) {}
  private readAll(): Record<string, unknown> {
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  get<T>(key: string, fallback: T): T {
    const all = this.readAll();
    return Object.prototype.hasOwnProperty.call(all, key) ? (all[key] as T) : fallback;
  }
  set<T>(key: string, value: T): void {
    const all = this.readAll();
    all[key] = value;
    atomicWrite(this.file, JSON.stringify(all, null, 2));
  }
  path(): string {
    return this.file;
  }
}

/** Fallback secret store: a JSON file created with mode 0600 (POSIX). On Windows the file lives under the user-only %APPDATA%. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly file: string) {}
  private readAll(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  async get(key: SecretKey): Promise<string | null> {
    const v = this.readAll()[key];
    return typeof v === 'string' ? v : null;
  }
  async set(key: SecretKey, value: string): Promise<void> {
    const all = this.readAll();
    all[key] = value;
    atomicWrite(this.file, JSON.stringify(all), 0o600);
  }
  async delete(key: SecretKey): Promise<void> {
    if (!existsSync(this.file)) return;
    const all = this.readAll();
    delete all[key];
    atomicWrite(this.file, JSON.stringify(all), 0o600);
  }
  backend(): 'file-0600' {
    return 'file-0600';
  }
}

/** The subset of Electron's safeStorage we use (injected so it can be faked in tests). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

/** OS-backed secrets: Electron safeStorage (macOS Keychain key / Windows DPAPI). Ciphertext stored in a 0600 file. */
export class SafeStorageSecretStore implements SecretStore {
  constructor(
    private readonly safe: SafeStorageLike,
    private readonly file: string,
    private readonly platform: NodeJS.Platform,
  ) {}
  private readAll(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  async get(key: SecretKey): Promise<string | null> {
    const v = this.readAll()[key];
    if (typeof v !== 'string') return null;
    try {
      return this.safe.decryptString(Buffer.from(v, 'base64'));
    } catch {
      return null;
    }
  }
  async set(key: SecretKey, value: string): Promise<void> {
    const all = this.readAll();
    all[key] = this.safe.encryptString(value).toString('base64');
    atomicWrite(this.file, JSON.stringify(all), 0o600);
  }
  async delete(key: SecretKey): Promise<void> {
    const all = this.readAll();
    delete all[key];
    atomicWrite(this.file, JSON.stringify(all), 0o600);
  }
  backend(): 'keychain' | 'dpapi' {
    return this.platform === 'win32' ? 'dpapi' : 'keychain';
  }
}

export function chooseSecretStore(safe: SafeStorageLike | null, dir: string, platform: NodeJS.Platform): SecretStore {
  if (safe) {
    try {
      if (safe.isEncryptionAvailable()) return new SafeStorageSecretStore(safe, path.join(dir, 'secrets.enc.json'), platform);
    } catch {
      /* fall through */
    }
  }
  return new FileSecretStore(path.join(dir, 'secrets.json'));
}
