// One statement on the wire at a time.
//
// /api/files hung for fifteen seconds on a one-row table, "executing on the
// server". The route runs the folder count and listAllTags' listing under one
// Promise.all, and max: 1 did not serialize them: postgres.js PIPELINES, so
// the listing's Parse/Describe went out in the same write as the count. Behind
// Supavisor in transaction mode that second statement is never answered — the
// backend sits in ClientRead, the promise waits out its deadline, and the
// wedged connection then starves every later query on the instance.
//
// pgbouncer and a direct connection both answer a pipelined statement, so no
// ordinary test database can show the hang. What can be checked anywhere is
// the cause: whether a second statement is ever written before the first
// one's ReadyForQuery. The wire half runs only with TEST_DATABASE_URL.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

const URL_ = process.env.TEST_DATABASE_URL;

// Frontend messages that start a statement (Parse, simple Query) against
// backend ReadyForQuery. More statements started than answered means one is
// in flight behind another. Parse rather than Sync: the pipelined listing was
// Parse/Describe/Flush, with no Sync until its reply came back.
let outstanding = 0;
let maxOutstanding = 0;
let proxy = null;

async function startProxy(target) {
  const up = new URL(target);
  proxy = net.createServer((client) => {
    const server = net.connect(Number(up.port || 5432), up.hostname);
    let startup = true;
    client.on('data', (buf) => {
      if (startup) { startup = false; } else {
        for (let i = 0; i + 5 <= buf.length; i += 1 + buf.readInt32BE(i + 1)) {
          if (buf[i] === 0x50 /* P */ || buf[i] === 0x51 /* Q */) {
            outstanding += 1;
            maxOutstanding = Math.max(maxOutstanding, outstanding);
          }
        }
      }
      server.write(buf);
    });
    let pending = Buffer.alloc(0);
    server.on('data', (buf) => {
      pending = Buffer.concat([pending, buf]);
      let i = 0;
      while (i + 5 <= pending.length && i + 1 + pending.readInt32BE(i + 1) <= pending.length) {
        if (pending[i] === 0x5a /* Z */) outstanding = Math.max(0, outstanding - 1);
        i += 1 + pending.readInt32BE(i + 1);
      }
      pending = pending.subarray(i);
      client.write(buf);
    });
    client.on('close', () => server.end());
    server.on('close', () => client.end());
    client.on('error', () => {});
    server.on('error', () => {});
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const via = new URL(target);
  via.hostname = '127.0.0.1';
  via.port = String(proxy.address().port);
  return via.toString();
}

async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; }
  catch { return false; }
  finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}

const live = await reachable(URL_);
// lib/db.js builds its client at import, from DATABASE_URL. Point it through
// the counting proxy when there is a database; otherwise any URL will do —
// postgres.js does not connect until the first query.
process.env.DATABASE_URL = live ? await startProxy(URL_) : 'postgres://u:p@127.0.0.1:1/none';
delete process.env.POSTGRES_URL;
const { sql } = await import('../lib/db.js');

after(async () => {
  await sql.end({ timeout: 2 }).catch(() => {});
  proxy?.close();
});

describe('the app client does not pipeline', () => {
  test('it is built with max_pipeline: 0', () => {
    assert.equal(sql.options.max, 1);
    assert.equal(sql.options.max_pipeline, 0,
      'pipelined statements are never answered by Supavisor in transaction mode');
  });

  (live ? test : test.skip)('a Promise.all puts one statement on the wire at a time', async () => {
    // Warm first, as the route is: a connection that is still connecting
    // queues statements rather than pipelining them.
    await sql`SELECT 0`;
    maxOutstanding = 0;
    // The route's shape: a statement with no parameters (sent in one write)
    // racing a parameterized one (Parse/Describe first), plus a third.
    const [a, b, c] = await Promise.all([
      sql`SELECT 1 AS n`,
      sql.unsafe('SELECT $1::text AS s', ['x']),
      sql`SELECT ${2}::int AS n`,
    ]);
    assert.equal(a[0].n, 1);
    assert.equal(b[0].s, 'x');
    assert.equal(c[0].n, 2);
    assert.equal(maxOutstanding, 1, `${maxOutstanding} statements were in flight on one connection`);
  });
});
