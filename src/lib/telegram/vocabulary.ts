import "server-only";
import { VocabularyRepository } from "../db/vocabulary-repository";
import { vocabularyCommand } from "../vocabulary/domain";
import { sendMessage } from "./client";
import type { TelegramMessage } from "./types";
import { isPositiveId } from "./types";

export const vocabularyStore = new VocabularyRepository();
export async function handleVocabularyMessage(message?: TelegramMessage): Promise<boolean> {
  if (!message?.text || message.chat.type !== "private" || message.forward_origin !== undefined ||
      (!vocabularyCommand(message.text) && (!message.reply_to_message || message.text.startsWith("/")))) return false;
  if (!message.from || message.from.is_bot || message.from.id !== message.chat.id || !isPositiveId(message.message_id)) return true;
  const response = await vocabularyStore.process(message.from.id, message.message_id, message.text, message.reply_to_message?.message_id);
  if (!response) return false;
  const sent = await sendMessage({ chat_id: message.chat.id, text: response.text, protect_content: true });
  if (response.promptToken) {
    if (sent.chat.id !== message.chat.id || sent.chat.type !== "private") throw new Error("Invalid vocabulary delivery.");
    await vocabularyStore.bindPrompt(message.from.id, response.promptToken, sent.message_id);
  }
  return true;
}
