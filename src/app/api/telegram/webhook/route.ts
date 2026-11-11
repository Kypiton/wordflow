import { sendMessage } from "../../../../lib/telegram/client";
import { isTelegramUpdate } from "../../../../lib/telegram/types";
import {
  isValidWebhookSecret,
  startChatId,
  verifyWebhookSecret,
  WELCOME_MESSAGE,
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
    update = await request.json();
  } catch {
    return Response.json({ error: "Invalid update." }, { status: 400 });
  }
  if (!isTelegramUpdate(update)) {
    return Response.json({ error: "Invalid update." }, { status: 400 });
  }

  const chatId = startChatId(update);
  if (chatId !== undefined) {
    try {
      await sendMessage({ chat_id: chatId, text: WELCOME_MESSAGE });
    } catch {
      // A failed delivery must not be acknowledged as successful.
      return Response.json({ error: "Unable to send welcome message." }, { status: 502 });
    }
  }
  return Response.json({ ok: true });
}
