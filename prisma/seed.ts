
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
    await seedInitialWord(db);
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
