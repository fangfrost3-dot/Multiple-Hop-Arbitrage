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
}
