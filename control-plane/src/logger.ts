export interface LogEntry {
  level: string;
  scope: string;
  message?: string;
  payload: Record<string, unknown>;
}

type ErrorListener = (entry: LogEntry) => void;

const errorListeners = new Set<ErrorListener>();

export function onErrorLog(listener: ErrorListener): () => void {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}

export function createLogger(scope: string) {
  return {
    info(payload: unknown, message?: string) {
      write("INFO", scope, payload, message);
    },
    debug(payload: unknown, message?: string) {
      write("DEBUG", scope, payload, message);
    },
    error(payload: unknown, message?: string) {
      write("ERROR", scope, payload, message);
    },
  };
}

function write(level: string, scope: string, payload: unknown, message?: string) {
  const body =
    payload !== null && typeof payload === "object"
      ? payload
      : payload === undefined
        ? {}
        : { payload };
  console.log(JSON.stringify({ level, scope, message, ...body }));
  if (level === "ERROR") {
    for (const listener of errorListeners) {
      try {
        listener({ level, scope, message, payload: body as Record<string, unknown> });
      } catch {
        // Logging must never fail application code.
      }
    }
  }
}
