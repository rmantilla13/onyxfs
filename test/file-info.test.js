// "Get info": what it says about a file, several files, and a folder. The
// dialog formats the values; these pin which facts appear and in what form.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileFacts, selectionFacts, kindLabel } from '../lib/file-info.js';
import { folderStats } from '../lib/folder-ops.js';
import { normalizeSchema } from '../lib/dam.js';
import { initialsFor } from '../lib/account.js';

const schema = normalizeSchema(null);

const video = {
  id: 'v', name: 'launch.mp4', mime: 'video/mp4', kind: 'other', size: 7052573,
  folder: 'Campaigns/2026', tags: ['hero'], createdAt: 1, updatedAt: 2, createdBy: 'a@b.co',
  storageKey: 'files/Campaigns/2026/launch.mp4',
  metadata: { width: 1080, height: 1920, duration: 8, project: ['Spring'], status: 'Active', author: null, web_expiration: '2026-09-20' },
};

test('a kind reads the way a file manager says it', () => {
  assert.equal(kindLabel(video), 'MP4 video');
  assert.equal(kindLabel({ name: 'brief.pdf', mime: 'application/pdf' }), 'PDF document');
  assert.equal(kindLabel({ name: 'noext', mime: '' }), 'File');
});

test('file facts: what it is, where, when, then what people said about it', () => {
  const rows = fileFacts(video, schema);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.deepEqual(rows.slice(0, 5).map((r) => r.key), ['kind', 'size', 'dimensions', 'duration', 'where']);
  assert.equal(byKey.dimensions.value, '1080 × 1920 (9:16)');
  assert.deepEqual(byKey.size, { key: 'size', label: 'Size', type: 'bytes', value: 7052573 });
  assert.equal(byKey.where.type, 'folder');
  assert.deepEqual(byKey['meta:project'].value, ['Spring']);
  assert.equal(byKey['meta:web_expiration'].type, 'day');
  // A cleared field (null) and fields never set say nothing at all.
  assert.ok(!('meta:author' in byKey));
  assert.ok(!('meta:source' in byKey));
  assert.equal(byKey.stored.value, 'files/Campaigns/2026/launch.mp4');
});

test('a file at the root is still somewhere', () => {
  const where = fileFacts({ name: 'x.txt', folder: '' }, schema).find((r) => r.key === 'where');
  assert.deepEqual(where, { key: 'where', label: 'Where', type: 'folder', value: '' });
});

test('several files: how many, how much, of what, from where', () => {
  const s = selectionFacts([video, { ...video, id: 'w', size: 100 }, { name: 'a.jpg', mime: 'image/jpeg', size: 5, folder: '' }]);
  assert.equal(s.count, 3);
  assert.equal(s.bytes, 7052573 + 100 + 5);
  assert.deepEqual(s.kinds, [{ label: 'MP4 video', count: 2 }, { label: 'JPG image', count: 1 }]);
  assert.deepEqual(s.folders.sort(), ['', 'Campaigns/2026']);
});

test('folder stats come from the tree the page already has', () => {
  const folders = [
    { folder: 'Brand', count: 2 },
    { folder: 'Campaigns', count: 1 },
    { folder: 'Campaigns/2026', count: 0 },
    { folder: 'Campaigns/2026/Spring', count: 4 },
    { folder: 'Campaigns/2027', count: 3 },
    // Not inside "Campaigns", despite the shared prefix.
    { folder: 'Campaigns-old', count: 9 },
  ];
  assert.deepEqual(folderStats(folders, 'Campaigns'), { files: 1, total: 8, subfolders: 2, nested: 3 });
  assert.deepEqual(folderStats(folders, 'Campaigns/2026/Spring'), { files: 4, total: 4, subfolders: 0, nested: 0 });
  assert.deepEqual(folderStats(folders, ''), { files: null, total: 19, subfolders: 3, nested: 6 });
  assert.deepEqual(folderStats(folders, 'Nowhere'), { files: 0, total: 0, subfolders: 0, nested: 0 });
});

test('account initials', () => {
  assert.equal(initialsFor('ricky.mantilla@example.com'), 'RM');
  assert.equal(initialsFor('hi@example.com'), 'H');
  assert.equal(initialsFor('a_b-c@example.com'), 'AB');
  assert.equal(initialsFor(''), '?');
});
