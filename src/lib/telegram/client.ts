import "server-only";

import { isRecord, isTelegramMessage } from "./types";
import type { SendMessageRequest, TelegramMessage, TelegramResponse } from "./types";

export class TelegramApiError extends Error {
  constructor() {
    // Never include Telegram descriptions, fetch errors, URLs, or causes: these
    // can contain the bot token or user content.
    super("Telegram request failed.");
    this.name = "TelegramApiError";
  }
}

export async function sendMessage(request: SendMessageRequest): Promise<TelegramMessage> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new TelegramApiError();
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json();
    if (!response.ok || !isRecord(body) || body.ok !== true || !isTelegramMessage(body.result)) {
      throw new TelegramApiError();
    }
    const result: TelegramResponse<TelegramMessage> = { ok: true, result: body.result };
    return result.result;
  } catch {
    throw new TelegramApiError();
  }
}
