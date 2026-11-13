import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { spawnSync } from 'node:child_process';

// Never read .env.local here. Preserve the project's existing dedicated-branch guard.
if (existsSync('.env.test.local')) loadEnvFile('.env.test.local');
const url = process.env.TEST_DATABASE_URL;
let allowed = false;
try {
  const parsed = new URL(url);
  allowed = ['postgres:', 'postgresql:'].includes(parsed.protocol) &&
    parsed.hostname.startsWith('ep-nameless-hall') && parsed.hostname.endsWith('.neon.tech');
} catch {}
const action = process.argv[2] ?? 'test';
if (!['test', 'migrate', 'status'].includes(action)) throw new Error('Unknown test database action.');
const administration = action !== 'test';
if (!allowed || process.env.WORDFLOW_DB_TESTS !== '1') {
  console.log('Dedicated test database not enabled. Set TEST_DATABASE_URL for the allowlisted Neon test branch and WORDFLOW_DB_TESTS=1.');
  process.exit(administration ? 1 : 0);
}
// Wake only the guarded disposable branch before testing the production-sized
// connection budget. Do not retry tests or hide assertion/transaction failures.
if (action === 'test') {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000, query_timeout: 5000 });
  try { await client.connect(); await client.query('SELECT 1'); }
  catch { console.error('Test database warm-up failed. Check the dedicated branch connection.'); process.exitCode = 1; }
  finally { await client.end().catch(() => {}); }
  if (process.exitCode) process.exit(process.exitCode);
}
const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url, TEST_DATABASE_URL: url };
const args = administration
  ? ['node_modules/prisma/build/index.js', 'migrate', action === 'status' ? 'status' : 'deploy']
  : ['--conditions=react-server', '--test', '--test-concurrency=1', 'tests/database.integration.mjs', 'tests/srs.integration.mjs', 'tests/personal.integration.mjs'];
const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const clean = value => String(value ?? '').split(url).join('[database URL]').replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[database URL]');
process.stdout.write(clean(result.stdout));
process.stderr.write(clean(result.stderr));
if (result.error) console.error('Unable to run database verification.');
process.exitCode = result.status ?? 1;
