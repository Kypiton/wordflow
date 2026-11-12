import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type { TelegramUpdate } from "./types";

/** Bound memory and parsing time before the 15-second widget answer deadline. */
export async function readUpdate(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing update.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Update timed out.")), 2_000);
  });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) throw new Error("Update too large.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export function isValidWebhookSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(secret);
}

export function verifyWebhookSecret(received: string | null, expected: string): boolean {
  if (received === null) return false;
  // Fixed-size digests avoid length mismatches in timingSafeEqual.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

export function startChatId(update: TelegramUpdate): number | undefined {
  return commandChatId(update, "start");
}

export function commandChatId(update: TelegramUpdate, command: "start" | "learn" | "review"): number | undefined {
  const message = update.message;
  if (message?.chat.type !== "private" || !message.text) return undefined;
  // Accept deep-link arguments and Telegram's /command@bot form.
  return new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?(?:\\s|$)`).test(message.text)
    ? message.chat.id
    : undefined;
}

export const WELCOME_MESSAGE =
  "Welcome to WordFlow! 👋\n\n" +
  "WordFlow is your English vocabulary learning app, right here in Telegram. " +
  "Build your vocabulary with new words and short practice sessions.\n\n" +
  "Send /learn for new words or /review for scheduled practice!";
