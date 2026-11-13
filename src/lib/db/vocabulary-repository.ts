import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "../../generated/prisma/client";
import { getDatabase } from "./prisma";
import { button, MODE_LABELS, STATE_LABELS, SAVED_ACTIONS, EMPTY_ACTIONS, modePicker, levelPicker, LEVEL_LABELS, MENU_TEXT, MENU_ACTIONS, validCallbackData } from "../telegram/navigation";
import { isPositiveId, isQueryId } from "../telegram/types";
import { VocabularyInputError, confirmation, englishTerm, optionalField, russianTranslation, splitEntry, vocabularyCommand } from "../vocabulary/domain";
import type { DraftData, VocabularyMode, VocabularyResponse } from "../vocabulary/domain";

export class VocabularyRepository {
  constructor(private database: () => PrismaClient = getDatabase) { }
  async bindPrompt(userId: number, token: string, messageId: number): Promise<void> {
    if (!isPositiveId(userId) || !isPositiveId(messageId) || !/^[a-f0-9]{24}$/.test(token)) throw new Error("Invalid prompt.");
    await this.database().vocabularyDraft.updateMany({ where: { userId: BigInt(userId), token }, data: { promptMessageId: BigInt(messageId) } });
  }
  async delivered(userId: number, receipt: bigint, messageId: number): Promise<void> {
    const key = { userId: BigInt(userId), messageId: receipt };
    const old = await this.database().vocabularyReceipt.findUnique({ where: { userId_messageId: key } });
    if (old) await this.database().vocabularyReceipt.update({ where: { userId_messageId: key }, data: { response: { ...(old.response as VocabularyResponse), deliveredMessageId: messageId } as Prisma.InputJsonValue } });
  }
  async process(userId: number, messageId: number, text: string, replyTo?: number, callbackId?: string): Promise<VocabularyResponse | null> {
    if (!isPositiveId(userId) || !isPositiveId(messageId) || typeof text !== "string" || (replyTo !== undefined && !isPositiveId(replyTo))) throw new Error("Invalid vocabulary request.");
    if (callbackId !== undefined && (!isQueryId(callbackId) || !validCallbackData(text))) throw new Error("Invalid callback.");
    let command = vocabularyCommand(text);
    const callback = callbackId ? text.split(":").slice(1) : null;
    if (callback) {
      const [action, arg, page] = callback;
      command = {
        name: ({ save: "confirm", settings: "mode", learn: "mode", list: "mywords", archive: "delete" } as Record<string, string>)[action] ?? action,
        args: action === "list" ? `${arg === "x" ? "archived " : ""}${page}` : arg ?? ""
      };
    }
    const receipt = callbackId ? callbackReceiptKey(callbackId) : BigInt(messageId);
    if (!command && !replyTo) return null;
    if (text.length > 1000) return { text: "Сообщение слишком длинное (не более 1000 символов)." };
    const fingerprint = createHash("sha256").update(JSON.stringify([text, replyTo ?? null, callbackId ?? null, callbackId ? messageId : null])).digest("hex");
    const user = BigInt(userId);
    return this.database().$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
      await tx.telegramUser.createMany({ data: [{ id: user }], skipDuplicates: true });
      await tx.$queryRaw`SELECT id FROM "TelegramUser" WHERE id = ${user} FOR UPDATE`;
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const old = await tx.vocabularyReceipt.findUnique({ where: { userId_messageId: { userId: user, messageId: receipt } } });
      if (old) return old.fingerprint === fingerprint ? old.response as VocabularyResponse : { text: "Неверный повтор запроса." };
      const latest = await tx.vocabularyReceipt.findFirst({ where: { userId: user, messageId: { gt: 0 } }, orderBy: { messageId: "desc" }, select: { messageId: true } });
      if (!callbackId && latest && latest.messageId > BigInt(messageId)) return { text: "Это сообщение устарело. Повторите команду новым сообщением." };
      const draft = await tx.vocabularyDraft.findUnique({ where: { userId: user } });
      if (!command && (!draft || draft.promptMessageId !== BigInt(replyTo!))) return null;
      const owner = await tx.telegramUser.findUniqueOrThrow({ where: { id: user } });
      const count = owner.vocabularyWindowAt && clock.now.getTime() - owner.vocabularyWindowAt.getTime() < 60_000 ? owner.vocabularyRequestCount : 0;
      if (count >= 20) return { text: "Слишком много действий. Подождите минуту и повторите команду." };
      await tx.telegramUser.update({ where: { id: user }, data: { vocabularyWindowAt: count ? owner.vocabularyWindowAt : clock.now, vocabularyRequestCount: count + 1 } });
      const saveDraft = async (data: DraftData) => {
        data = JSON.parse(JSON.stringify(data)) as DraftData;
        const token = randomBytes(12).toString("hex");
        await tx.vocabularyDraft.upsert({
          where: { userId: user }, create: { userId: user, token, data: data as Prisma.InputJsonValue, expiresAt: new Date(clock.now.getTime() + 600_000) },
          update: { token, data: data as Prisma.InputJsonValue, promptMessageId: null, expiresAt: new Date(clock.now.getTime() + 600_000) }
        });
        const awaiting = data.awaiting ?? (!data.translation && ["add", "edit"].includes(data.kind) ? "translation" : undefined);
        if (!awaiting) return confirmation(data, token);
        const prompts = { term: "Какое английское слово или выражение добавить?", translation: `Как перевести «${data.term}» на русский?`, pos: `Укажите часть речи для «${data.term}». «-» очищает поле.`, example: `Напишите пример для «${data.term}». «-» очищает поле.` };
        return { text: `${prompts[awaiting]}\nОтветьте на это сообщение. Действует 10 минут. Отмена — /cancel. Главное меню — /menu.`, promptToken: token, forceReply: true };

      };
      const listResponse = async (args: string): Promise<VocabularyResponse> => {
        const match = /^(?:(archived)(?:\s+|$))?([1-9][0-9]{0,2})?$/.exec(args.trim());
        if (!match) return { text: "Формат: /mywords 1 или /mywords archived 1." };
        const page = Number(match[2] ?? 1), archived = Boolean(match[1]);
        const total = await tx.personalWord.count({ where: { ownerId: user } });
        const where = { ownerId: user, archivedAt: archived ? { not: null } : null };
        const count = await tx.personalWord.count({ where });
        const pages = Math.max(1, Math.ceil(count / 5));
        if (page > pages) return { text: `Такой страницы нет. Страниц: ${pages}.` };
        const words = await tx.personalWord.findMany({
          where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * 5, take: 5,
          include: { versions: { where: { isCurrent: true }, include: { progress: { where: { userId: user } } } } }
        });
        const rows = words.map(entry => { const word = entry.versions[0]; return `${word.term} — ${word.translation}${word.partOfSpeech ? ` (${word.partOfSpeech})` : ""}\n${STATE_LABELS[word.progress[0]?.state ?? "NEW"]}`; });
        const active = await tx.personalWord.count({ where: { ownerId: user, archivedAt: null } });
        return {
          text: `Мои слова: ${total} всего · активных: ${active}\n${archived ? "Архив · " : ""}Страница ${page}/${pages}\n\n${rows.join("\n\n") || "Здесь пока пусто. Добавьте первое слово."}`, keyboard: {
            inline_keyboard: [
              ...words.map(entry => [button(entry.versions[0].term.slice(0, 40), `word:${entry.id}`)]),
              [...(page > 1 ? [button("◀️", `list:${archived ? "x" : "a"}:${page - 1}`)] : []), ...(page < pages ? [button("▶️", `list:${archived ? "x" : "a"}:${page + 1}`)] : [])],
              [button(archived ? "Активные" : "Архив", `list:${archived ? "a" : "x"}:1`), button("➕ Добавить", "add")], [button("Главное меню", "menu")],
            ].filter(row => row.length)
          }
        };

      };
      const run = async (): Promise<VocabularyResponse> => {
        const name = command?.name ?? "translation", args = command?.args ?? text;
        if (name === "menu") return { text: MENU_TEXT, keyboard: MENU_ACTIONS };
        if (name === "review") return { text: "Открываем повторение…", learn: "REVIEW" };
        if (callback && ["word", "edit", "pos", "example", "archive", "restore"].includes(callback[0])) {
          const entry = await tx.personalWord.findFirst({ where: { id: callback[1], ownerId: user }, include: { versions: { where: { isCurrent: true }, include: { progress: { where: { userId: user } } } } } });
          const word = entry?.versions[0];
          if (!entry || !word) return { text: "Слово недоступно. Обновите список.", keyboard: SAVED_ACTIONS };
          if (callback[0] === "word") return {
            text: `${word.term} — ${word.translation}\n${word.partOfSpeech ? `Часть речи: ${word.partOfSpeech}\n` : ""}${word.example ? `Пример: ${word.example}\n` : ""}Статус: ${entry.archivedAt ? "В архиве" : STATE_LABELS[word.progress[0]?.state ?? "NEW"]}`,
            keyboard: {
              inline_keyboard: [
                ...(entry.archivedAt ? [] : [[button("✏️ Перевод", `edit:${entry.id}`)], [button("Пример", `example:${entry.id}`), button("Часть речи", `pos:${entry.id}`)]]),
                [button(entry.archivedAt ? "♻️ Восстановить" : "🗃 Архивировать", `${entry.archivedAt ? "restore" : "archive"}:${entry.id}`)],
                [button("◀️ Назад", `list:${entry.archivedAt ? "x" : "a"}:1`), button("Главное меню", "menu")]]
            }
          };
          const action = callback[0];
          return saveDraft({
            kind: action === "archive" ? "delete" : action === "restore" ? "restore" : "edit", term: word.term,
            translation: action === "edit" ? undefined : word.translation!, partOfSpeech: word.partOfSpeech, example: word.example, wordId: entry.id, versionId: word.id,
            ...(["edit", "pos", "example"].includes(action) ? { awaiting: action === "edit" ? "translation" : action as "pos" | "example" } : {})
          });
        }
        if (["translation", "confirm", "cancel"].includes(name)) {
          if (!draft || draft.expiresAt <= clock.now) return { text: "Действие истекло или отсутствует. Начните с /add или /edit." };
          const data = draft.data as DraftData;
          if (name === "translation") {
            const awaiting = data.awaiting ?? (!data.translation ? "translation" : undefined);
            if (!awaiting || !["add", "edit"].includes(data.kind)) return { text: "Используйте кнопки под последним подтверждением." };
            if (awaiting === "term") return saveDraft({ ...data, term: englishTerm(args), awaiting: "translation" });
            if (awaiting === "pos") return saveDraft({ ...data, partOfSpeech: optionalField(args, "pos") ?? "", awaiting: undefined });
            if (awaiting === "example") return saveDraft({ ...data, example: optionalField(args, "example"), awaiting: undefined });
            return saveDraft({ ...data, translation: russianTranslation(args), awaiting: undefined });
          }
          if (callbackId && draft.promptMessageId !== BigInt(messageId)) return { text: "Кнопка устарела. Откройте последнее подтверждение." };

          if (name === "confirm" && data.awaiting) return { text: "Сначала ответьте на вопрос под последним сообщением." };
          if (args.trim() !== draft.token && !(name === "cancel" && !args.trim() && !callbackId)) return { text: "Подтверждение устарело. Начните действие заново." };
          if (name === "cancel") {
            await tx.vocabularyDraft.delete({ where: { userId: user } }); return { text: "Отменено. Словарь не изменён.", keyboard: SAVED_ACTIONS };
          }
          if (data.kind === "add") {
            if (!data.translation || data.awaiting) return { text: "Сначала ответьте на вопрос о переводе." };
            const exists = await tx.personalWord.findUnique({ where: { ownerId_termKey: { ownerId: user, termKey: data.term.toLowerCase() } } });
            if (exists) return { text: exists.archivedAt ? "Слово уже в архиве. Используйте /restore слово." : "Это слово уже есть в вашем словаре. Используйте /edit слово." };
            if (await tx.personalWord.count({ where: { ownerId: user } }) >= 500) return { text: "Лимит словаря: 500 слов, включая архив." };
            const id = randomUUID();
            await tx.personalWord.create({ data: { id, ownerId: user, termKey: data.term.toLowerCase(), versions: { create: { slug: `p-${id}`, term: data.term, translation: data.translation, partOfSpeech: data.partOfSpeech, example: data.example } } } });
          } else {
            const entry = await tx.personalWord.findFirst({ where: { id: data.wordId, ownerId: user }, include: { versions: { where: { isCurrent: true } } } });
            const current = entry?.versions[0];
            if (!entry || !current || current.id !== data.versionId) return { text: "Слово изменилось. Начните действие заново." };
            if (data.kind === "edit") {
              if (entry.archivedAt || !data.translation) return { text: "Сначала восстановите слово: /restore слово." };
              await tx.word.update({ where: { id: current.id }, data: { isCurrent: false } });
              await tx.word.create({ data: { personalWordId: entry.id, slug: current.slug, version: current.version + 1, term: current.term, translation: data.translation, partOfSpeech: data.partOfSpeech, example: data.example } });
            } else await tx.personalWord.update({ where: { id: entry.id }, data: { archivedAt: data.kind === "delete" ? clock.now : null } });
          }
          await tx.vocabularyDraft.delete({ where: { userId: user } });
          if (data.kind !== "add") {
            const list = await listResponse(data.kind === "delete" ? "archived 1" : "1");
            return { ...list, text: `${data.kind === "delete" ? "Слово архивировано. История сохранена." : data.kind === "restore" ? "Слово восстановлено." : "Сохранено!"}\n\n${list.text}` };
          }
          return { text: "Сохранено!", keyboard: SAVED_ACTIONS };
        }
        if (name === "level") {
          const chosen = args.trim().toUpperCase();
          if (!chosen) return { text: `Уровень: ${owner.cefrLevel ? LEVEL_LABELS[owner.cefrLevel] : "Все уровни"}.\nФильтр применяется к общему словарю со следующего занятия. Личные слова остаются доступными.`, keyboard: levelPicker(owner.cefrLevel) };
          if (!["ALL", "A1", "A2", "B1", "B2", "C1"].includes(chosen)) return { text: "Выберите уровень кнопкой ниже.", keyboard: levelPicker(owner.cefrLevel) };
          const level = chosen === "ALL" ? null : chosen as keyof typeof LEVEL_LABELS;
          await tx.telegramUser.update({ where: { id: user }, data: { cefrLevel: level } });
          return { text: `Уровень: ${level ? LEVEL_LABELS[level] : "Все уровни"}. Изменение действует со следующего занятия; текущая сессия сохраняется.`, keyboard: levelPicker(level) };
        }
        if (name === "mode" || name === "choose") {
          const mode = args.trim().toUpperCase();
          if (!mode) return { text: `Словарь: ${MODE_LABELS[owner.vocabularyMode]}.\nУровень: ${owner.cefrLevel ? LEVEL_LABELS[owner.cefrLevel] : "Все уровни"}.\nВыбор сохраняется для следующих занятий. Активное занятие не меняется.`, keyboard: modePicker(owner.vocabularyMode, name === "choose") };
          if (!["GENERAL", "PERSONAL", "MIXED"].includes(mode)) return { text: "Выберите словарь кнопкой ниже.", keyboard: modePicker(owner.vocabularyMode) };
          await tx.telegramUser.update({ where: { id: user }, data: { vocabularyMode: mode as VocabularyMode } });
          return { text: `Выбран словарь «${MODE_LABELS[mode as VocabularyMode]}». Активное занятие не изменено.`, keyboard: modePicker(mode as VocabularyMode), ...(callback?.[0] === "learn" ? { learn: "LEARN" as const } : {}) };
        }
        if (name === "mywords") return listResponse(args);
        if (name === "add" && !args.trim()) return saveDraft({ kind: "add", term: "", partOfSpeech: "", example: null, awaiting: "term" });
        const [term, value] = splitEntry(args);
        if (name === "add") {
          const exists = await tx.personalWord.findUnique({ where: { ownerId_termKey: { ownerId: user, termKey: term.toLowerCase() } } });
          if (exists) return { text: exists.archivedAt ? "Слово уже в архиве. Используйте /restore слово." : "Это слово уже есть в вашем словаре. Используйте /edit слово." };
          return saveDraft({ kind: "add", term, translation: value === undefined ? undefined : russianTranslation(value), partOfSpeech: "", example: null });
        }
        const entry = await tx.personalWord.findUnique({ where: { ownerId_termKey: { ownerId: user, termKey: englishTerm(term).toLowerCase() } }, include: { versions: { where: { isCurrent: true } } } });
        if (!entry) return { text: "Слово не найдено в вашем словаре. /mywords — список." };
        const word = entry.versions[0];
        if (["delete", "restore"].includes(name) && value !== undefined) return { text: `Формат: /${name} слово.` };
        const data: DraftData = { kind: name === "delete" ? "delete" : name === "restore" ? "restore" : "edit", term: word.term, translation: word.translation!, partOfSpeech: word.partOfSpeech, example: word.example, wordId: entry.id, versionId: word.id };
        if (name === "edit") data.translation = value === undefined ? undefined : russianTranslation(value);
        if (name === "pos" || name === "example") {
          if (value === undefined) return { text: `Формат: /${name} слово — значение. «-» очищает поле.` };
          const field = optionalField(value, name);
          if (name === "pos") data.partOfSpeech = field ?? ""; else data.example = field;
        }
        return saveDraft(data);
      };
      let response: VocabularyResponse;
      try { response = await run(); } catch (error) {
        // Only validation errors are displayed, never Prisma/network error details.
        if (!(error instanceof VocabularyInputError)) throw error;
        const pending = draft?.data as DraftData | undefined;
        const awaiting = pending?.awaiting || (pending && !pending.translation && ["add", "edit"].includes(pending.kind));
        response = {
          text: error.message, ...(draft && awaiting && (!command || command.name === "translation")
            ? { promptToken: draft.token, forceReply: true } : {}), keyboard: EMPTY_ACTIONS
        };
      }
      if (!response.keyboard && !response.forceReply) response.keyboard = SAVED_ACTIONS;
      await tx.vocabularyReceipt.create({ data: { userId: user, messageId: receipt, fingerprint, response: response as Prisma.InputJsonValue } });
      return response;
    });
  }
}

/** Negative receipt namespace cannot collide with positive Telegram message IDs.
 * Include the full callback ID in the fingerprint so a hash collision fails closed. */
export function callbackReceiptKey(id: string): bigint {
  return -(BigInt(`0x${createHash("sha256").update(id).digest("hex").slice(0, 15)}`) + BigInt(1));
}
