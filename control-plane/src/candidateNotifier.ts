import type { AppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { ExecutionCandidate } from "./types.js";

export class CandidateNotifier {
  private readonly log = createLogger("candidate-notifier");
  private readonly webhookUrl?: string;
  private readonly telegramBotToken?: string;
  private readonly telegramChatId?: string;
  private readonly telegramMessageThreadId?: number;
  private readonly minExpectedProfit: bigint;
  private readonly cooldownMs: number;
  private readonly timeoutMs: number;
  private lastSentAtByCycleId = new Map<string, number>();

  constructor(config: AppConfig) {
    this.webhookUrl = config.CANDIDATE_NOTIFICATION_WEBHOOK_URL;
    this.telegramBotToken = config.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = config.TELEGRAM_CHAT_ID;
    this.telegramMessageThreadId = config.TELEGRAM_MESSAGE_THREAD_ID;
    this.minExpectedProfit = config.CANDIDATE_NOTIFICATION_MIN_EXPECTED_PROFIT;
    this.cooldownMs = config.CANDIDATE_NOTIFICATION_COOLDOWN_MS;
    this.timeoutMs = config.CANDIDATE_NOTIFICATION_TIMEOUT_MS;
  }

  isEnabled(): boolean {
    return Boolean(this.webhookUrl || (this.telegramBotToken && this.telegramChatId));
  }

  async notifyCandidate(
    candidate: ExecutionCandidate,
    context: {
      hasRoute: boolean;
      minExpectedProfit: string;
    },
  ): Promise<void> {
    if (!this.webhookUrl && !(this.telegramBotToken && this.telegramChatId)) {
      return;
    }

    const expectedProfit = BigInt(candidate.expected_profit);
    if (expectedProfit < this.minExpectedProfit) {
      return;
    }

    const now = Date.now();
    const lastSentAt = this.lastSentAtByCycleId.get(candidate.cycle_id);
    if (lastSentAt !== undefined && now - lastSentAt < this.cooldownMs) {
      return;
    }

    this.lastSentAtByCycleId.set(candidate.cycle_id, now);

    const body = {
      event: "candidate_found",
      timestamp: now,
      cycleId: candidate.cycle_id,
      borrowToken: candidate.borrow_token,
      borrowAmount: candidate.borrow_amount,
      grossOutput: candidate.gross_output,
      expectedProfit: candidate.expected_profit,
      touchedPools: candidate.touched_pools,
      hasRoute: context.hasRoute,
      configuredMinExpectedProfit: context.minExpectedProfit,
    };

    try {
      if (this.webhookUrl) {
        const response = await fetch(this.webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          throw new Error(`notification webhook returned status ${response.status}`);
        }
      }

      if (this.telegramBotToken && this.telegramChatId) {
        const response = await fetch(`https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            chat_id: this.telegramChatId,
            message_thread_id: this.telegramMessageThreadId,
            text: this.formatTelegramMessage(candidate, context),
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          throw new Error(`telegram notification returned status ${response.status}`);
        }
      }
    } catch (error) {
      this.log.error({ error, cycleId: candidate.cycle_id }, "candidate notification failed");
    }
  }

  private formatTelegramMessage(
    candidate: ExecutionCandidate,
    context: {
      hasRoute: boolean;
      minExpectedProfit: string;
    },
  ): string {
    return [
      "Candidate found",
      `cycleId: ${candidate.cycle_id}`,
      `expectedProfit: ${candidate.expected_profit}`,
      `borrowAmount: ${candidate.borrow_amount}`,
      `borrowToken: ${candidate.borrow_token}`,
      `grossOutput: ${candidate.gross_output}`,
      `hasRoute: ${context.hasRoute}`,
      `minExpectedProfit: ${context.minExpectedProfit}`,
      `touchedPools: ${candidate.touched_pools.join(",")}`,
    ].join("\n");
  }
}
