import type { InlineKeyboardMarkup, ReplyKeyboardMarkup } from "./types";
export const MODE_LABELS = { GENERAL: "Общий словарь", PERSONAL: "Мои слова", MIXED: "Все слова" } as const;
export const LEVEL_LABELS = { A1: "A1 · Начальный", A2: "A2 · Базовый", B1: "B1 · Средний", B2: "B2 · Выше среднего", C1: "C1 · Продвинутый" } as const;
export const STATE_LABELS: Record<string, string> = { NEW: "Новое", LEARNING: "Изучается", REVIEW: "На повторении", MASTERED: "Хорошо знакомо" };
export const MAIN_KEYBOARD: ReplyKeyboardMarkup = { keyboard: [[{ text: "📚 Учить слова" }, { text: "🔁 Повторить" }], [{ text: "📖 Мой словарь" }, { text: "➕ Добавить слово" }], [{ text: "▶️ Продолжить занятие" }], [{ text: "⚙️ Настройки" }]], resize_keyboard: true, is_persistent: true };
export const MENU_TEXT = "Добро пожаловать в WordFlow!\n\nУчить — знакомиться с новыми словами.\nПовторить — вспомнить слова, срок повторения которых наступил.\n\nДобавьте свои слова или начните с общего словаря. Выберите действие в меню ниже.";
export const HELP_TEXT = "Учите английские слова прямо в Telegram.\n\nДобавьте слово и перевод, сохраните одним нажатием. В «Мой словарь» можно изменить слово или убрать его в архив.\n\nВ карточке вспомните перевод, откройте его и честно оцените себя. WordFlow подскажет, когда повторить.\n\nСловарь и уровень A1–C1 выбираются в настройках и действуют со следующего занятия. «▶️ Продолжить занятие» возвращает активную карточку вниз переписки. /menu всегда возвращает главное меню.";
export const button = (text: string, data: string) => ({ text, callback_data: `v1:${data}` });
export const EMPTY_ACTIONS: InlineKeyboardMarkup = { inline_keyboard: [[button("Сменить словарь", "settings"), button("🔁 Повторить", "review")], [button("➕ Добавить слово", "add"), button("Главное меню", "menu")]] };
export const SAVED_ACTIONS: InlineKeyboardMarkup = { inline_keyboard: [[button("➕ Добавить ещё", "add")], [button("📚 Учить мои слова", "learn:PERSONAL")], [button("📖 Мой словарь", "list:a:1"), button("Главное меню", "menu")]] };
export function modePicker(selected: keyof typeof MODE_LABELS, learn = false): InlineKeyboardMarkup {
  return { inline_keyboard: Object.entries(MODE_LABELS).map(([key, label]) => [button(`${key === selected ? "✓ " : ""}${label}`, `${learn ? "learn" : "mode"}:${key}`)]).concat([[button("🎯 Уровень английского", "level")], [button("Главное меню", "menu")]]) };
}
export function levelPicker(selected: keyof typeof LEVEL_LABELS | null): InlineKeyboardMarkup {
  return { inline_keyboard: [
    [button(`${selected === null ? "✓ " : ""}Все уровни`, "level:ALL")],
    ...Object.entries(LEVEL_LABELS).map(([level, label]) => [button(`${selected === level ? "✓ " : ""}${label}`, `level:${level}`)]),
    [button("◀️ Настройки", "settings"), button("Главное меню", "menu")],
  ] };
}
export function menuCommand(text: string): string {
  return ({ "📚 Учить слова": "/choose", "🔁 Повторить": "/review", "📖 Мой словарь": "/mywords", "➕ Добавить слово": "/add", "⚙️ Настройки": "/mode", "▶️ Продолжить занятие": "/resume" } as Record<string, string>)[text] ?? text;
}
export function validCallbackData(data: unknown): data is string {
  return typeof data === "string" && Buffer.byteLength(data) <= 64 && /^v1:(?:menu|settings|choose|add|review|level(?::(?:ALL|A1|A2|B1|B2|C1))?|(?:mode|learn):(?:GENERAL|PERSONAL|MIXED)|(?:save|cancel):[a-f0-9]{24}|list:[ax]:[1-9][0-9]{0,2}|(?:word|edit|pos|example|archive|restore):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(data);
}

export const MENU_ACTIONS: InlineKeyboardMarkup = { inline_keyboard: [[button("📚 Учить слова", "choose"), button("🔁 Повторить", "review")], [button("📖 Мой словарь", "list:a:1"), button("➕ Добавить слово", "add")], [button("⚙️ Настройки", "settings")]] };
