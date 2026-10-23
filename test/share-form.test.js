// The share dialog's form as data (lib/share-form.js): what it starts as,
// what a template or a link fills it with, and the requests it sends — each
// of which the routes parse with lib/share-kinds.js, so every request built
// here is run through those parsers too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blankForm, applyTemplate, formFromShare, createRequest, changeRequest, templateSettings,
  expiryChoices, startingExpiry, toLocalInput, fromLocalInput, defaultDate, lookSummary,
} from '../lib/share-form.js';
import {
  SHARE_TEMPLATES, SHARE_VIEWS, parseShareRequest, parseShareChanges, parseTemplateSettings,
} from '../lib/share-kinds.js';

const DAY = 86400000;

test('a new link starts public, never expiring, downloadable, in the target’s default view', () => {
  const f = blankForm('file');
  assert.equal(f.kind, 'public');
  assert.equal(f.expires, 'never');
  assert.equal(f.downloads, true);
  assert.equal(f.view, 'standard');
  assert.equal(blankForm('folder').view, 'grid');
  assert.deepEqual(parseShareRequest(createRequest(f)), {
    mode: 'public', password: null, expiresInDays: null, expiresAt: null, review: null, downloads: true, look: null,
  }, 'the untouched form is the plain link, so it is reused as before');
});

test('what a role allows decides where the form starts', () => {
  const contributor = { kinds: ['private'], review: [], expires: ['1', '7', '30'], maxExpiryDays: 30 };
  assert.deepEqual(expiryChoices(contributor).presets.map((x) => x.id), ['1', '7', '30']);
  assert.equal(expiryChoices(contributor).date, true);
  assert.equal(expiryChoices(contributor).maxDays, 30);
  assert.equal(startingExpiry(contributor), '30');
  assert.equal(blankForm('file', contributor).kind, 'private');
  assert.equal(expiryChoices({ kinds: [], expires: [] }).date, false);
});

test('every built-in template fills a form whose request parses, for a file and for a folder', () => {
  for (const t of SHARE_TEMPLATES) {
    for (const target of ['file', 'folder']) {
      const f = applyTemplate(blankForm(target), t.settings, { target, reviewable: true });
      if (f.kind === 'password') f.password = 'hunter22';
      const parsed = parseShareRequest(createRequest(f, { target, reviewable: target === 'file' }), { target });
      assert.ok(!parsed.error, `${t.id} ${target}: ${parsed.error}`);
      assert.equal(f.password, t.settings.kind === 'password' ? 'hunter22' : '', 'a template never fills the password');
    }
  }
  const portfolio = SHARE_TEMPLATES.find((t) => t.id === 'portfolio');
  const folder = applyTemplate(blankForm('folder'), portfolio.settings, { target: 'folder' });
  assert.equal(folder.view, 'gallery');
  assert.equal(folder.downloads, false);
  assert.equal(applyTemplate(blankForm('file'), portfolio.settings, { target: 'file' }).view, 'presentation');
});

test('a template never chooses what the link cannot be', () => {
  const review = SHARE_TEMPLATES.find((t) => t.id === 'review');
  // Not reviewable (a document, or a role without review links): view only.
  assert.equal(applyTemplate(blankForm('file'), review.settings, { target: 'file', reviewable: false }).review, 'view');
  assert.equal(applyTemplate(blankForm('folder'), review.settings, { target: 'folder', reviewable: true }).review, 'view');
  // A folder takes no private link; a role that may not make one keeps what it had.
  assert.equal(applyTemplate(blankForm('folder'), { kind: 'private' }, { target: 'folder' }).kind, 'public');
  const contributor = { kinds: ['private'], expires: ['1', '7', '30'], maxExpiryDays: 30 };
  const f = applyTemplate(blankForm('file', contributor), { kind: 'public', expires: '90' }, { target: 'file', can: contributor });
  assert.equal(f.kind, 'private');
  assert.equal(f.expires, '30');
});

test('a date travels as a time; the input shows it in this browser’s zone', () => {
  const at = new Date(2031, 4, 6, 15, 30).getTime();
  assert.equal(toLocalInput(at), '2031-05-06T15:30');
  assert.equal(fromLocalInput('2031-05-06T15:30'), at);
  assert.equal(fromLocalInput(''), null);
  const now = new Date(2030, 0, 1, 9, 17).getTime();
  assert.equal(defaultDate(null, now), toLocalInput(new Date(2030, 0, 15, 9, 0).getTime()));
  assert.ok(fromLocalInput(defaultDate(3, now)) <= now + 3 * DAY, 'never past the longest allowed');
  const f = { ...blankForm('file'), expires: 'date', expiresAt: toLocalInput(Date.now() + 3 * DAY) };
  const parsed = parseShareRequest(createRequest(f));
  assert.ok(!parsed.error, parsed.error);
  assert.ok(Math.abs(parsed.expiresInDays - 3) < 0.01);
});

test('changing a link sends its look and downloads, its expiry only when not kept, its level only when changed', () => {
  const share = { token: 't', kind: 'public', review: 'comment', downloads: false, expiresAt: Date.now() + DAY, look: { view: 'presentation', theme: 'dark' }, levels: ['view', 'comment', 'approve'] };
  const f = formFromShare(share, 'file');
  assert.equal(f.expires, 'keep');
  assert.equal(f.view, 'presentation');
  assert.equal(f.downloads, false);
  const body = changeRequest(f, share, { target: 'file', reviewable: true });
  assert.deepEqual(Object.keys(body).sort(), ['downloads', 'look']);
  assert.deepEqual(parseShareChanges(body, { target: 'file' }).changes.look, { view: 'presentation', theme: 'dark' });
  const more = changeRequest({ ...f, expires: '7', review: 'approve', downloads: true }, share, { target: 'file', reviewable: true });
  assert.equal(more.expires, '7');
  assert.equal(more.review, 'approve');
  assert.equal(more.downloads, true);
  // A private link has no downloads to send.
  assert.equal('downloads' in changeRequest(formFromShare({ kind: 'private' }), { kind: 'private' }), false);
});

test('a template kept from the form has no password and no date, and parses', () => {
  const f = { ...blankForm('folder'), kind: 'password', password: 'secret12', expires: 'date', expiresAt: '2031-01-01T00:00', view: 'list', theme: 'light', title: 'Press' };
  const s = templateSettings(f, 'folder');
  assert.equal('password' in s, false);
  assert.equal('expires' in s, false);
  assert.deepEqual(s.views, { folder: 'list' });
  assert.ok(!parseTemplateSettings(s).error);
  assert.deepEqual(parseTemplateSettings(s).settings.look, { theme: 'light', title: 'Press' });
});

test('a look is summed up in a few words', () => {
  assert.equal(lookSummary(blankForm('folder'), SHARE_VIEWS.folder), 'Grid');
  assert.equal(lookSummary({ ...blankForm('folder'), view: 'gallery', theme: 'dark', logo: 'none', accent: '#123456', title: 'x', sender: true }, SHARE_VIEWS.folder),
    'Gallery · Dark · Own accent · No logo · With a note · Your name');
});
