const errorListeners = new Set();
export function onErrorLog(listener) {
    errorListeners.add(listener);
    return () => {
        errorListeners.delete(listener);
    };
}
export function createLogger(scope) {
    return {
        info(payload, message) {
            write("INFO", scope, payload, message);
        },
        debug(payload, message) {
            write("DEBUG", scope, payload, message);
        },
        error(payload, message) {
            write("ERROR", scope, payload, message);
        },
    };
}
function write(level, scope, payload, message) {
    const body = payload !== null && typeof payload === "object"
        ? payload
        : payload === undefined
            ? {}
            : { payload };
    console.log(JSON.stringify({ level, scope, message, ...body }));
    if (level === "ERROR") {
        for (const listener of errorListeners) {
            try {
                listener({ level, scope, message, payload: body });
            }
            catch {
                // Logging must never fail application code.
            }
        }
    }
}
