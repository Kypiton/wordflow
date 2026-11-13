import type { InlineKeyboardMarkup } from "../telegram/types";
import { button } from "../telegram/navigation";
export class VocabularyInputError extends Error {}
export type VocabularyMode = "GENERAL" | "PERSONAL" | "MIXED";
export type DraftData = { kind: "add" | "edit" | "delete" | "restore"; term: string; awaiting?: "term" | "translation" | "pos" | "example"; translation?: string; partOfSpeech: string; example: string | null; wordId?: string; versionId?: string };
export type VocabularyResponse = { text: string; promptToken?: string; keyboard?: InlineKeyboardMarkup; forceReply?: boolean; learn?: "LEARN" | "REVIEW"; deliveredMessageId?: number; replayed?: boolean };
const commands = new Set(["add", "translation", "confirm", "cancel", "mywords", "edit", "example", "pos", "delete", "restore", "mode", "choose"]);
export function vocabularyCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match && commands.has(match[1]) ? { name: match[1], args: match[2] ?? "" } : null;
}
export function normalizeText(value: string, max: number, bytes = max * 2): string {
  if (value.length > 1000 || /[\p{Cf}\p{Cs}]/u.test(value) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new VocabularyInputError("Недопустимые символы.");
  const result = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!result || result.length > max || Buffer.byteLength(JSON.stringify(result), "utf8") > bytes + 2) throw new VocabularyInputError(`Введите от 1 до ${max} символов.`);
  return result;
}
export function englishTerm(value: string): string {
  const term = normalizeText(value, 80).replace(/[‘’]/g, "'").replace(/[‐‑]/g, "-");
  if (!/[A-Za-z]/.test(term) || !/^[A-Za-z0-9][A-Za-z0-9 '.,!?()&/\-]*$/.test(term)) throw new VocabularyInputError("Введите английское слово или выражение (до 80 символов).");
  return term;
}
export function russianTranslation(value: string): string {
  const text = normalizeText(value, 120, 240);
  if (!/[А-Яа-яЁё]/.test(text)) throw new VocabularyInputError("Введите перевод на русском языке.");
  return text;
}
export function splitEntry(args: string): [string, string | undefined] {
  const parts = args.split(/\s+[—–]\s+|\s+-\s+/u);
  if (parts.length > 2) throw new VocabularyInputError("Формат: /add word — перевод.");
  return [englishTerm(parts[0]), parts[1]];
}
export function optionalField(value: string, field: "pos" | "example"): string | null {
  if (value.trim() === "-") return null;
  const text = normalizeText(value, field === "pos" ? 40 : 160, field === "pos" ? 80 : 320);
  if (field === "pos" && !/^[A-Za-zА-Яа-яЁё -]+$/.test(text)) throw new VocabularyInputError("Часть речи: например adjective, verb или noun; «-» очищает поле.");
  return text;
}
export function confirmation(data: DraftData, token: string): VocabularyResponse {
  const title = data.kind === "delete" ? "Архивировать слово?" : data.kind === "restore" ? "Восстановить слово?" : "Сохранить слово?";
  return { text: `${title}\n\n${data.term}${data.translation ? ` — ${data.translation}` : ""}\n${data.partOfSpeech ? `Часть речи: ${data.partOfSpeech}\n` : ""}${data.example ? `Пример: ${data.example}\n` : ""}\nПодтверждение действует 10 минут.`, promptToken: token,
    keyboard: { inline_keyboard: [[button(data.kind === "delete" ? "Архивировать" : data.kind === "restore" ? "Восстановить" : "Сохранить", `save:${token}`), button("Отмена", `cancel:${token}`)]] } };
}
