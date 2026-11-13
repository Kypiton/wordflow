import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../prisma/', import.meta.url);
const supplemental = readFileSync(new URL('vocabulary-expanded.ts', root), 'utf8');
const legacy = readFileSync(new URL('vocabulary.ts', root), 'utf8');
const initial = readFileSync(new URL('seed.ts', root), 'utf8');
const parse = /\b(A1|A2|B1|B2|C1): `([\s\S]*?)`/g;
const bands = [...supplemental.matchAll(parse)];
const rows = bands.flatMap(([, level, text]) => text.trim().split('\n').map(line => ({ level, fields: line.split('|') })));

test('expanded editorial catalog has 50 clean entries in each CEFR band', () => {
  assert.equal(bands.length, 5);
  for (const [level, text] of bands.map(match => [match[1], match[2]])) {
    assert.equal(text.trim().split('\n').length, 50, level);
  }
  assert.equal(rows.length, 250);
  const slugs = new Set();
  for (const { level, fields } of rows) {
    assert.equal(fields.length, 4, level);
    const [term, pos, ru, example] = fields;
    assert.match(term, /^[A-Za-z][A-Za-z '-]{0,79}$/);
    assert.ok(['noun', 'verb', 'adjective', 'adverb'].includes(pos), `${term} POS`);
    assert.match(ru, /[А-Яа-яЁё]/);
    assert.ok(ru.length <= 120 && ru.length > 0, term);
    assert.ok(example.length <= 160 && example.length > 6 && /[.!?]$/.test(example), term);
    assert.ok(!slugs.has(term.toLowerCase()), `Duplicate: ${term}`);
    slugs.add(term.toLowerCase());
  }
  assert.match(initial, /seedExpandedVocabulary/);
  assert.match(initial, /skipDuplicates: true/);
  assert.match(initial, /originals\.has\(word\.slug\)/);
  assert.match(legacy, /\["Reluctant", "adjective"/);
});

test('catalog migration preserves historical study records and uses an indexed filter', () => {
  const migration = readFileSync(new URL('migrations/20261114000000_cefr_vocabulary/migration.sql', root), 'utf8');
  assert.match(migration, /ALTER TABLE "Word" ADD COLUMN "cefrLevel"/);
  assert.match(migration, /ALTER TABLE "TelegramUser" ADD COLUMN "cefrLevel"/);
  assert.match(migration, /ALTER TABLE "StudySession" ADD COLUMN "cefrLevel"/);
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE|DELETE)\b/i);
});
