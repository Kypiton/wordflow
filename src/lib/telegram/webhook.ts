import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type { TelegramUpdate } from "./types";

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
  const message = update.message;
  if (message?.chat.type !== "private" || !message.text) return undefined;
  // Accept deep-link arguments and Telegram's /command@bot form.
  return /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(message.text)
    ? message.chat.id
    : undefined;
}

export const WELCOME_MESSAGE =
  "Welcome to WordFlow! 👋\n\n" +
  "WordFlow is your English vocabulary learning app, right here in Telegram. " +
  "Build your vocabulary with new words and short practice sessions.\n\n" +
  "You're at the beginning — vocabulary lessons and practice are coming soon!";
