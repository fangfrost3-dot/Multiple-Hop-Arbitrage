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
}
