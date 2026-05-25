import type { AppConfig } from "./config.js";
import { createLogger, onErrorLog, type LogEntry } from "./logger.js";

export class ErrorAlertNotifier {
  private readonly log = createLogger("error-alert-notifier");
  private readonly telegramBotToken?: string;
  private readonly telegramChatId?: string;
  private readonly telegramMessageThreadId?: number;
  private readonly enabled: boolean;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private readonly lastSentAtByKey = new Map<string, number>();

  constructor(config: AppConfig) {
    this.telegramBotToken = config.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = config.TELEGRAM_CHAT_ID;
    this.telegramMessageThreadId = config.TELEGRAM_MESSAGE_THREAD_ID;
    this.enabled = config.ERROR_ALERTS_ENABLED;
    this.cooldownMs = config.ERROR_ALERT_COOLDOWN_MS;
    this.timeoutMs = config.ERROR_ALERT_TIMEOUT_MS;
  }

  start(): void {
    if (!this.enabled || !this.telegramBotToken || !this.telegramChatId) {
      return;
    }

    onErrorLog((entry) => {
      if (entry.scope === "error-alert-notifier" || entry.scope === "candidate-notifier") {
        return;
      }
      void this.notify(entry);
    });
  }

  private async notify(entry: LogEntry): Promise<void> {
    const key = `${entry.scope}:${entry.message ?? ""}`;
    const now = Date.now();
    const lastSentAt = this.lastSentAtByKey.get(key);
    if (lastSentAt !== undefined && now - lastSentAt < this.cooldownMs) {
      return;
    }
    this.lastSentAtByKey.set(key, now);

    try {
      const response = await fetch(`https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: this.telegramChatId,
          message_thread_id: this.telegramMessageThreadId,
          text: this.formatMessage(entry),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`telegram alert returned status ${response.status}`);
      }
    } catch (error) {
      this.log.error({ error }, "telegram error alert failed");
    }
  }

  private formatMessage(entry: LogEntry): string {
    return [
      "Arb bot error",
      `time: ${new Date().toISOString()}`,
      `scope: ${entry.scope}`,
      `message: ${entry.message ?? "-"}`,
      `details: ${this.safeDetails(entry.payload)}`,
    ].join("\n");
  }

  private safeDetails(payload: Record<string, unknown>): string {
    const redacted = redact(payload);
    const serialized = JSON.stringify(redacted);
    if (!serialized) {
      return "{}";
    }
    return serialized.length > 2500 ? `${serialized.slice(0, 2500)}...` : serialized;
  }
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!value || typeof value !== "object") {
    return value instanceof Error ? value.message : value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower.includes("token") || lower.includes("key") || lower.includes("secret") || lower.includes("password")) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = redact(nested);
  }
  return output;
}
