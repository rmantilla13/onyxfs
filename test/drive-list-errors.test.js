// A failed read of the drives must never look like "no drives". A device
// took the delta feed's 404 on a passing database error for a drive taken
// away, and a Mac set about deleting that drive's offline copies. Reads that
// decide access or feed a device throw, and the routes turn that into a 503.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const fnBody = (text, name) => {
  const start = text.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return text.slice(start, text.indexOf('\n}\n', start));
};

test('listFilespaces and listFilespacesForUser do not swallow a failed read', async () => {
  const db = await src('lib/db.js');
  for (const name of ['listFilespaces', 'listFilespacesForUser']) {
    const body = fnBody(db, name);
    assert.ok(!/catch\s*\(/.test(body), `${name} must let a failed read throw`);
    assert.ok(!/return \[\];\s*\n\s*\}\s*$/.test(body.trim()), `${name} must not answer [] for an error`);
  }
});

test('the delta feed answers 503, not 404, when the drives cannot be read', async () => {
  const route = await src('app/api/files/delta/route.js');
  const read = route.indexOf('allDrives = await listFilespaces()');
  const guard = route.lastIndexOf('try {', read);
  assert.ok(read > 0 && guard > 0 && read - guard < 200, 'the drive reads sit inside a try');
  const handler = route.slice(read, route.indexOf("'No access to this drive'"));
  assert.match(handler, /status: 503/, 'a failed read is a 503');
});

test("the desktop's drive list answers 503, never an empty list, on a failed read", async () => {
  const route = await src('app/api/space/filespaces/route.js');
  assert.match(route, /catch \(e\)[\s\S]*status: 503/);
});
