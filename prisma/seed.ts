
import { randomUUID } from "node:crypto";
import { vocabularySeed } from "./vocabulary";
import { parseCatalog, type CatalogRow } from "./vocabulary-expanded";
import { legacyMetadata } from "./vocabulary-legacy";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

type VocabularyEntry = {
  slug: string;
  term: string;
  partOfSpeech: string;
  correct: string;
  incorrect: [string, string, string];
};

const vocabulary: VocabularyEntry[] = [
  {
    slug: "reluctant",
    term: "Reluctant",
    partOfSpeech: "adjective",
    correct: "Неохотный",
    incorrect: ["Уверенный", "Любопытный", "Щедрый"],
  },
  {
    slug: "resilient",
    term: "Resilient",
    partOfSpeech: "adjective",
    correct: "Стойкий",
    incorrect: ["Рассеянный", "Упрямый", "Случайный"],
  },
  {
    slug: "abundant",
    term: "Abundant",
    partOfSpeech: "adjective",
    correct: "Обильный",
    incorrect: ["Редкий", "Скрытый", "Опасный"],
  },
  {
    slug: "achieve",
    term: "Achieve",
    partOfSpeech: "verb",
    correct: "Достигать",
    incorrect: ["Избегать", "Отрицать", "Сомневаться"],
  },
  {
    slug: "reliable",
    term: "Reliable",
    partOfSpeech: "adjective",
    correct: "Надёжный",
    incorrect: ["Временный", "Сложный", "Дешёвый"],
  },
  {
    slug: "consider",
    term: "Consider",
    partOfSpeech: "verb",
    correct: "Рассматривать",
    incorrect: ["Запрещать", "Забывать", "Отказываться"],
  },
  {
    slug: "essential",
    term: "Essential",
    partOfSpeech: "adjective",
    correct: "Необходимый",
    incorrect: ["Неожиданный", "Доступный", "Обычный"],
  },
  {
    slug: "improve",
    term: "Improve",
    partOfSpeech: "verb",
    correct: "Улучшать",
    incorrect: ["Ухудшать", "Удалять", "Заменять"],
  },
  {
    slug: "maintain",
    term: "Maintain",
    partOfSpeech: "verb",
    correct: "Поддерживать",
    incorrect: ["Обнаруживать", "Предполагать", "Разрушать"],
  },
  {
    slug: "significant",
    term: "Significant",
    partOfSpeech: "adjective",
    correct: "Значительный",
    incorrect: ["Незаметный", "Случайный", "Временный"],
  },
];

export async function seedInitialWord(
  db: PrismaClient
): Promise<void> {
  for (const word of vocabulary) {
    // Keep the original Reluctant options unchanged.
    const options =
      word.slug === "reluctant"
        ? [
          "Уверенный",
          "Любопытный",
          "Неохотный",
          "Щедрый",
        ]
        : [word.correct, ...word.incorrect];

    await db.word.upsert({
      where: {
        slug_version: {
          slug: word.slug,
          version: 1,
        },
      },
      update: {},
      create: {
        slug: word.slug,
        version: 1,
        term: word.term,
        partOfSpeech: word.partOfSpeech,
        options: {
          create: options.map((text, position) => ({
            position,
            text,
            isCorrect: text === word.correct,
          })),
        },
      },
    });
  }
}

/**
 * Additive, re-runnable expanded seed. Never updates old translations/options,
 * deletes words, or resets progress. Separate from seedInitialWord so that the
 * historical ten-word integration fixtures keep their existing semantics.
 */
export function expandedEntries(): CatalogRow[] {
  const supplemental = parseCatalog();
  const records = new Map<string, CatalogRow>();
  for (const seed of vocabularySeed) {
    const [level, example] = legacyMetadata[seed.slug] ?? (["B2", `We learned the word ${seed.term.toLowerCase()} today.`] as const);
    records.set(seed.slug, { slug: seed.slug, term: seed.term, partOfSpeech: seed.partOfSpeech,
      translation: seed.correct, example, level });
  }
  for (const word of supplemental) {
    if (records.has(word.slug)) throw new Error(`Duplicate editorial word: ${word.slug}`);
    records.set(word.slug, word);
  }
  // The first ten existing seed words include entries outside the 50-word list.
  for (const original of vocabulary) {
    if (!records.has(original.slug)) {
      const [level, example] = legacyMetadata[original.slug];
      records.set(original.slug, { slug: original.slug, term: original.term,
        partOfSpeech: original.partOfSpeech, translation: original.correct, example, level });
    }
  }
  const words = [...records.values()];
  if (words.length < 300 || words.length > 500) throw new Error(`Expected 300–500 curated words, got ${words.length}.`);
  for (const word of words) {
    if (word.term.length > 80 || word.slug.length > 80 || word.translation.length > 120 ||
        word.example.length > 160 || word.partOfSpeech.length > 40 ||
        !/[А-Яа-яЁё]/.test(word.translation) || !word.example) {
      throw new Error(`Invalid curated content: ${word.slug}`);
    }
  }
  return words;
}

/** Deterministic 3 distinct same-POS distractors, fixed at seed time. */
export function curatedOptions(word: CatalogRow, entries: CatalogRow[]): string[] {
  const pool = entries.filter(entry => entry.slug !== word.slug && entry.partOfSpeech === word.partOfSpeech &&
    entry.translation.toLowerCase() !== word.translation.toLowerCase() &&
    // Avoid near-identical glosses that can make two answers seem correct.
    !entry.translation.toLowerCase().includes(word.translation.toLowerCase()) &&
    !word.translation.toLowerCase().includes(entry.translation.toLowerCase()));
  pool.sort((a, b) => a.slug.localeCompare(b.slug));
  if (pool.length < 3) throw new Error(`Not enough options for ${word.slug}`);
  const start = [...word.slug].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7) % pool.length;
  const wrong: string[] = [];
  for (let offset = 0; offset < pool.length && wrong.length < 3; offset++) {
    const candidate = pool[(start + offset) % pool.length]?.translation;
    if (candidate && !wrong.includes(candidate)) wrong.push(candidate);
  }
  if (wrong.length !== 3) throw new Error(`Insufficient distinct options for ${word.slug}`);
  return [word.translation, ...wrong];
}

export async function seedExpandedVocabulary(db: PrismaClient): Promise<number> {
  const words = expandedEntries();
  const originals = new Set(vocabulary.map(row => row.slug));
  await seedInitialWord(db);
  for (let i = 0; i < words.length; i += 50) {
    const batch = words.slice(i, i + 50).filter(word => !originals.has(word.slug));
    await db.word.createMany({ data: batch.map(word => ({ id: randomUUID(), slug: word.slug, version: 1,
      term: word.term, partOfSpeech: word.partOfSpeech, translation: word.translation,
      example: word.example, cefrLevel: word.level })), skipDuplicates: true });
  }
  // Existing ten-word IDs and their original quiz options remain byte-for-byte unchanged.
  for (const word of words.filter(row => originals.has(row.slug))) {
    await db.word.updateMany({ where: { slug: word.slug, version: 1, personalWordId: null },
      data: { cefrLevel: word.level, example: word.example } });
  }
  const stored = await db.word.findMany({ where: { slug: { in: words.map(word => word.slug) }, version: 1, personalWordId: null },
    select: { id: true, slug: true, options: { select: { id: true } } } });
  const bySlug = new Map(words.map(word => [word.slug, word]));
  const optionData: { wordId: string; position: number; text: string; isCorrect: boolean }[] = [];
  for (const row of stored) {
    if (row.options.length === 4) continue;
    if (row.options.length !== 0) throw new Error(`Partial options for ${row.slug}; fix manually.`);
    const word = bySlug.get(row.slug)!;
    const legacy = vocabularySeed.find(entry => entry.slug === row.slug);
    const options = legacy?.options ?? curatedOptions(word, words);
    options.forEach((text, position) => optionData.push({ wordId: row.id, position, text,
      isCorrect: text === (legacy?.correct ?? word.translation) }));
  }
  for (let i = 0; i < optionData.length; i += 200) {
    await db.wordOption.createMany({ data: optionData.slice(i, i + 200), skipDuplicates: true });
  }
  return words.length;
}

async function main(): Promise<void> {
  const url =
    process.env.DIRECT_URL ||
    process.env.DATABASE_URL;

  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) {
    throw new Error("Missing database configuration.");
  }

  const db = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 5000,
    }),
    log: [],
  });

  try {
    console.log(`Expanded vocabulary ready: ${await seedExpandedVocabulary(db)} curated words.`);
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then(() => console.log("Vocabulary seeded."))
    .catch(() => {
      console.error("Vocabulary seed failed.");
      process.exitCode = 1;
    });
}
