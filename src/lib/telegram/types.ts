/** Minimal Bot API shapes used by WordFlow; unknown update fields are allowed. */
export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface SendMessageRequest {
  chat_id: number;
  text: string;
}

export type TelegramResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code: number; description?: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTelegramMessage(value: unknown): value is TelegramMessage {
  return isRecord(value) && Number.isSafeInteger(value.message_id) &&
    isRecord(value.chat) && Number.isSafeInteger(value.chat.id) &&
    typeof value.chat.type === "string" &&
    (value.text === undefined || typeof value.text === "string");
}

export function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return isRecord(value) && Number.isSafeInteger(value.update_id) &&
    (value.message === undefined || isTelegramMessage(value.message));
}
