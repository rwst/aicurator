import { createSignal, type Accessor } from 'solid-js';
import { localStorage } from '../store/localStorage';

export type LogLevel = 'init' | 'info' | 'ok' | 'warn' | 'err';
export type LogTopic = 'extract' | 'summate' | 'canonize';

export interface LogLine {
  ts: string;        // 'HH:MM:SS' for display
  isoTs: string;     // ISO 8601 for sorting/persistence
  level: LogLevel;
  msg: string;
}

export interface Log {
  lines: Accessor<LogLine[]>;
  append(level: LogLevel, msg: string): void;
  clear(): Promise<void>;
  hydrate(): Promise<void>;
}

const MAX_LINES = 500;
const PERSIST_DEBOUNCE_MS = 1000;

function fmtTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function isLogLine(v: unknown): v is LogLine {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ts === 'string' &&
    typeof o.isoTs === 'string' &&
    typeof o.msg === 'string' &&
    (o.level === 'init' ||
      o.level === 'info' ||
      o.level === 'ok' ||
      o.level === 'warn' ||
      o.level === 'err')
  );
}

function createLog(topic: LogTopic): Log {
  const [lines, setLines] = createSignal<LogLine[]>([]);
  const storageKey = `logs.${topic}`;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  const persist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void localStorage.set({ [storageKey]: lines() });
    }, PERSIST_DEBOUNCE_MS);
  };

  return {
    lines,
    append(level, msg) {
      const now = new Date();
      const line: LogLine = {
        ts: fmtTime(now),
        isoTs: now.toISOString(),
        level,
        msg,
      };
      setLines((prev) => {
        const next = [...prev, line];
        if (next.length > MAX_LINES) {
          next.splice(0, next.length - MAX_LINES);
        }
        return next;
      });
      persist();
    },
    async clear() {
      setLines([]);
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      await localStorage.set({ [storageKey]: [] });
    },
    async hydrate() {
      const stored = await localStorage.get([storageKey]);
      const value = stored[storageKey];
      if (Array.isArray(value)) {
        const valid = value.filter(isLogLine);
        setLines(valid);
      }
    },
  };
}

export const extractLog: Log = createLog('extract');
export const summateLog: Log = createLog('summate');
export const canonizeLog: Log = createLog('canonize');

const ALL_LOGS: readonly Log[] = [extractLog, summateLog, canonizeLog];

export async function hydrateAllLogs(): Promise<void> {
  await Promise.all(ALL_LOGS.map((l) => l.hydrate()));
}

export async function clearAllLogs(): Promise<void> {
  await Promise.all(ALL_LOGS.map((l) => l.clear()));
}
