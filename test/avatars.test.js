// Profile pictures (lib/avatars.js, lib/db.js): an upload is judged by its
// bytes, a URL never names the person, and a new picture gets a new URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffImageType, avatarPath, avatarFileProblem, AVATAR_MAX_BYTES, AVATAR_PICK_MAX_BYTES } from '../lib/avatars.js';

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
const { avatarIdFor } = await import('../lib/db.js');

const bytes = (...xs) => Uint8Array.from(xs);

test('the type comes from the first bytes, never the name', () => {
  assert.equal(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'image/png');
  assert.equal(sniffImageType(Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.equal(sniffImageType(Buffer.from('GIF89a......')), 'image/gif');
  // An SVG (script-capable) or HTML file named .png is not a picture.
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>')), null);
  assert.equal(sniffImageType(Buffer.from('<!doctype html>')), null);
  assert.equal(sniffImageType(bytes()), null);
});

test('a picture\'s URL names nobody, and changes with each new picture', () => {
  const id = avatarIdFor('Hi@Example.com');
  assert.equal(id, avatarIdFor('hi@example.com '), 'the same person, however the address is typed');
  assert.notEqual(id, avatarIdFor('someone@example.com'));
  assert.match(id, /^[0-9a-f]{24}$/);
  const url = avatarPath(id, 1700000000000);
  assert.ok(!url.includes('example'), 'no address in the URL');
  assert.notEqual(avatarPath(id, 1), avatarPath(id, 2));
});

test('the browser turns away what the server would', () => {
  assert.equal(avatarFileProblem({ size: 1000, type: 'image/png' }), null);
  assert.match(avatarFileProblem({ size: AVATAR_PICK_MAX_BYTES + 1, type: 'image/png' }), /40 MB/);
  // Over what the server takes, but the browser shrinks it before sending.
  assert.equal(avatarFileProblem({ size: AVATAR_MAX_BYTES + 1, type: 'image/png' }), null);
  // Under Vercel's 4.5 MB request-body limit, or it answers with its own bare 413.
  assert.ok(AVATAR_MAX_BYTES < 4.5 * 1024 * 1024);
  assert.match(avatarFileProblem({ size: 1000, type: 'image/svg+xml' }), /JPEG, PNG/);
  assert.match(avatarFileProblem(null), /Choose/);
});
