import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

export function createDatabaseClient(url: string): PrismaClient {
  if (!/^postgres(?:ql)?:\/\//.test(url)) throw new Error("Database is not configured.");
  const adapter = new PrismaPg({
    connectionString: url,
    max: 2,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 2500,
    query_timeout: 2500,
  });
  return new PrismaClient({ adapter, log: [], transactionOptions: { maxWait: 1000, timeout: 3500 } });
}

const globalDatabase = globalThis as unknown as { wordflowDatabase?: PrismaClient };

/** Cache connections, never quiz state. No connection/config access at build time. */
export function getDatabase(): PrismaClient {
  if (!globalDatabase.wordflowDatabase) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Database is not configured.");
    globalDatabase.wordflowDatabase = createDatabaseClient(url);
  }
  return globalDatabase.wordflowDatabase;
}
