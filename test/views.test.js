// The view model (lib/views.js): the built-ins' definitions, what the API
// accepts, how a view becomes the page's state and back, a built-in's
// changes kept in the browser, and the listing a view asks for.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_VIEWS, DEFAULT_DISPLAY, LAYOUTS, SORT_KEYS as VIEW_SORT_KEYS, LIMITS, KIND_KEYS,
  normalizeDisplay, normalizeFilters, validateViewInput, resolveView, visibleViews, viewsForDrive,
  stateFromView, viewSettings, sameSettings, parseLocalViews, withLocalView, legacyView,
  listingOpts, listingParams, isRecursive, sortParts, sortFor, describeSort, SORT_FIELDS, toClientView, sameName,
} from '../lib/views.js';
import { SORT_KEYS } from '../lib/file-query.js';
import { listingKey } from '../lib/listing-cache.js';
import { availableColumns } from '../lib/list-columns.js';
import { normalizeSchema } from '../lib/dam.js';
import { driveColor, driveColorHex, mixOklch, DRIVE_COLORS, LIBRARY_COLOR } from '../lib/drive-color.js';

const byId = (id) => BUILTIN_VIEWS.find((v) => v.id === id);

describe('the built-in views', () => {
  test('each has the defaults the files page promises', () => {
    const want = {
      all: { layout: 'grid', kinds: [] },
      recent: { layout: 'grid', kinds: [], flatten: true, sort: 'activity' },
      images: { layout: 'tile', kinds: ['image'], fields: ['dimensions'] },
      video: { layout: 'grid', kinds: ['video'], fields: ['duration', 'dimensions', 'size'] },
      audio: { layout: 'list', kinds: ['audio'], fields: ['duration', 'size', 'modified'] },
      documents: { layout: 'list', kinds: ['doc'], fields: ['type', 'size', 'modified'] },
      other: { layout: 'list', kinds: ['other'] },
    };
    assert.deepEqual(BUILTIN_VIEWS.map((v) => v.id), Object.keys(want), 'menu order');
    for (const [id, w] of Object.entries(want)) {
      const v = resolveView(id);
      assert.equal(v.builtin, true, id);
      assert.equal(v.display.layout, w.layout, `${id} layout`);
      assert.deepEqual(v.filters.kinds, w.kinds, `${id} kinds`);
      if (w.fields) assert.deepEqual(v.display.fields, w.fields, `${id} fields`);
      if (w.flatten) assert.equal(v.display.flatten, true, `${id} flattens`);
      if (w.sort) assert.equal(v.sort, w.sort, `${id} sort`);
    }
    // Latest activity, not Modified: that is the file's own date, and a file
    // that has only just come can have one from years ago.
    assert.equal(resolveView('recent').sort, 'activity', 'Recent is what came or changed last, first');
    assert.deepEqual(sortParts('activity'), { field: 'activity', dir: 'desc' });
  });

  test('every kind a built-in filters on is one the server knows, and every field one a view may show', () => {
    for (const v of BUILTIN_VIEWS) {
      for (const k of v.filters.kinds || []) assert.ok(KIND_KEYS.includes(k), `${v.id}: ${k}`);
      assert.deepEqual(normalizeDisplay(v.display).fields, v.display.fields, `${v.id}: a field was dropped`);
    }
  });

  test('the sort keys are the server’s', () => {
    // An unknown key falls back to Newest on the server, which reads as a
    // sort that does nothing.
    assert.deepEqual([...VIEW_SORT_KEYS].sort(), [...SORT_KEYS].sort());
    for (const f of SORT_FIELDS) assert.ok(SORT_KEYS.includes(f.asc) && SORT_KEYS.includes(f.desc), f.key);
  });

  test('the built-in fields are all columns a list can draw', () => {
    const keys = new Set(availableColumns(normalizeSchema(null)).map((c) => c.key));
    for (const k of ['size', 'type', 'modified', 'duration', 'dimensions', 'added_by']) assert.ok(keys.has(k), k);
    assert.equal(availableColumns(normalizeSchema(null)).find((c) => c.key === 'added_by').label, 'Created by');
  });

  test('an id that is neither built in nor saved resolves to nothing', () => {
    assert.equal(resolveView('nope'), null);
    assert.equal(resolveView('abc', { custom: [{ id: 'def', name: 'x' }] }), null);
  });
});

describe('display settings', () => {
  test('what is stored is read back, and anything unrecognised falls back', () => {
    assert.deepEqual(normalizeDisplay(null), { ...DEFAULT_DISPLAY, fields: [...DEFAULT_DISPLAY.fields] });
    const d = normalizeDisplay({ layout: 'mosaic', fields: ['size', 'bogus', 'meta:client', 'size', 'meta:Bad Key'], thumb: 'fit', size: 'xl', flatten: 'yes' });
    assert.equal(d.layout, 'grid');
    assert.deepEqual(d.fields, ['size', 'meta:client'], 'unknown and duplicate fields go, order stays');
    assert.equal(d.thumb, 'fit');
    assert.equal(d.size, 'm');
    assert.equal(d.flatten, false);
    assert.deepEqual(normalizeDisplay({ fields: [] }).fields, [], 'no fields is a choice: names only');
    assert.equal(normalizeDisplay({ fields: Array.from({ length: 80 }, (_, i) => `meta:f${i}`) }).fields.length, LIMITS.fields);
    for (const l of LAYOUTS) assert.equal(normalizeDisplay({ layout: l }).layout, l);
  });
});

describe('what the API accepts', () => {
  const ok = (body, opts) => {
    const r = validateViewInput(body, opts);
    assert.equal(r.error, undefined, r.error);
    return r.value;
  };
  const refused = (body, pattern, opts) => {
    const r = validateViewInput(body, opts);
    assert.ok(r.error, `accepted ${JSON.stringify(body).slice(0, 80)}`);
    if (pattern) assert.match(r.error, pattern);
  };

  test('a name alone is a view, with every default filled in', () => {
    const v = ok({ name: '  Selects   for  review ' });
    assert.equal(v.name, 'Selects for review');
    assert.equal(v.driveId, null);
    assert.equal(v.sort, 'new');
    assert.deepEqual(v.filters, { kinds: [], facets: {}, tags: [], q: '' });
    assert.equal(v.display.layout, 'grid');
  });

  test('a full view round-trips', () => {
    const v = ok({
      name: 'Hero shots',
      driveId: '36dedf0b-8370-4604-9ca3-e948a67d59b2',
      filters: { kinds: ['image', 'video'], facets: { project: ['Spring'], file_type: ['Image'] }, tags: ['Hero', 'final'], q: 'beach' },
      sort: 'size',
      display: { layout: 'tile', fields: ['dimensions', 'meta:project'], thumb: 'fit', size: 'l', flatten: true },
    });
    assert.deepEqual(v.filters.kinds, ['image', 'video']);
    assert.deepEqual(v.filters.tags, ['hero', 'final'], 'tags are stored lowercased, as files keep them');
    assert.deepEqual(v.display, { layout: 'tile', fields: ['dimensions', 'meta:project'], thumb: 'fit', size: 'l', flatten: true });
  });

  test('what is wrong is named, not quietly dropped', () => {
    refused(null, /object/);
    refused([], /object/);
    refused({}, /name/);
    refused({ name: '   ' }, /name/);
    refused({ name: 'x'.repeat(LIMITS.name + 1) }, /60 characters/);
    refused({ name: 'a\u0007b' }, /character/);
    refused({ name: 'x', owner: 'someone@else.test' }, /not part of a view/);
    refused({ name: 'x', driveId: 5 }, /driveId/);
    refused({ name: 'x', driveId: '../../etc' }, /driveId/);
    refused({ name: 'x', sort: 'random' }, /sort must be/);
    refused({ name: 'x', filters: 'video' }, /filters must be/);
    refused({ name: 'x', filters: { kinds: ['movies'] } }, /kinds/);
    refused({ name: 'x', filters: { where: '1=1' } }, /not a filter/);
    refused({ name: 'x', filters: { facets: { 'Bad key': ['a'] } } }, /field key/);
    refused({ name: 'x', filters: { facets: { tags: ['a'] } } }, /filters\.tags/);
    refused({ name: 'x', filters: { facets: { project: 'Spring' } } }, /list of strings/);
    refused({ name: 'x', filters: { q: 42 } }, /string/);
    refused({ name: 'x', display: { layout: 'mosaic' } }, /layout/);
    refused({ name: 'x', display: { fields: ['size', 'password'] } }, /password/);
    refused({ name: 'x', display: { flatten: 'yes' } }, /flatten/);
    refused({ name: 'x', display: { theme: 'dark' } }, /not a display setting/);
  });

  test('sizes are bounded', () => {
    refused({ name: 'x', filters: { q: 'q'.repeat(LIMITS.query + 1) } }, /longer/);
    refused({ name: 'x', filters: { tags: Array.from({ length: LIMITS.tags + 1 }, (_, i) => `t${i}`) } }, /at most/);
    refused({ name: 'x', filters: { tags: ['t'.repeat(LIMITS.tag + 1)] } }, /longer/);
    const many = Object.fromEntries(Array.from({ length: LIMITS.facets + 1 }, (_, i) => [`f${i}`, ['a']]));
    refused({ name: 'x', filters: { facets: many } }, /at most/);
    refused({ name: 'x', filters: { facets: { project: Array.from({ length: LIMITS.facetValues + 1 }, (_, i) => `v${i}`) } } }, /more than/);
    refused({ name: 'x', filters: { facets: { project: ['v'.repeat(LIMITS.value + 1)] } } }, /longer/);
    refused({ name: 'x', display: { fields: Array.from({ length: LIMITS.fields + 1 }, () => 'size') } }, /at most/);
  });

  test('a partial change checks and returns only what was sent', () => {
    assert.deepEqual(ok({ sort: 'name' }, { partial: true }), { sort: 'name' });
    assert.deepEqual(ok({ driveId: null }, { partial: true }), { driveId: null });
    assert.deepEqual(ok({}, { partial: true }), {});
    refused({ name: '' }, /name/, { partial: true });
  });

  test('names compare the way a person reads them', () => {
    assert.ok(sameName('Hero  Shots', ' hero shots'));
    assert.ok(!sameName('Hero shots', 'Hero shot'));
  });
});

describe('which saved views apply', () => {
  const views = [
    { id: 'a', name: 'Everywhere', driveId: null },
    { id: 'b', name: 'In Northwind', driveId: 'nw' },
    { id: 'c', name: 'In a drive I left', driveId: 'gone' },
  ];

  test('a view scoped to a drive the person cannot open is not returned', () => {
    assert.deepEqual(visibleViews(views, [{ id: 'nw' }]).map((v) => v.id), ['a', 'b']);
    assert.deepEqual(visibleViews(views, []).map((v) => v.id), ['a']);
  });

  test('a page offers everywhere-views and the ones for its own drive', () => {
    assert.deepEqual(viewsForDrive(views, 'nw').map((v) => v.id), ['a', 'b']);
    assert.deepEqual(viewsForDrive(views, '').map((v) => v.id), ['a'], 'the library is not a drive');
    assert.deepEqual(viewsForDrive(views, 'other').map((v) => v.id), ['a']);
  });

  test('a saved view goes to the browser normalized, with nothing about its owner', () => {
    const v = toClientView({ id: 'x', ownerEmail: 'me@x.test', name: 'N', driveId: null, filters: { kinds: ['nope'] }, sort: 'bogus', display: { layout: 'column' } });
    assert.equal(v.ownerEmail, undefined);
    assert.deepEqual(v.filters.kinds, []);
    assert.equal(v.sort, 'new');
    assert.equal(v.display.layout, 'column');
  });
});

describe('a view as the page’s state, and back', () => {
  test('tags travel with the facets on the page and apart from them in a view', () => {
    const saved = { filters: { kinds: ['video'], facets: { project: ['Spring'] }, tags: ['hero'], q: 'beach' }, sort: 'size', display: { layout: 'list' } };
    const state = stateFromView(saved);
    assert.deepEqual(state.facets, { project: ['Spring'], tags: ['hero'] });
    assert.equal(state.query, 'beach');
    assert.deepEqual(state.kinds, ['video']);
    const back = viewSettings(state);
    assert.deepEqual(back.filters, { kinds: ['video'], facets: { project: ['Spring'] }, tags: ['hero'], q: 'beach' });
    assert.equal(back.sort, 'size');
    assert.equal(back.display.layout, 'list');
  });

  test('settings compare by what they show, not how they were spelled', () => {
    const a = { filters: { facets: { b: ['1'], a: ['2'] }, tags: [] }, sort: 'new', display: { layout: 'grid' } };
    const b = { filters: { facets: { a: ['2'], b: ['1'], empty: [] }, q: '  ' }, sort: 'new', display: { layout: 'grid', thumb: 'fill' } };
    assert.ok(sameSettings(a, b));
    assert.ok(!sameSettings(a, { ...b, sort: 'name' }), 'a new sort is a change');
    assert.ok(!sameSettings(a, { ...b, display: { layout: 'list' } }), 'a new layout is a change');
    assert.ok(!sameSettings(a, { ...b, filters: { ...b.filters, q: 'x' } }), 'a search is a change');
  });

  test('a saved view resolves as saved', () => {
    const custom = [{ id: 'v1', name: 'Mine', driveId: 'd', filters: { kinds: ['audio'] }, sort: 'name', display: { layout: 'column', size: 'l' } }];
    const v = resolveView('v1', { custom });
    assert.equal(v.builtin, false);
    assert.equal(v.driveId, 'd');
    assert.equal(v.sort, 'name');
    assert.equal(v.display.layout, 'column');
    assert.equal(v.display.size, 'l');
  });
});

describe('a built-in’s changes, kept in the browser', () => {
  test('a change is kept, and changing it back forgets it', () => {
    let local = withLocalView({}, 'video', { sort: 'size', display: { ...resolveView('video').display, layout: 'list' } });
    assert.equal(resolveView('video', { local }).display.layout, 'list');
    assert.equal(resolveView('video', { local }).sort, 'size');
    assert.equal(resolveView('audio', { local }).display.layout, 'list', 'other views keep their own');
    local = withLocalView(local, 'video', { sort: 'new', display: resolveView('video').display });
    assert.deepEqual(local, {}, 'back to the defaults is no change at all');
    assert.deepEqual(withLocalView({}, 'not-a-view', { sort: 'size' }), {});
  });

  test('what the browser holds is trusted only as far as it parses', () => {
    assert.deepEqual(parseLocalViews('not json'), {});
    assert.deepEqual(parseLocalViews(null), {});
    const parsed = parseLocalViews(JSON.stringify({
      video: { sort: 'size', display: { layout: 'tile', fields: ['bogus', 'size'] } },
      custom123: { sort: 'size' },
      images: { sort: 'nonsense' },
    }));
    assert.deepEqual(Object.keys(parsed), ['video'], 'only built-ins, only settings that parse');
    assert.deepEqual(parsed.video.display.fields, ['size']);
  });

  test('All files starts from the grid/list choice and columns kept before views', () => {
    const legacy = legacyView({ layout: 'list', fields: ['size', 'tags', 'nope'] });
    const v = resolveView('all', { legacy });
    assert.equal(v.display.layout, 'list');
    assert.deepEqual(v.display.fields, ['size', 'tags']);
    assert.equal(resolveView('video', { legacy }).display.layout, 'grid', 'only All files');
    const own = withLocalView({}, 'all', { sort: 'new', display: { ...resolveView('all').display, layout: 'tile' } });
    assert.equal(resolveView('all', { legacy, local: own }).display.layout, 'tile', 'its own changes win');
    assert.equal(legacyView({ layout: 'mosaic' }), null);
  });
});

describe('the listing a view asks for', () => {
  test('a folder lists what is in it; flattened or searching looks beneath it', () => {
    assert.deepEqual(listingOpts({ folder: 'Footage', sort: 'new' }), { folder: 'Footage', sort: 'new' });
    assert.deepEqual(listingOpts({ folder: 'Footage', flat: true }), { folderPrefix: 'Footage', sort: 'new' });
    assert.deepEqual(listingOpts({ folder: 'Footage', query: ' take ' }), { folderPrefix: 'Footage', q: 'take', sort: 'new' });
    assert.deepEqual(listingOpts({ folder: '', flat: true, kinds: ['video'], sort: 'modified' }), { folderPrefix: '', kind: ['video'], sort: 'modified' });
    assert.deepEqual(listingOpts({ folder: 'A', kinds: ['image'] }), { folder: 'A', kind: ['image'], sort: 'new' }, 'a kind alone stays at this level');
    assert.equal(listingOpts({ sort: 'bogus' }).sort, 'new');
  });

  test('the browser asks for the same listing as query parameters', () => {
    const p = listingParams({ folder: 'Footage/Day 1', flat: true, kinds: ['video', 'audio'], sort: 'size' }, { filespaceId: 'd1', cursor: 'abc' });
    assert.equal(p.get('folderPrefix'), 'Footage/Day 1');
    assert.equal(p.get('folder'), null);
    assert.equal(p.get('kind'), 'video,audio');
    assert.equal(p.get('sort'), 'size');
    assert.equal(p.get('filespace'), 'd1');
    assert.equal(p.get('cursor'), 'abc');
    assert.equal(p.get('folders'), '0');
    const root = listingParams({ folder: '', flat: true });
    assert.equal(root.get('folderPrefix'), null, 'everything: no prefix at all');
    assert.equal(root.get('folder'), null);
    assert.equal(listingParams({ folder: '' }).get('folder'), '', 'the top level of the library');
  });

  test('flattening is part of what a listing is', () => {
    const base = { filespaceId: 'd', folder: 'A', sort: 'new' };
    assert.notEqual(listingKey({ ...base, flat: true }), listingKey(base));
    assert.equal(listingKey({ ...base, query: 'x', flat: true }), listingKey({ ...base, query: 'x' }), 'a search looks beneath either way');
    assert.ok(isRecursive({ query: 'x' }) && isRecursive({ flat: true }) && !isRecursive({}));
  });
});

describe('the Sort menu', () => {
  test('a field and a direction make a sort key, and a key reads back as both', () => {
    for (const f of SORT_FIELDS) {
      assert.equal(sortFor(f.key, 'asc'), f.asc);
      assert.equal(sortFor(f.key, 'desc'), f.desc);
      assert.deepEqual(sortParts(f.asc), { field: f.key, dir: 'asc' });
      assert.deepEqual(sortParts(f.desc), { field: f.key, dir: 'desc' });
    }
    assert.equal(sortFor('size'), 'size', 'a field opens largest first');
    assert.equal(sortFor('name'), 'name', 'and names A to Z');
    assert.equal(sortFor('nope', 'asc'), 'new');
    assert.deepEqual(sortParts('bogus'), { field: 'uploaded', dir: 'desc' });
    assert.equal(describeSort('modified'), 'Date modified, newest first');
    assert.equal(describeSort('small'), 'Size, smallest first');
    // Four dates, as a file manager has them: the file's own two, when it
    // came (the default), and when anything about it last changed here.
    assert.equal(describeSort('created_old'), 'Date created, oldest first');
    assert.equal(describeSort('new'), 'Date added, newest first');
    assert.equal(describeSort('activity'), 'Last activity, newest first');
    assert.deepEqual(SORT_FIELDS.map((f) => f.label), ['Date modified', 'Date created', 'Date added', 'Last activity', 'Name', 'Size', 'Type']);
    for (const sort of VIEW_SORT_KEYS) assert.ok(SORT_FIELDS.some((f) => f.asc === sort || f.desc === sort), `${sort} is in the menu`);
  });
});

describe('a drive’s colour', () => {
  test('stable, from the palette, and never the library’s', () => {
    assert.equal(driveColor(''), LIBRARY_COLOR);
    assert.equal(driveColor(null), LIBRARY_COLOR);
    const id = '36dedf0b-8370-4604-9ca3-e948a67d59b2';
    assert.equal(driveColor(id), driveColor(id));
    assert.ok(DRIVE_COLORS.includes(driveColor(id)));
    assert.ok(!DRIVE_COLORS.includes(LIBRARY_COLOR));
    for (const c of DRIVE_COLORS) {
      assert.match(c, /^(var\(--[a-z-]+\)|color-mix\(in oklch, var\(--[a-z-]+\)( \d+%)?, var\(--[a-z-]+\)\))$/, 'only brand properties');
      assert.ok(!c.includes('accent-deep') && c !== LIBRARY_COLOR, `${c} is the library’s colour by another name`);
      assert.ok(!/danger/.test(c));
    }
    // A handful of ids spread over more than one colour.
    const seen = new Set(Array.from({ length: 40 }, (_, i) => driveColor(`drive-${i}`)));
    assert.ok(seen.size >= 5, `only ${seen.size} colours for 40 drives`);
  });

  // The Onyx palette, spelled out: what the Mac is told, whatever the brand
  // defaults become.
  const palette = { accent: '#3D5AFE', accentAlt: '#E040FB', accentCool: '#22D3EE', warning: '#C2410C', danger: '#B42318' };

  test('as #RRGGBB for the Mac: the colour the page draws', () => {
    // Pinned against Chrome's own color-mix(in oklch, …), drawn to an sRGB
    // canvas. The last one is past sRGB: Chrome clips it (#AD8100), CSS
    // Color 4's mapping keeps its hue a little better.
    assert.equal(mixOklch('#22D3EE', '#C2410C', 0.5), '#81A628', 'cyan and amber meet at a green');
    assert.equal(mixOklch('#3D5AFE', '#E040FB', 0.5), '#974EFF');
    assert.equal(mixOklch('#22D3EE', '#C2410C', 0.7), '#39C185');
    assert.equal(mixOklch('#22D3EE', '#C2410C', 0.3), '#AA8200');
    assert.equal(mixOklch('#22D3EE', '#22D3EE', 0.5), '#22D3EE');
    assert.equal(mixOklch('#808080', '#22D3EE', 1), '#808080', 'a grey stays grey');

    assert.equal(driveColorHex('', palette), '#3D5AFE', 'the library is the accent');
    const byEntry = new Map();
    for (let i = 0; i < 400; i++) byEntry.set(driveColor(`drive-${i}`), driveColorHex(`drive-${i}`, palette));
    assert.equal(byEntry.size, DRIVE_COLORS.length, 'every entry reached');
    assert.equal(byEntry.get('var(--accent-alt)'), '#E040FB');
    assert.equal(byEntry.get('var(--warning)'), '#C2410C');
    assert.equal(byEntry.get('color-mix(in oklch, var(--accent-cool), var(--warning))'), '#81A628');
    assert.equal(byEntry.get('color-mix(in oklch, var(--accent-cool) 30%, var(--warning))'), '#AA8200');
    assert.equal(new Set(byEntry.values()).size, DRIVE_COLORS.length, 'no two entries the same colour');
  });

  test('as #RRGGBB for any palette, or null for one missing a colour', () => {
    const own = { accent: '#00aa77', accentAlt: '#123456', accentCool: '#ABCDEF', warning: '#FEDCBA' };
    for (let i = 0; i < 100; i++) assert.match(driveColorHex(`d-${i}`, own), /^#[0-9A-F]{6}$/);
    assert.equal(driveColorHex('', own), '#00AA77');
    const partial = { ...palette, warning: undefined };
    assert.ok(Array.from({ length: 100 }, (_, i) => driveColorHex(`d-${i}`, partial)).includes(null));
    assert.equal(driveColorHex('', null), null);
  });
});
