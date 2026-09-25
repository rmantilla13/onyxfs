// Finding the Mac app's latest release — what the download button links to
// and what every installed copy's updater is told to install. The updater
// verifies what it downloads, but it can only install what this points at,
// so the choice of release and the links passed on are pinned here.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, pickMacRelease, describeRelease, latestMacRelease, _resetMacReleaseCache } from '../lib/mac-release.js';

const asset = (name) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/x/${name}` });
const release = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets: [asset('Onyx.dmg'), asset('Onyx.zip'), asset('onyx-mac.json')], html_url: `https://github.com/o/r/releases/tag/${tag}`, body: 'notes', published_at: '2026-10-01T00:00:00Z', ...extra });

describe('which release', () => {
  test('versions compare as numbers', () => {
    assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
    assert.ok(compareVersions('v1.0', '0.99') > 0);
    assert.equal(compareVersions('0.2', '0.2.0'), 0);
  });

  test('the newest Mac release by version — not the Tauri one, not a draft, not a prerelease, not an empty one', () => {
    const picked = pickMacRelease([
      release('v0.9.0'),                                  // the Tauri client's
      release('mac-v0.9.0', { draft: true }),
      release('mac-v0.8.0', { prerelease: true }),
      release('mac-v0.3.0', { assets: [asset('notes.txt')] }),
      release('mac-v0.2.10'),
      release('mac-v0.2.9', { published_at: '2027-01-01T00:00:00Z' }), // later, but older
    ]);
    assert.equal(picked.tag_name, 'mac-v0.2.10');
    assert.equal(pickMacRelease([release('v1.0.0')]), null);
    assert.equal(pickMacRelease(null), null);
  });
});

describe('what is passed on', () => {
  test('links, checksum and build from the release and its onyx-mac.json', () => {
    const d = describeRelease({
      release: release('mac-v0.3.0'),
      feed: { version: '0.3.0', build: 202610011200, minimumSystemVersion: '14.0', zip: { sha256: 'A'.repeat(64), size: 10 } },
    });
    assert.equal(d.version, '0.3.0');
    assert.equal(d.build, '202610011200');
    assert.equal(d.zipSha256, 'a'.repeat(64));
    assert.match(d.dmgUrl, /^https:\/\/github\.com\/.*Onyx\.dmg$/);
    assert.match(d.zipUrl, /Onyx\.zip$/);
  });

  test('only https links, and a checksum only if it is one', () => {
    const d = describeRelease({ feed: { version: '1.0', zip: { url: 'http://evil.example/Onyx.zip', sha256: 'nope' }, dmg: { url: 'https://ok.example/Onyx.dmg' } } });
    assert.equal(d.zipUrl, null);
    assert.equal(d.zipSha256, null);
    assert.equal(d.dmgUrl, 'https://ok.example/Onyx.dmg');
    assert.equal(describeRelease({ feed: { version: '1.0', zip: { url: 'ftp://x' } } }), null, 'nothing to download is no release');
    assert.equal(describeRelease({}), null);
  });
});

describe('looking it up', () => {
  beforeEach(() => _resetMacReleaseCache());

  const github = (releases, feed = {}) => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.includes('api.github.com')) return { ok: true, json: async () => releases };
      if (url.endsWith('onyx-mac.json')) return { ok: true, json: async () => feed };
      return { ok: false, status: 404 };
    };
    return { fetchImpl, calls };
  };

  test('from GitHub, cached for ten minutes', async () => {
    const { fetchImpl, calls } = github([release('mac-v0.4.0')], { version: '0.4.0', build: '7' });
    const a = await latestMacRelease({ fetchImpl, now: 1000, env: {} });
    const b = await latestMacRelease({ fetchImpl, now: 1000 + 9 * 60 * 1000, env: {} });
    assert.equal(a.version, '0.4.0');
    assert.equal(b, a);
    assert.equal(calls.filter((u) => u.includes('api.github.com')).length, 1);
    assert.match(calls[0], /repos\/rmantilla13\/onyxfs\/releases/);
  });

  test('an outage keeps the last answer, and none at all is null, not a crash', async () => {
    const ok = github([release('mac-v0.4.0')]);
    await latestMacRelease({ fetchImpl: ok.fetchImpl, now: 0, env: {} });
    const down = async () => { throw new Error('offline'); };
    assert.equal((await latestMacRelease({ fetchImpl: down, now: 11 * 60 * 1000, env: {} })).version, '0.4.0');
    _resetMacReleaseCache();
    assert.equal(await latestMacRelease({ fetchImpl: down, now: 0, env: {} }), null);
  });

  test('a deployment can point at its own feed', async () => {
    const fetchImpl = async (url) => ({ ok: true, json: async () => ({ version: '2.0.0', zip: { url: 'https://builds.example.com/Onyx.zip', sha256: 'b'.repeat(64) } }), url });
    const r = await latestMacRelease({ fetchImpl, now: 0, env: { ONYX_MAC_RELEASE_URL: 'https://builds.example.com/onyx-mac.json' } });
    assert.equal(r.version, '2.0.0');
    assert.equal(r.zipUrl, 'https://builds.example.com/Onyx.zip');
  });
});
