import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { createLogger } from "./logger.js";
export class RustBridge extends EventEmitter {
    process;
    log = createLogger("rust-bridge");
    constructor(binaryPath) {
        super();
        this.process = spawn(binaryPath, [], {
            stdio: ["pipe", "pipe", "inherit"],
        });
        const rl = readline.createInterface({ input: this.process.stdout });
        rl.on("line", (line) => {
            const message = JSON.parse(line);
            if (message.type === "candidate") {
                this.emit("candidate", {
                    cycle_id: message.cycle_id,
                    borrow_token: String(message.borrow_token),
                    borrow_amount: String(message.borrow_amount),
                    gross_output: String(message.gross_output),
                    expected_profit: String(message.expected_profit),
                    touched_pools: message.touched_pools,
                });
                return;
            }
            this.emit(message.type, message);
        });
    }
    bootstrap(pools) {
        this.send({ type: "bootstrap", pools });
    }
    updatePool(update) {
        this.send({ type: "pool_update", ...update });
    }
    healthcheck() {
        this.send({ type: "healthcheck" });
    }
    send(payload) {
        const body = JSON.stringify(payload);
        this.log.debug({ body }, "sending message to rust");
        this.process.stdin.write(`${body}\n`);
    }
}
