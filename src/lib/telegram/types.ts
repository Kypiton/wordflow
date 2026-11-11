/** Minimal Bot API shapes used by WordFlow; unknown update fields are allowed. */
export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
  from?: { id: number; is_bot: boolean };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  // Parse separately so a query with a usable id can receive a safe error.
  widget_query?: unknown;
}

export interface SendMessageRequest {
  chat_id: number;
  text: string;
}

export interface SendWidgetRequest {
  chat_id: number;
  html: string;
  allow_queries: true;
  caption?: string;
}

export interface AnswerWidgetQueryRequest {
  widget_query_id: string;
  data: string;
}

export interface PrivateWidgetQuery {
  id: string;
  from: { id: number; is_bot: false };
  chat: { id: number; type: "private" };
  message_id: number;
  chat_instance: string;
  type: { type: "data" };
  data: string;
}

export function isPositiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isQueryId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function isPrivateWidgetQuery(value: unknown): value is PrivateWidgetQuery {
  return isRecord(value) && isQueryId(value.id) &&
    isRecord(value.from) && isPositiveId(value.from.id) && value.from.is_bot === false &&
    isRecord(value.chat) && isPositiveId(value.chat.id) && value.chat.type === "private" &&
    value.chat.id === value.from.id && isPositiveId(value.message_id) &&
    isQueryId(value.chat_instance) && isRecord(value.type) && value.type.type === "data" &&
    value.inline_message_id === undefined && value.widget_id === undefined &&
    typeof value.data === "string" && Buffer.byteLength(value.data, "utf8") >= 1 &&
    Buffer.byteLength(value.data, "utf8") <= 64;
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
    (value.from === undefined || (isRecord(value.from) && isPositiveId(value.from.id) && typeof value.from.is_bot === "boolean")) &&
    (value.text === undefined || typeof value.text === "string");
}

export function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return isRecord(value) && Number.isSafeInteger(value.update_id) &&
    (value.update_id as number) >= 0 &&
    !(value.message !== undefined && value.widget_query !== undefined) &&
    (value.message === undefined || isTelegramMessage(value.message));
}
