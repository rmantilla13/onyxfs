// db/init.sql is generated (scripts/gen-init-sql.mjs), not written. These pin
// the two things a reader of the file relies on: the count in its header is
// the count of statements in it, and the generator's clean-up of what it
// captures — indentation, CONCURRENTLY, repeats — does what the file claims.
//
// Whether the file matches the guards needs a database: `npm run schema:sql
// -- --check` answers that, and it is what to run after touching DDL.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { dedent, schemaStatements, renderInitSql } = await import('../scripts/gen-init-sql.mjs');

const initSql = readFileSync(join(root, 'db', 'init.sql'), 'utf8');

/** Statements in the file: what is left once comments are gone, split on the terminating `;`. */
function statementsIn(text) {
  const code = text.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  return code.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

describe('db/init.sql', () => {
  test('the header counts the statements that follow it', () => {
    const declared = Number((/^-- Statements: (\d+)$/m.exec(initSql) || [])[1]);
    assert.ok(declared > 0, 'no "-- Statements: N" header');
    assert.equal(statementsIn(initSql).length, declared);
  });

  test('it says it is generated, and how', () => {
    assert.match(initSql, /npm run schema:sql/);
  });

  test('every statement is DDL', () => {
    for (const s of statementsIn(initSql)) assert.match(s, /^(CREATE|ALTER)\s/, s.slice(0, 60));
  });

  test('the tables this release reads are in it', () => {
    for (const t of ['people', 'audit_events', 'maintenance_runs', 'files', 'file_shares', 'filespaces']) {
      assert.match(initSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} `), t);
    }
  });
});

describe('the generator', () => {
  test('dedent removes the template indentation and keeps the shape', () => {
    const raw = '\n    CREATE TABLE IF NOT EXISTS t (\n      id TEXT PRIMARY KEY\n    )\n  ';
    assert.equal(dedent(raw), 'CREATE TABLE IF NOT EXISTS t (\n  id TEXT PRIMARY KEY\n)');
  });

  test('only DDL is kept, once, and CONCURRENTLY is dropped', () => {
    const out = schemaStatements([
      'CREATE TABLE IF NOT EXISTS a (id TEXT)',
      'SELECT key, value FROM settings',
      "UPDATE files SET seq = nextval('files_change_seq') WHERE seq IS NULL",
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON a (id)',
      'DROP INDEX CONCURRENTLY IF EXISTS i',
      'CREATE TABLE IF NOT EXISTS a (id TEXT)',
      '  ALTER TABLE a ADD COLUMN IF NOT EXISTS b TEXT  ',
    ]);
    assert.deepEqual(out, [
      'CREATE TABLE IF NOT EXISTS a (id TEXT)',
      'CREATE INDEX IF NOT EXISTS i ON a (id)',
      'ALTER TABLE a ADD COLUMN IF NOT EXISTS b TEXT',
    ]);
  });

  test('the rendered file counts what it holds', () => {
    const text = renderInitSql(['CREATE TABLE IF NOT EXISTS a (id TEXT)', 'ALTER TABLE a ADD COLUMN IF NOT EXISTS b TEXT']);
    assert.match(text, /^-- Statements: 2$/m);
    assert.equal(statementsIn(text).length, 2);
  });
});
