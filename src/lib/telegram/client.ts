import "server-only";

import { deflateSync } from "node:zlib";

import { isRecord, isTelegramMessage } from "./types";
import type { AnswerWidgetQueryRequest, SendWidgetRequest, SendMessageRequest, TelegramMessage } from "./types";

export class TelegramApiError extends Error {
  constructor() {
    // Never include Telegram descriptions, fetch errors, URLs, or causes: these
    // can contain the bot token or user content.
    super("Telegram request failed.");
    this.name = "TelegramApiError";
  }
}

async function callApi<T>(
  method: "sendMessage" | "sendWidget" | "answerWidgetQuery",
  request: SendMessageRequest | SendWidgetRequest | AnswerWidgetQueryRequest,
  validate: (value: unknown) => value is T,
  timeoutMs = 10_000,
): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new TelegramApiError();
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body: unknown = await response.json();
    if (!response.ok || !isRecord(body) || body.ok !== true || !validate(body.result)) {
      throw new TelegramApiError();
    }
    return body.result;
  } catch {
    throw new TelegramApiError();
  }
}

export function sendMessage(request: SendMessageRequest): Promise<TelegramMessage> {
  return callApi("sendMessage", request, isTelegramMessage);
}

export function sendWidget(request: SendWidgetRequest): Promise<TelegramMessage> {
  const bytes = Buffer.byteLength(request.html, "utf8");
  if (bytes < 1 || bytes > 32768 || deflateSync(request.html, { level: 9 }).length > 4096) {
    throw new TelegramApiError();
  }
  return callApi("sendWidget", request, isTelegramMessage);
}

export function answerWidgetQuery(request: AnswerWidgetQueryRequest): Promise<true> {
  if (Buffer.byteLength(request.data, "utf8") > 1024) throw new TelegramApiError();
  // No retries or other network calls ahead of the time-sensitive answer.
  return callApi("answerWidgetQuery", request, (value): value is true => value === true, 5_000);
}
