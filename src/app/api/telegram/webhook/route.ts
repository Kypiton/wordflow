import { handleVocabularyMessage, handleCallbackQuery } from "../../../../lib/telegram/vocabulary";
import { MAIN_KEYBOARD, MENU_TEXT, HELP_TEXT, menuCommand } from "../../../../lib/telegram/navigation";
import { sendMessage } from "../../../../lib/telegram/client";
import { isTelegramUpdate } from "../../../../lib/telegram/types";
import { handleWidgetQuery, sendQuiz } from "../../../../lib/telegram/quiz";
import {
  isValidWebhookSecret,
  startChatId,
  verifyWebhookSecret,
  commandChatId,
  readUpdate,
} from "../../../../lib/telegram/webhook";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!isValidWebhookSecret(secret)) {
    return Response.json({ error: "Webhook is not configured." }, { status: 503 });
  }
  if (!verifyWebhookSecret(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let update: unknown;
  try {
    update = await readUpdate(request);
  } catch {
    return Response.json({ error: "Invalid update." }, { status: 400 });
  }
  if (!isTelegramUpdate(update)) {
    return Response.json({ error: "Invalid update." }, { status: 400 });
  }

  if (update.callback_query !== undefined) {
    try {
      const handled = await handleCallbackQuery(update.callback_query);
      return Response.json({ ok: handled }, { status: handled ? 200 : 400 });
    } catch { return Response.json({ error: "Unable to handle callback." }, { status: 502 }); }
  }
  if (update.message?.text) update.message.text = menuCommand(update.message.text);
  if (update.widget_query !== undefined) {
    try {
      const handled = await handleWidgetQuery(update.widget_query);
      return handled ? Response.json({ ok: true })
        : Response.json({ error: "Invalid widget query." }, { status: 400 });
    } catch {
      return Response.json({ error: "Unable to answer widget query." }, { status: 502 });
    }
  }

  try {
    if (await handleVocabularyMessage(update.message)) return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Unable to handle vocabulary request." }, { status: 502 });
  }

  const isResume = commandChatId(update, "resume") !== undefined;
  const mode = commandChatId(update, "review") !== undefined ? "REVIEW" : "LEARN";
  const learnChatId = isResume ? commandChatId(update, "resume") : commandChatId(update, mode === "REVIEW" ? "review" : "learn");
  if (learnChatId !== undefined) {
    const user = update.message?.from;
    if (!user || user.is_bot || user.id !== learnChatId) {
      return Response.json({ error: "Invalid quiz sender." }, { status: 400 });
    }
    try {
      await sendQuiz(user.id, learnChatId, mode, update.message?.message_id, isResume);
    } catch {
      return Response.json({ error: "Unable to send quiz." }, { status: 502 });
    }
    return Response.json({ ok: true });
  }

  const chatId = startChatId(update) ?? commandChatId(update, "menu") ?? commandChatId(update, "help");
  if (chatId !== undefined) {
    try {
      await sendMessage({ chat_id: chatId, text: commandChatId(update, "help") !== undefined ? HELP_TEXT : MENU_TEXT, reply_markup: MAIN_KEYBOARD });
    } catch {
      // A failed delivery must not be acknowledged as successful.
      return Response.json({ error: "Unable to send welcome message." }, { status: 502 });
    }
  }
  return Response.json({ ok: true });
}
