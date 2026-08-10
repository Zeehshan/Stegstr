/**
 * Stegstr application logger.
 * Logs actions and errors for debugging and for applying fixes to other platform versions.
 * Format: JSONL (one JSON object per line) for easy parsing.
 */

type LogLevel = "info" | "warn" | "error" | "action";
type LogAction =
  | "detect_started"
  | "detect_completed"
  | "detect_empty"
  | "detect_error"
  | "detect_cancelled"
  | "embed_started"
  | "embed_completed"
  | "embed_error"
  | "post"
  | "reply"
  | "follow"
  | "dm_send"
  | "like"
  | "network_toggle"
  | "nostr_login"
  | "nostr_logout"
  | "profile_edit"
  | "view_change"
  | "search"
  | "other";

interface LogEntry {
  ts: string;
  level: LogLevel;
  action?: LogAction;
  message: string;
  details?: Record<string, unknown>;
  error?: string;
  stack?: string;
}

const LOG_BUFFER: LogEntry[] = [];
const MAX_BUFFER = 500;

function entry(level: LogLevel, message: string, opts?: { action?: LogAction; details?: Record<string, unknown>; error?: unknown }): LogEntry {
  const e: LogEntry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...opts?.details && { details: redactDetails(opts.details) },
  };
  if (opts?.action) e.action = opts.action;
  if (opts?.error !== undefined) {
    e.error = opts.error instanceof Error ? opts.error.message : String(opts.error);
    if (opts.error instanceof Error && opts.error.stack) e.stack = opts.error.stack;
  }
  return e;
}

function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [
    key,
    /private|privkey|secret|nsec|payload|ciphertext|plaintext/i.test(key) ? "[redacted]" : value,
  ]));
}

function flush(ent: LogEntry): void {
  LOG_BUFFER.push(ent);
  if (LOG_BUFFER.length > MAX_BUFFER) LOG_BUFFER.shift();
  const line = JSON.stringify(ent);
  console.log(`[Stegstr] ${line}`);
  try {
    if (typeof window !== "undefined" && (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
      import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("stegstr_log", {
        level: ent.level,
        action: ent.action ?? "other",
        message: ent.message,
        details: ent.details ? JSON.stringify(ent.details) : null,
        error: ent.error ?? null,
        stack: ent.stack ?? null,
      }).catch(() => {})
    ).catch(() => {});
    }
  } catch (_) {}
}

export function logInfo(message: string, details?: Record<string, unknown>): void {
  flush(entry("info", message, { details }));
}

export function logWarn(message: string, details?: Record<string, unknown>): void {
  flush(entry("warn", message, { details }));
}

export function logError(message: string, error?: unknown, details?: Record<string, unknown>): void {
  flush(entry("error", message, { error, details }));
}

export function logAction(action: LogAction, message: string, details?: Record<string, unknown>): void {
  flush(entry("action", message, { action, details }));
}

export function getLogBuffer(): LogEntry[] {
  return [...LOG_BUFFER];
}

export function getLogBufferAsText(): string {
  return LOG_BUFFER.map((e) => JSON.stringify(e)).join("\n");
}
