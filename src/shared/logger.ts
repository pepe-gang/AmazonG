import type { LogEvent, LogLevel } from './types.js';

type Sink = (event: LogEvent) => void;

const sinks: Sink[] = [
  (ev) => {
    const line = JSON.stringify(ev);
    if (ev.level === 'error') console.error(line);
    else console.log(line);
  },
];

export function addLogSink(sink: Sink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

export function log(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
  correlationId?: string,
): void {
  const event: LogEvent = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(data ? { data } : {}),
    ...(correlationId ? { correlationId } : {}),
  };
  for (const sink of sinks) {
    try {
      sink(event);
    } catch {
      // sink errors shouldn't break the program
    }
  }
}

export const logger = {
  info: (m: string, d?: Record<string, unknown>, cid?: string) => log('info', m, d, cid),
  warn: (m: string, d?: Record<string, unknown>, cid?: string) => log('warn', m, d, cid),
  error: (m: string, d?: Record<string, unknown>, cid?: string) => log('error', m, d, cid),
  debug: (m: string, d?: Record<string, unknown>, cid?: string) => log('debug', m, d, cid),
};
