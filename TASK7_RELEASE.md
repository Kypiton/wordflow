# WordFlow Task #7 — delivery and release notes

## Scope

- 303 curated shared vocabulary entries in A1–C1 approximate bands, with RU meaning, part of speech and English usage sentence.
- Additive Prisma migration, persisted per-user level preference, per-session snapshot, mixed/private mode isolation.
- Level picker accessible under Settings and via `/level`, supports `ALL`, `A1`, `A2`, `B1`, `B2`, `C1`.
- Shared examples shown inside native Telegram quiz widgets; existing SRS schedule unchanged.
- New corpus validation tests and dedicated-Neon integration coverage.

## Test results from artifact preparation

- Catalog structural tests: **2/2 passed** using `node --test tests/catalog.test.mjs`.
- 250 new editorial rows: 50 in each of the 5 bands, validated for shape, unique terms, text limits and example sentences.
- **TypeScript, Prisma generation, full test suite, live database integration and Next.js production build were not run in the artifact-preparation environment**: npm dependency installation timed out; no credentials or production access were provided. Do not consider these checks passed until you run them on your own machine.

## Before release on your Mac

```bash
npm ci
npm run db:generate
npm run db:validate
npm run typecheck
npm run lint
npm run test:telegram
npx next build --webpack
```

Check `.env.test.local` again points to your dedicated Neon test branch before executing:

```bash
WORDFLOW_DB_TESTS=1 npm run db:test:migrate
WORDFLOW_DB_TESTS=1 npm run test:db
```

The test suite validates the expanded seed and new level filter. If errors occur, do not migrate or seed production. Review `prisma/migrations/20261114000000_cefr_vocabulary/migration.sql` and `prisma/seed.ts`; back up production before schema changes. **`npm run db:seed` writes to the DB selected by `DIRECT_URL` / `DATABASE_URL`.** Do not run it until you have checked the selected host and intentionally authorized that database update. Deploy only after confirming all checks.

## Returned artifact

This is a clean project source snapshot, not a Git commit or an automatic deployment. Replace/merge source files carefully into your current repository and inspect the changes before committing. Environment secrets, `.git`, `node_modules` and `.next` are intentionally excluded from the delivery archive.
