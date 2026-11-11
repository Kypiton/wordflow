import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

/** Seed creates an immutable version once; reruns never change active quizzes. */
export async function seedInitialWord(db: PrismaClient): Promise<void> {
  await db.word.upsert({
    where: { slug_version: { slug: "reluctant", version: 1 } },
    update: {},
    create: {
      slug: "reluctant", version: 1, term: "Reluctant", partOfSpeech: "adjective",
      options: { create: [
        { position: 0, text: "Уверенный", isCorrect: false },
        { position: 1, text: "Любопытный", isCorrect: false },
        { position: 2, text: "Неохотный", isCorrect: true },
        { position: 3, text: "Щедрый", isCorrect: false },
      ] },
    },
  });
}

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error("Missing database configuration.");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 }), log: [] });
  try { await seedInitialWord(db); } finally { await db.$disconnect(); }
}

if (require.main === module) {
  main().then(() => console.log("Initial word seeded."), () => {
    console.error("Seed failed. Check database configuration and apply migrations first.");
    process.exitCode = 1;
  });
}
