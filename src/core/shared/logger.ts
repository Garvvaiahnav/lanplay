// JSONL logger. One line per entry, appended synchronously so a crash never loses the last lines.
// Everything goes through the Redactor first. Logging never throws.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { LogEntry, LogLevel, Logger, RestCallRecord, StepRecord } from '../../contracts.js';
import { DefaultRedactor, redactValue } from './redact.js';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Local date YYYY-MM-DD (the file name uses local time so Garv finds "today's" log). */
export function localDateStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface JsonlLoggerOptions {
  dir: string;
  /** e.g. LANPLAY.logFilePattern "lanplay-<date>.log" */
  filePattern: string;
  redactor?: DefaultRedactor;
  minLevel?: LogLevel;
  now?: () => Date;
  /** Optional mirror (e.g. stderr in CLI mode). Receives the redacted JSON line. */
  echo?: (line: string) => void;
  /** Path module: path.win32 on Windows, path.posix elsewhere (default: platform path). */
  pathImpl?: typeof path.posix;
}

interface Sink {
  write(entry: LogEntry): void;
  file(): string;
}

class FileSink implements Sink {
  private dirReady = false;
  constructor(private readonly o: JsonlLoggerOptions) {}
  file(): string {
    const p = this.o.pathImpl ?? path;
    const now = (this.o.now ?? (() => new Date()))();
    return p.join(this.o.dir, this.o.filePattern.replace('<date>', localDateStamp(now)));
  }
  write(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    try {
      if (!this.dirReady) {
        mkdirSync(this.o.dir, { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(this.file(), line + '\n', { encoding: 'utf8' });
    } catch {
      // Logging must never break the app. Diagnostics reports the log dir state separately.
    }
    try {
      this.o.echo?.(line);
    } catch {
      /* ignore */
    }
  }
}

export class JsonlLogger implements Logger {
  readonly redactor: DefaultRedactor;
  private readonly min: number;
  constructor(
    private readonly sink: Sink,
    redactor: DefaultRedactor,
    private readonly prefix: string,
    minLevel: LogLevel,
    private readonly now: () => Date,
  ) {
    this.redactor = redactor;
    this.min = LEVELS[minLevel];
  }

  private scoped(scope: string): string {
    return this.prefix ? (scope ? `${this.prefix}.${scope}` : this.prefix) : scope;
  }

  log(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < this.min) return;
    const entry: LogEntry = { ts: this.now().toISOString(), level, scope: this.scoped(scope), msg: this.redactor.redact(String(msg)) };
    if (data !== undefined) entry.data = redactValue(this.redactor, data);
    this.sink.write(entry);
  }

  step(rec: StepRecord): void {
    const entry: LogEntry = {
      ts: this.now().toISOString(),
      level: rec.status === 'fail' ? 'error' : rec.status === 'warn' ? 'warn' : 'info',
      scope: this.scoped('step'),
      msg: `${rec.stepId}: ${rec.status}`,
      step: redactValue(this.redactor, rec),
    };
    this.sink.write(entry);
  }

  rest(rec: RestCallRecord): void {
    const entry: LogEntry = {
      ts: this.now().toISOString(),
      level: rec.error || (rec.status !== null && rec.status >= 400) ? 'warn' : 'debug',
      scope: this.scoped('rest'),
      msg: `${rec.method} ${rec.url} -> ${rec.status ?? 'ERR'}`,
      rest: redactValue(this.redactor, rec),
    };
    this.sink.write(entry);
  }

  child(scope: string): Logger {
    return new JsonlLogger(this.sink, this.redactor, this.scoped(scope), minLevelOf(this.min), this.now);
  }

  currentFile(): string {
    return this.sink.file();
  }
}

function minLevelOf(n: number): LogLevel {
  return (Object.entries(LEVELS).find(([, v]) => v === n)?.[0] ?? 'debug') as LogLevel;
}

export function createJsonlLogger(o: JsonlLoggerOptions): JsonlLogger {
  const redactor = o.redactor ?? new DefaultRedactor();
  return new JsonlLogger(new FileSink(o), redactor, '', o.minLevel ?? 'debug', o.now ?? (() => new Date()));
}

/** In-memory logger for tests and for headless helpers that collect entries. */
export class MemoryLogger extends JsonlLogger {
  readonly entries: LogEntry[];
  constructor(redactor = new DefaultRedactor()) {
    const entries: LogEntry[] = [];
    super({ write: (e) => entries.push(e), file: () => '/dev/null/lanplay-memory.log' }, redactor, '', 'debug', () => new Date());
    this.entries = entries;
  }
}
