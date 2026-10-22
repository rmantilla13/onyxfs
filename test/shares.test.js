// Share links: the three kinds, their passwords, the unlock cookie, and the
// sign-in return path a private link depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  newShareToken, hashSharePassword, verifySharePassword,
  shareCookieName, shareCookieValue, shareCookieValid, shareState,
  MAX_PASSWORD_FAILURES,
  newGuestId, guestCookieName, guestCookieValue, readGuestCookie,
} from '../lib/shares.js';
import {
  parseShareRequest, parseShareReview, shareKind, shareReview, reviewLabel, isShareToken, expiryLabel, MIN_PASSWORD,
  parseShareExpiry, parseShareLook, resolveShareLook, parseShareChanges, parseTemplateSettings, parseTemplateName,
  SHARE_TEMPLATES, LOOK_TITLE_MAX, LOOK_MESSAGE_MAX, MAX_EXPIRY_DAYS,
} from '../lib/share-kinds.js';
import { withoutOriginal } from '../lib/media.js';
import { themeLockScript, THEME_SCRIPT } from '../lib/theme.js';
import { safeReturnPath } from '../lib/return-path.js';

test('tokens are 128-bit and URL-safe; old 12-hex tokens still pass the shape check', () => {
  const t = newShareToken();
  assert.match(t, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(newShareToken(), t);
  assert.ok(isShareToken(t));
  assert.ok(isShareToken('0123456789ab'));
  assert.ok(!isShareToken('../etc/passwd'));
  assert.ok(!isShareToken(''));
  assert.ok(!isShareToken('x'.repeat(65)));
});

test('passwords are salted scrypt, and verify', async () => {
  const a = await hashSharePassword('correct horse');
  const b = await hashSharePassword('correct horse');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(a, b, 'a salt per link: the same password never hashes the same twice');
  assert.equal(await verifySharePassword('correct horse', a), true);
  assert.equal(await verifySharePassword('correct horsE', a), false);
  assert.equal(await verifySharePassword('', a), false);
});

test('a link made before scrypt (unsalted SHA-256) still opens with its password', async () => {
  const legacy = createHash('sha256').update('hunter22').digest('hex');
  assert.equal(await verifySharePassword('hunter22', legacy), true);
  assert.equal(await verifySharePassword('hunter23', legacy), false);
  assert.equal(await verifySharePassword('hunter22', 'not-a-hash'), false);
  assert.equal(await verifySharePassword('hunter22', null), false);
});

test('the unlock cookie is bound to the token, the password hash and the secret', () => {
  const secret = 'test-secret';
  const v = shareCookieValue('tok', 'hash1', secret);
  assert.equal(shareCookieName('tok'), 'onyx_share_tok');
  assert.ok(shareCookieValid(v, 'tok', 'hash1', secret));
  assert.ok(!shareCookieValid(v, 'tok', 'hash2', secret), 'a changed password locks out the old cookie');
  assert.ok(!shareCookieValid(v, 'other', 'hash1', secret), 'one link\'s cookie does not open another');
  assert.ok(!shareCookieValid(v, 'tok', 'hash1', 'other-secret'));
  assert.ok(!shareCookieValid(`${v}x`, 'tok', 'hash1', secret));
  assert.ok(!shareCookieValid('', 'tok', 'hash1', secret));
  assert.throws(() => shareCookieValue('tok', 'hash1', ''), /AUTH_SECRET/);
});

test('a link is missing, expired, locked or ok', () => {
  const now = 1_000_000;
  assert.equal(shareState(null, now), 'missing');
  assert.equal(shareState({ expires_at: now - 1 }, now), 'expired');
  assert.equal(shareState({ expires_at: now }, now), 'expired');
  assert.equal(shareState({ expires_at: now + 1, pw_locked_until: now + 5 }, now), 'locked');
  assert.equal(shareState({ pw_locked_until: now - 5 }, now), 'ok');
  assert.equal(shareState({}, now), 'ok');
  assert.ok(MAX_PASSWORD_FAILURES >= 5);
});

test('a stored row presents as public, password or private', () => {
  assert.equal(shareKind({ mode: 'public' }), 'public');
  assert.equal(shareKind({ mode: 'public', password_hash: 'x' }), 'password');
  assert.equal(shareKind({ mode: 'public', hasPassword: true }), 'password');
  assert.equal(shareKind({ mode: 'private' }), 'private');
  assert.equal(shareKind({}), 'public');
});

test('a create request is checked before anything is stored', () => {
  const now = 1_000_000_000;
  const plain = { review: null, downloads: true, look: null };
  assert.deepEqual(parseShareRequest({ kind: 'public' }, { now }), { mode: 'public', password: null, expiresInDays: null, expiresAt: null, ...plain });
  assert.deepEqual(parseShareRequest({ kind: 'private', expires: '7' }, { now }), { mode: 'private', password: null, expiresInDays: 7, expiresAt: now + 7 * 86400000, ...plain });
  assert.deepEqual(parseShareRequest({ kind: 'password', password: 'abcdef', expires: '1' }, { now }), { mode: 'public', password: 'abcdef', expiresInDays: 1, expiresAt: now + 86400000, ...plain });
  assert.match(parseShareRequest({ kind: 'password', password: 'abc' }).error, new RegExp(String(MIN_PASSWORD)));
  assert.match(parseShareRequest({ kind: 'everyone' }).error, /who/);
  assert.match(parseShareRequest({ kind: 'public', expires: '365' }).error, /expires/);
  // A private link never takes a password, even if one is sent.
  assert.equal(parseShareRequest({ kind: 'private', password: 'abcdef' }).password, null);
});

test('a link can take comments, or approvals too — public and password links only', () => {
  assert.equal(parseShareRequest({ kind: 'public', review: 'comment' }).review, 'comment');
  assert.equal(parseShareRequest({ kind: 'password', password: 'abcdef', review: 'approve' }).review, 'approve');
  assert.equal(parseShareRequest({ kind: 'public', review: 'view' }).review, null, 'view is stored as nothing');
  assert.equal(parseShareRequest({ kind: 'public', review: null }).review, null);
  // Refused, not dropped: a sharer must never be told a link takes comments when it does not.
  assert.match(parseShareRequest({ kind: 'private', review: 'comment' }).error, /members/);
  assert.match(parseShareRequest({ kind: 'public', review: 'edit' }).error, /can do/);
  assert.match(parseShareRequest({ kind: 'public', review: true }).error, /can do/);
  // A private link may be asked for as view only, which is what it is.
  assert.equal(parseShareRequest({ kind: 'private', review: 'view' }).review, null);
  assert.deepEqual(parseShareReview(undefined, 'public'), { review: null });
  assert.deepEqual(parseShareReview('approve', 'password'), { review: 'approve' });
});

test('a stored link reads back its level; anything unknown is view only', () => {
  assert.equal(shareReview({ review: 'comment' }), 'comment');
  assert.equal(shareReview({ review: 'approve' }), 'approve');
  assert.equal(shareReview({ review: null }), null);
  assert.equal(shareReview({ review: 'admin' }), null);
  assert.equal(shareReview({}), null);
  assert.equal(reviewLabel('comment'), 'Can comment');
  assert.equal(reviewLabel('approve'), 'Can approve');
  assert.equal(reviewLabel(null), null);
});

test('a guest cookie is signed for its link, and names its guest', () => {
  const secret = 'test-secret';
  const id = newGuestId();
  assert.match(id, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(newGuestId(), id);
  assert.equal(guestCookieName('tok'), 'onyx_guest_tok');

  const value = guestCookieValue('tok', { id, name: 'Zoë Ōta — Studio' }, secret);
  assert.deepEqual(readGuestCookie(value, 'tok', secret), { id, name: 'Zoë Ōta — Studio' });
  assert.equal(readGuestCookie(value, 'other', secret), null, 'one link\'s guest is nobody on another');
  assert.equal(readGuestCookie(value, 'tok', 'other-secret'), null);
  assert.throws(() => guestCookieValue('tok', { id, name: 'x' }, ''), /AUTH_SECRET/);

  // The id is not the secret — it reaches other people as a comment's author —
  // so it cannot be made into someone's cookie, nor a name changed under it.
  const [, name, sig] = value.split('.');
  assert.equal(readGuestCookie(`${newGuestId()}.${name}.${sig}`, 'tok', secret), null);
  const renamed = Buffer.from('Someone else').toString('base64url');
  assert.equal(readGuestCookie(`${id}.${renamed}.${sig}`, 'tok', secret), null);
  for (const bad of ['', 'x', `${id}.${name}`, `${id}.${name}.${sig}.x`, `../${id}.${name}.${sig}`, `${id}..${sig}`]) {
    assert.equal(readGuestCookie(bad, 'tok', secret), null, bad);
  }
});

test('expiry reads as a person would say it', () => {
  const now = 0;
  assert.equal(expiryLabel(null, now), null);
  assert.equal(expiryLabel(-1, now), 'Expired');
  assert.equal(expiryLabel(3600000, now), 'Expires in 1 hour');
  assert.equal(expiryLabel(7 * 86400000, now), 'Expires in 7 days');
});

test('after sign-in, only a path on this site is ever returned to', () => {
  assert.equal(safeReturnPath('/s/abc'), '/s/abc');
  assert.equal(safeReturnPath('/files?folder=a%2Fb#x'), '/files?folder=a%2Fb#x');
  // The middleware hands over a full URL: keep its path, never its host.
  assert.equal(safeReturnPath('http://localhost:3000/files?folder=a'), '/files?folder=a');
  assert.equal(safeReturnPath('https://evil.example/steal'), '/steal');
  assert.equal(safeReturnPath('//evil.example'), null);
  assert.equal(safeReturnPath('/\\evil.example'), null);
  assert.equal(safeReturnPath('javascript:alert(1)'), null);
  assert.equal(safeReturnPath(''), null);
  assert.equal(safeReturnPath(undefined), null);
});

test('a link can end on a date, held to five years and to the future', () => {
  const now = 1_000_000_000;
  const DAY = 86400000;
  assert.deepEqual(parseShareExpiry({ expires: '90' }, now), { expiresAt: now + 90 * DAY, expiresInDays: 90 });
  assert.deepEqual(parseShareExpiry({}, now), { expiresAt: null, expiresInDays: null });
  const at = now + 2.5 * DAY;
  assert.deepEqual(parseShareExpiry({ expires: 'date', expiresAt: at }, now), { expiresAt: at, expiresInDays: 2.5 });
  // The role's longest expiry is checked against the days a date comes to, fractions and all.
  assert.equal(parseShareRequest({ kind: 'public', expires: 'date', expiresAt: at }, { now }).expiresInDays, 2.5);
  assert.match(parseShareExpiry({ expires: 'date' }, now).error, /date/);
  assert.match(parseShareExpiry({ expires: 'date', expiresAt: 'soon' }, now).error, /date/);
  assert.match(parseShareExpiry({ expires: 'date', expiresAt: now - 1 }, now).error, /future/);
  assert.match(parseShareExpiry({ expires: 'date', expiresAt: now + 30_000 }, now).error, /future/);
  assert.match(parseShareExpiry({ expires: 'date', expiresAt: now + (MAX_EXPIRY_DAYS + 1) * DAY }, now).error, /five years/);
});

test('downloads are on unless a link says otherwise, and a private link cannot say so', () => {
  assert.equal(parseShareRequest({ kind: 'public' }).downloads, true);
  assert.equal(parseShareRequest({ kind: 'public', downloads: false }).downloads, false);
  assert.equal(parseShareRequest({ kind: 'password', password: 'abcdef', downloads: false }).downloads, false);
  assert.match(parseShareRequest({ kind: 'public', downloads: 'no' }).error, /download/);
  // Refused, not dropped: members can download the file in the workspace anyway.
  assert.match(parseShareRequest({ kind: 'private', downloads: false }).error, /members/);
  assert.equal(parseShareRequest({ kind: 'private', downloads: true }).downloads, true);
});

test('a look keeps only what differs from the default, and refuses what is not a choice', () => {
  assert.deepEqual(parseShareLook(undefined), { look: null });
  assert.deepEqual(parseShareLook({ view: 'standard', theme: 'auto', logo: 'workspace', title: '  ', sender: false }), { look: null });
  assert.deepEqual(parseShareLook({ view: 'grid' }, 'folder'), { look: null });
  assert.deepEqual(parseShareLook({ view: 'gallery', theme: 'dark', accent: '#abc123', logo: 'none', sender: true }, 'folder'),
    { look: { view: 'gallery', theme: 'dark', accent: '#ABC123', logo: 'none', sender: true } });
  assert.deepEqual(parseShareLook({ view: 'presentation' }, 'file'), { look: { view: 'presentation' } });
  // A view belongs to what the link opens: a file has no gallery, a folder no presentation.
  assert.match(parseShareLook({ view: 'gallery' }, 'file').error, /lays out/);
  assert.match(parseShareLook({ view: 'presentation' }, 'folder').error, /lays out/);
  assert.match(parseShareLook({ theme: 'sepia' }).error, /light/);
  assert.match(parseShareLook({ accent: 'red' }).error, /#RRGGBB/);
  assert.match(parseShareLook({ accent: '#abc' }).error, /#RRGGBB/);
  assert.match(parseShareLook({ accent: '#abcdef;}</style>' }).error, /#RRGGBB/);
  assert.match(parseShareLook({ logo: 'https://example.com/x.png' }).error, /logo/);
  assert.match(parseShareLook({ sender: 'yes' }).error, /who shared/);
  assert.match(parseShareLook([]).error, /looks/);
});

test('a look\'s words are text: one line for the title, the note\'s own breaks, both capped', () => {
  const { look } = parseShareLook({ title: '  Spring\n\tcampaign  ', message: 'Hi,\r\n\r\n\r\n\r\nthe selects.\u0007  \nThanks' });
  assert.equal(look.title, 'Spring campaign');
  assert.equal(look.message, 'Hi,\n\nthe selects.\nThanks');
  assert.equal(parseShareLook({ title: 'x'.repeat(LOOK_TITLE_MAX) }).look.title.length, LOOK_TITLE_MAX);
  // Refused rather than cut: a page must not say less than its sharer wrote.
  assert.match(parseShareLook({ title: 'x'.repeat(LOOK_TITLE_MAX + 1) }).error, new RegExp(String(LOOK_TITLE_MAX)));
  assert.match(parseShareLook({ message: 'x'.repeat(LOOK_MESSAGE_MAX + 1) }).error, new RegExp(String(LOOK_MESSAGE_MAX)));
  assert.match(parseShareLook({ title: 42 }).error, /text/);
});

test('a stored look reads back whole, and anything it does not know is the default', () => {
  assert.deepEqual(resolveShareLook(null, 'folder'), { view: 'grid', theme: 'auto', accent: null, logo: 'workspace', title: '', message: '', sender: false });
  assert.deepEqual(resolveShareLook(null, 'file').view, 'standard');
  const r = resolveShareLook({ view: 'carousel', theme: 'dark', accent: 'tomato', title: 'Selects', future: 1 }, 'folder');
  assert.deepEqual(r, { view: 'grid', theme: 'dark', accent: null, logo: 'workspace', title: 'Selects', message: '', sender: false });
  assert.deepEqual(resolveShareLook('{"theme":"dark"}').theme, 'auto', 'a string is not a look');
});

test('a change names only what it changes', () => {
  const now = 1_000_000_000;
  assert.deepEqual(parseShareChanges({ review: 'comment' }, { now }), { changes: {} });
  assert.deepEqual(parseShareChanges({ expires: 'never' }, { now }), { changes: { expiresAt: null } });
  assert.deepEqual(parseShareChanges({ expires: '7', downloads: false, look: null }, { now }), { changes: { expiresAt: now + 7 * 86400000, downloads: false, look: null } });
  assert.deepEqual(parseShareChanges({ look: { view: 'list' } }, { target: 'folder', now }), { changes: { look: { view: 'list' } } });
  assert.match(parseShareChanges({ look: { view: 'list' } }, { target: 'file', now }).error, /lays out/);
  assert.match(parseShareChanges({ downloads: 1 }, { now }).error, /download/);
});

test('templates are choices to start from: checked as a link is, never a password or a date', () => {
  for (const t of SHARE_TEMPLATES) {
    const parsed = parseTemplateSettings(t.settings);
    assert.ok(!parsed.error, `${t.id}: ${parsed.error}`);
    // Every built-in makes a link that parses, for a file and for a folder.
    for (const target of ['file', 'folder']) {
      const s = parsed.settings;
      const body = { kind: target === 'folder' && s.kind === 'private' ? 'public' : s.kind, password: 'hunter22', expires: s.expires,
        review: target === 'file' ? s.review : undefined, downloads: s.downloads, look: { ...s.look, view: s.views[target] } };
      const req = parseShareRequest(body, { target });
      assert.ok(!req.error, `${t.id} ${target}: ${req.error}`);
    }
  }
  const { settings } = parseTemplateSettings({ kind: 'password', password: 'secret12', expires: '7', review: 'approve', downloads: false,
    views: { file: 'presentation', folder: 'gallery' }, look: { theme: 'dark', view: 'gallery', title: 'Hello' } });
  assert.deepEqual(settings, { kind: 'password', expires: '7', review: 'approve', downloads: false,
    views: { file: 'presentation', folder: 'gallery' }, look: { theme: 'dark', title: 'Hello' } });
  assert.equal('password' in settings, false);
  assert.match(parseTemplateSettings({ expires: 'date', expiresAt: Date.now() + 1e9 }).error, /number of days/);
  assert.match(parseTemplateSettings({ views: { folder: 'presentation' } }).error, /lays out/);
  assert.match(parseTemplateSettings(null).error, /template/);
  assert.deepEqual(parseTemplateName('  Client\nreview '), { name: 'Client review' });
  assert.match(parseTemplateName('   ').error, /Name/);
  assert.match(parseTemplateName('x'.repeat(61)).error, /60/);
});

test('with downloads off, a page is not handed the original where a preview shows the file', () => {
  const pic = { name: 'a.jpg', mime: 'image/jpeg', kind: 'image', url: 'O', thumbnailUrl: 'T', posterUrl: 'P' };
  assert.equal(withoutOriginal(pic).url, undefined);
  assert.equal(withoutOriginal(pic).posterUrl, 'P');
  const cut = { name: 'a.mov', mime: 'video/quicktime', kind: 'video', url: 'O', proxyUrl: 'X' };
  assert.equal(withoutOriginal(cut).url, undefined);
  const doc = { name: 'a.pdf', mime: 'application/pdf', kind: 'other', url: 'O' };
  assert.equal(withoutOriginal(doc).url, undefined, 'a document is only named on the page');
  // Played or drawn from the original, there being nothing else: kept.
  assert.equal(withoutOriginal({ ...cut, proxyUrl: undefined }).url, 'O');
  assert.equal(withoutOriginal({ name: 'a.wav', mime: 'audio/wav', kind: 'audio', url: 'O' }).url, 'O');
  assert.equal(withoutOriginal({ ...pic, thumbnailUrl: undefined, posterUrl: undefined }).url, 'O');
});

test('a link can hold its page to one scheme without touching the visitor\'s own', () => {
  assert.equal(themeLockScript('auto'), '');
  assert.equal(themeLockScript('</script>'), '');
  assert.match(themeLockScript('dark'), /themeLock='dark'/);
  assert.doesNotMatch(themeLockScript('dark'), /localStorage/);
  // The head script honours the lock, so an OS switch does not undo it.
  assert.match(THEME_SCRIPT, /themeLock/);
});
