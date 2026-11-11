import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { defineConfig } from "prisma/config";

if (existsSync(".env.local")) loadEnvFile(".env.local");

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "node .next/database-tools/prisma/seed.js" },
  // Optional for offline generation/validation. Migration commands require a URL.
  datasource: { url: process.env.DIRECT_URL || process.env.DATABASE_URL },
});
