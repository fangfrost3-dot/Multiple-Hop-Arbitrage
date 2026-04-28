import { spawn, type ChildProcessByStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Writable, Readable } from "node:stream";
import readline from "node:readline";
import { createLogger } from "./logger.js";
import type { ExecutionCandidate, PoolSnapshot, PoolUpdate } from "./types.js";

type RustMessage =
  | { type: "ready" }
  | { type: "health"; tracked_pools: number; tracked_cycles: number; latest_block: number }
  | {
      type: "candidate";
      cycle_id: string;
      borrow_token: string;
      borrow_amount: string;
      gross_output: string;
      expected_profit: string;
      touched_pools: string[];
    }
  | { type: "log"; level: string; message: string };

export class RustBridge extends EventEmitter {
  private readonly process: ChildProcessByStdio<Writable, Readable, null>;
  private readonly log = createLogger("rust-bridge");
  private readySeen = false;

  constructor(binaryPath: string) {
    super();
    this.process = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on("line", (line) => {
      const message = JSON.parse(line) as RustMessage;
      if (message.type === "ready") {
        this.readySeen = true;
      }
      if (message.type === "candidate") {
        this.emit("candidate", {
          cycle_id: message.cycle_id,
          borrow_token: String(message.borrow_token),
          borrow_amount: String(message.borrow_amount),
          gross_output: String(message.gross_output),
          expected_profit: String(message.expected_profit),
          touched_pools: message.touched_pools,
        } satisfies ExecutionCandidate);
        return;
      }
      this.emit(message.type, message);
    });
  }

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const result = super.on(eventName, listener);
    if (eventName === "ready" && this.readySeen) {
      setImmediate(() => listener({ type: "ready" }));
    }
    return result;
  }

  bootstrap(pools: PoolSnapshot[]): void {
    this.send({ type: "bootstrap", pools });
  }

  updatePool(update: PoolUpdate): void {
    this.send({ type: "pool_update", ...update });
  }

  healthcheck(): void {
    this.send({ type: "healthcheck" });
  }

  private send(payload: unknown): void {
    const body = JSON.stringify(payload);
    this.log.debug({ body }, "sending message to rust");
    this.process.stdin.write(`${body}\n`);
  }
}
