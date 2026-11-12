import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "../../generated/prisma/client";
import { getDatabase } from "./prisma";
import { isPositiveId } from "../telegram/types";
import { VocabularyInputError, confirmation, englishTerm, optionalField, russianTranslation, splitEntry, vocabularyCommand } from "../vocabulary/domain";
import type { DraftData, VocabularyMode, VocabularyResponse } from "../vocabulary/domain";
  
export class VocabularyRepository {
  constructor(private database: () => PrismaClient = getDatabase) {}
  async bindPrompt(userId: number, token: string, messageId: number): Promise<void> {
    if (!isPositiveId(userId) || !isPositiveId(messageId) || !/^[a-f0-9]{24}$/.test(token)) throw new Error("Invalid prompt.");
    await this.database().vocabularyDraft.updateMany({ where: { userId: BigInt(userId), token }, data: { promptMessageId: BigInt(messageId) } });
  }
  async process(userId: number, messageId: number, text: string, replyTo?: number): Promise<VocabularyResponse | null> {
    if (!isPositiveId(userId) || !isPositiveId(messageId) || typeof text !== "string" || (replyTo !== undefined && !isPositiveId(replyTo))) throw new Error("Invalid vocabulary request.");
    const command = vocabularyCommand(text);
    if (!command && !replyTo) return null;
    if (text.length > 1000) return { text: "Сообщение слишком длинное (не более 1000 символов)." };
    const fingerprint = createHash("sha256").update(JSON.stringify([text, replyTo ?? null])).digest("hex");
    const user = BigInt(userId);
    return this.database().$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
      await tx.telegramUser.createMany({ data: [{ id: user }], skipDuplicates: true });
      await tx.$queryRaw`SELECT id FROM "TelegramUser" WHERE id = ${user} FOR UPDATE`;
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const old = await tx.vocabularyReceipt.findUnique({ where: { userId_messageId: { userId: user, messageId: BigInt(messageId) } } });
      if (old) return old.fingerprint === fingerprint ? old.response as VocabularyResponse : { text: "Неверный повтор запроса." };
      const latest = await tx.vocabularyReceipt.findFirst({ where: { userId: user }, orderBy: { messageId: "desc" }, select: { messageId: true } });
      if (latest && latest.messageId > BigInt(messageId)) return { text: "Это сообщение устарело. Повторите команду новым сообщением." };
      const draft = await tx.vocabularyDraft.findUnique({ where: { userId: user } });
      if (!command && (!draft || draft.promptMessageId !== BigInt(replyTo!))) return null;
      const owner = await tx.telegramUser.findUniqueOrThrow({ where: { id: user } });
      const count = owner.vocabularyWindowAt && clock.now.getTime() - owner.vocabularyWindowAt.getTime() < 60_000 ? owner.vocabularyRequestCount : 0;
      if (count >= 20) return { text: "Слишком много действий. Подождите минуту и повторите команду." };
      await tx.telegramUser.update({ where: { id: user }, data: { vocabularyWindowAt: count ? owner.vocabularyWindowAt : clock.now, vocabularyRequestCount: count + 1 } });
      const saveDraft = async (data: DraftData) => {
        data = JSON.parse(JSON.stringify(data)) as DraftData;
        const token = randomBytes(12).toString("hex");
        await tx.vocabularyDraft.upsert({ where: { userId: user }, create: { userId: user, token, data: data as Prisma.InputJsonValue, expiresAt: new Date(clock.now.getTime() + 600_000) },
          update: { token, data: data as Prisma.InputJsonValue, promptMessageId: null, expiresAt: new Date(clock.now.getTime() + 600_000) } });
        return data.translation || data.kind === "delete" || data.kind === "restore" ? confirmation(data, token)
          : { text: `Как перевести «${data.term}»? Ответьте на это сообщение по-русски или отправьте /translation перевод.\nОтмена: /cancel ${token}\nДействует 10 минут.`, promptToken: token };
      };
      const run = async (): Promise<VocabularyResponse> => {
        const name = command?.name ?? "translation", args = command?.args ?? text;
        if (["translation", "confirm", "cancel"].includes(name)) {
          if (!draft || draft.expiresAt <= clock.now) return { text: "Действие истекло или отсутствует. Начните с /add или /edit." };
          const data = draft.data as DraftData;
          if (name === "translation") {
            if (data.translation || !["add", "edit"].includes(data.kind)) return { text: "Перевод сейчас не ожидается. Используйте /confirm или /cancel с кодом из сообщения." };
            return saveDraft({ ...data, translation: russianTranslation(args) });
          }
          if (args.trim() !== draft.token) return { text: "Неверный код подтверждения. Используйте код из последнего сообщения." };
          if (name === "cancel") {
            await tx.vocabularyDraft.delete({ where: { userId: user } }); return { text: "Отменено. Словарь не изменён." };
          }
          if (data.kind === "add") {
            if (!data.translation) return { text: "Сначала отправьте /translation перевод." };
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
          return { text: data.kind === "delete" ? "Слово архивировано. История сохранена. Вернуть: /restore слово." : data.kind === "restore" ? "Слово восстановлено. История сохранена." : "Сохранено! /mywords — словарь. /mode PERSONAL — учить свои слова." };
        }
        if (name === "mode") {
          const mode = args.trim().toUpperCase();
          if (!mode) return { text: `Режим: ${owner.vocabularyMode}.\n/mode GENERAL — общий словарь\n/mode PERSONAL — мои слова\n/mode MIXED — оба словаря\nИзменение действует со следующего занятия.` };
          if (!["GENERAL", "PERSONAL", "MIXED"].includes(mode)) return { text: "Выберите /mode GENERAL, /mode PERSONAL или /mode MIXED." };
          await tx.telegramUser.update({ where: { id: user }, data: { vocabularyMode: mode as VocabularyMode } });
          return { text: `Режим ${mode} сохранён для следующих занятий. Активное занятие не изменено.` };
        }
        if (name === "mywords") {
          const match = /^(?:(archived)(?:\s+|$))?([1-9][0-9]{0,2})?$/.exec(args.trim());
          if (!match) return { text: "Формат: /mywords 1 или /mywords archived 1." };
          const page = Number(match[2] ?? 1), archived = Boolean(match[1]);
          const total = await tx.personalWord.count({ where: { ownerId: user } });
          const where = { ownerId: user, archivedAt: archived ? { not: null } : null };
          const count = await tx.personalWord.count({ where });
          const pages = Math.max(1, Math.ceil(count / 5));
          if (page > pages) return { text: `Такой страницы нет. Страниц: ${pages}.` };
          const words = await tx.personalWord.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * 5, take: 5,
            include: { versions: { where: { isCurrent: true }, include: { progress: { where: { userId: user } } } } } });
          const rows = words.map(entry => { const word = entry.versions[0]; return `${word.term} — ${word.translation}${word.partOfSpeech ? ` (${word.partOfSpeech})` : ""}\n${word.progress[0]?.state ?? "NEW"}`; });
          return { text: `Мои слова: ${total} всего · ${archived ? "архив" : "активных"}: ${count}\nСтраница ${page}/${pages}\n\n${rows.join("\n\n") || "Здесь пока пусто. Добавьте слово: /add word — перевод."}\n\n${page < pages ? `/mywords ${archived ? "archived " : ""}${page + 1} — далее\n` : ""}/mywords ${archived ? "1" : "archived 1"} — ${archived ? "активные" : "архив"}` };
        }
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
        if (error instanceof VocabularyInputError) response = { text: error.message };
        else throw error;
      }
      await tx.vocabularyReceipt.create({ data: { userId: user, messageId: BigInt(messageId), fingerprint, response: response as Prisma.InputJsonValue } });
      return response;
    });
  }
}
