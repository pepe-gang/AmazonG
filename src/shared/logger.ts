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
    } catch (err) {
      // A sink error must never break the program — but it also must
      // not vanish silently (a broken disk sink would drop the audit
      // trail with zero signal). Surface it on stderr directly, which
      // bypasses the sink chain that just failed.
      try {
        console.error(
          'log sink threw — event dropped from that sink:',
          err instanceof Error ? err.message : String(err),
        );
      } catch {
        // console itself unavailable — nothing more we can do
      }
    }
  }
}

export const logger = {
  info: (m: string, d?: Record<string, unknown>, cid?: string) => log('info', m, d, cid),
  warn: (m: string, d?: Record<string, unknown>, cid?: string) => log('warn', m, d, cid),
  error: (m: string, d?: Record<string, unknown>, cid?: string) => log('error', m, d, cid),
  debug: (m: string, d?: Record<string, unknown>, cid?: string) => log('debug', m, d, cid),
};
