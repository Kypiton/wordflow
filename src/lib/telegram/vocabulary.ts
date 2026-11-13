import "server-only";
import { VocabularyRepository, callbackReceiptKey } from "../db/vocabulary-repository";
import { vocabularyCommand } from "../vocabulary/domain";
import type { VocabularyResponse } from "../vocabulary/domain";
import { sendMessage, editMessageText, answerCallbackQuery } from "./client";
import { sendQuiz } from "./quiz";
import { menuCommand, validCallbackData } from "./navigation";
import type { TelegramMessage } from "./types";
import { isPositiveId, isPrivateCallbackQuery, isQueryId, isRecord } from "./types";

export const vocabularyStore = new VocabularyRepository();
async function deliver(userId: number, response: VocabularyResponse, sourceMessageId?: number): Promise<number> {
  if (sourceMessageId && !response.forceReply) {
    await editMessageText({ chat_id: userId, message_id: sourceMessageId, text: response.text, reply_markup: response.keyboard ?? { inline_keyboard: [] } });
    if (response.promptToken) await vocabularyStore.bindPrompt(userId, response.promptToken, sourceMessageId);
    return sourceMessageId;
  }
  const sent = await sendMessage({ chat_id: userId, text: response.text, protect_content: true,
    reply_markup: response.forceReply ? { force_reply: true } : response.keyboard });
  if (sent.chat.id !== userId || sent.chat.type !== "private" || !isPositiveId(sent.message_id)) throw new Error("Invalid vocabulary delivery.");
  if (response.promptToken) await vocabularyStore.bindPrompt(userId, response.promptToken, sent.message_id);
  return sent.message_id;
}
export async function handleVocabularyMessage(message?: TelegramMessage): Promise<boolean> {
  if (!message?.text || message.chat.type !== "private" || message.forward_origin !== undefined) return false;
  const text = menuCommand(message.text);
  if (!vocabularyCommand(text) && (!message.reply_to_message || text.startsWith("/"))) return false;
  if (!message.from || message.from.is_bot || message.from.id !== message.chat.id || !isPositiveId(message.message_id)) return true;
  const response = await vocabularyStore.process(message.from.id, message.message_id, text, message.reply_to_message?.message_id);
  if (!response) return false;
  if (response.deliveredMessageId) return true;
  const sent = await deliver(message.from.id, response);
  await vocabularyStore.delivered(message.from.id, BigInt(message.message_id), sent);
  return true;
}
export async function handleCallbackQuery(value: unknown): Promise<boolean> {
  if (!isRecord(value) || !isQueryId(value.id)) return false;
  if (!isPrivateCallbackQuery(value) || !validCallbackData(value.data)) {
    await answerCallbackQuery({ callback_query_id: value.id, text: "Кнопка недоступна. Откройте /menu в личном чате.", show_alert: true });
    return true;
  }
  // Dismiss Telegram's spinner before database work; every valid query is answered.
  await answerCallbackQuery({ callback_query_id: value.id });
  const response = await vocabularyStore.process(value.from.id, value.message.message_id, value.data, undefined, value.id);
  if (!response || response.deliveredMessageId) return true;
  const sent = await deliver(value.from.id, response, value.message.message_id);
  if (response.learn) {
    const requestId = Number(-callbackReceiptKey(value.id) % (BigInt(1) << BigInt(48))) + 2 ** 50;
    await sendQuiz(value.from.id, value.from.id, response.learn, requestId);
  }
  await vocabularyStore.delivered(value.from.id, callbackReceiptKey(value.id), sent);
  return true;
}
