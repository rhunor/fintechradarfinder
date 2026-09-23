/**
 * log.ts — structured JSON logging.
 *
 * WHY: Vercel's log viewer parses one JSON object per line and lets you filter
 * on its fields. Plain console.log strings become unsearchable soup once the
 * poll route is running 43,000 times a month. Every log line here carries an
 * `evt` field so you can filter to a single event type in the dashboard.
 *
 * Never pass secrets into these functions — the payload is written verbatim.
 */

type Level = "debug" | "info" | "warn" | "error";

/** Fields that appear on every line, set once per invocation. */
let context: Record<string, unknown> = {};

export function setLogContext(fields: Record<string, unknown>): void {
  context = { ...context, ...fields };
}

export function clearLogContext(): void {
  context = {};
}

/**
 * Debug lines are off unless LOG_LEVEL=debug. They are useful when chasing a
 * specific feed, but in normal operation they bury the events that matter and
 * every line costs bytes in Vercel's log retention.
 */
const DEBUG_ENABLED = process.env.LOG_LEVEL === "debug";

function emit(level: Level, evt: string, data?: Record<string, unknown>): void {
  if (level === "debug" && !DEBUG_ENABLED) return;
  const line = JSON.stringify({
    level,
    evt,
    ts: new Date().toISOString(),
    ...context,
    ...data,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (evt: string, data?: Record<string, unknown>) => emit("debug", evt, data),
  info: (evt: string, data?: Record<string, unknown>) => emit("info", evt, data),
  warn: (evt: string, data?: Record<string, unknown>) => emit("warn", evt, data),
  error: (evt: string, data?: Record<string, unknown>) => emit("error", evt, data),
};

/**
 * Turns an unknown thrown value into something safe to log. Errors thrown by
 * fetch can carry a `cause` with connection details, which is the useful part.
 */
export function errorInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      err_name: err.name,
      err_msg: err.message,
      ...(err.cause ? { err_cause: String(err.cause) } : {}),
    };
  }
  return { err_msg: String(err) };
}
