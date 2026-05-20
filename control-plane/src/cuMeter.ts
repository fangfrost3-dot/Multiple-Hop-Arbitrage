export interface CuMeterMethodSnapshot {
  count: number;
  estimatedCu: number;
}

export interface CuMeterSnapshot {
  startedAt: number;
  elapsedMs: number;
  estimatedTotalCu: number;
  estimatedCuPerHour: number;
  estimatedCuPerMonth: number;
  websocketBytes: number;
  websocketEvents: number;
  byMethod: Record<string, CuMeterMethodSnapshot>;
}

const METHOD_CU: Record<string, number> = {
  eth_blockNumber: 10,
  eth_subscribe: 10,
  eth_unsubscribe: 10,
  eth_feeHistory: 10,
  eth_maxPriorityFeePerGas: 10,
  eth_getTransactionReceipt: 20,
  eth_getTransactionByHash: 20,
  eth_getTransactionCount: 20,
  eth_getBlockByNumber: 20,
  eth_gasPrice: 20,
  eth_getBalance: 20,
  eth_getCode: 20,
  eth_call: 26,
  eth_estimateGas: 20,
  arb_gasEstimateComponents: 20,
  eth_sendRawTransaction: 40,
  eth_getLogs: 60,
};

const WEBSOCKET_CU_PER_BYTE = 0.04;
const MONTH_HOURS = 24 * 30;

export class CuMeter {
  private readonly startedAt = Date.now();
  private estimatedTotalCu = 0;
  private websocketBytes = 0;
  private websocketEvents = 0;
  private readonly byMethod = new Map<string, CuMeterMethodSnapshot>();

  recordMethod(method: string, count = 1, unitsPerCall = METHOD_CU[method] ?? 0): void {
    if (count <= 0 || unitsPerCall <= 0) {
      return;
    }

    this.add(method, count, count * unitsPerCall);
  }

  recordWebSocketPayload(payload: unknown): void {
    const bytes = Buffer.byteLength(this.stringifyPayload(payload), "utf8");
    const estimatedCu = bytes * WEBSOCKET_CU_PER_BYTE;
    this.websocketBytes += bytes;
    this.websocketEvents += 1;
    this.add("websocket_subscription_event", 1, estimatedCu);
  }

  snapshot(): CuMeterSnapshot {
    const elapsedMs = Math.max(1, Date.now() - this.startedAt);
    const estimatedCuPerHour = this.estimatedTotalCu / (elapsedMs / 3_600_000);

    return {
      startedAt: this.startedAt,
      elapsedMs,
      estimatedTotalCu: Math.round(this.estimatedTotalCu * 100) / 100,
      estimatedCuPerHour: Math.round(estimatedCuPerHour * 100) / 100,
      estimatedCuPerMonth: Math.round(estimatedCuPerHour * MONTH_HOURS * 100) / 100,
      websocketBytes: this.websocketBytes,
      websocketEvents: this.websocketEvents,
      byMethod: Object.fromEntries(
        [...this.byMethod.entries()].map(([method, snapshot]) => [
          method,
          {
            count: snapshot.count,
            estimatedCu: Math.round(snapshot.estimatedCu * 100) / 100,
          },
        ]),
      ),
    };
  }

  private add(method: string, count: number, estimatedCu: number): void {
    this.estimatedTotalCu += estimatedCu;
    const current = this.byMethod.get(method) ?? { count: 0, estimatedCu: 0 };
    current.count += count;
    current.estimatedCu += estimatedCu;
    this.byMethod.set(method, current);
  }

  private stringifyPayload(payload: unknown): string {
    try {
      return JSON.stringify(payload, stringifyBigInt);
    } catch {
      return String(payload);
    }
  }
}

function stringifyBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
