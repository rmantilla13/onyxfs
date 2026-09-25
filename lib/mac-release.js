/**
 * The Mac app's releases: what the website's download button points at, and
 * what the app asks when it checks for an update (/api/desktop/mac/latest).
 *
 * Releases live on GitHub, published by apple/scripts/release-mac.sh as a
 * release tagged `mac-v<version>` holding Onyx.dmg (for people), Onyx.zip
 * (for the app's updater) and onyx-mac.json (the build number, checksums and
 * minimum macOS). The Tauri client's releases share the repository, so Mac
 * releases are found by their tag rather than by GitHub's single "latest".
 *
 * ONYX_MAC_RELEASE_URL points at an onyx-mac.json directly instead — for a
 * deployment that hosts its own builds, or for trying the updater locally.
 */

export const DEFAULT_RELEASES_REPO = 'rmantilla13/onyxfs';
export const MAC_TAG_PREFIX = 'mac-v';
const CACHE_MS = 10 * 60 * 1000;

/** "0.10.2" vs "0.9.9" as numbers, not strings. Negative, zero or positive. */
export function compareVersions(a, b) {
  const pa = String(a || '0').replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The newest published Mac release in a GitHub releases listing: tagged
 * `mac-v…`, not a draft, not a prerelease, and carrying the app. Newest by
 * version, not by date, so a patch to an older line cannot become "latest".
 */
export function pickMacRelease(releases) {
  const candidates = (Array.isArray(releases) ? releases : []).filter((r) =>
    r && !r.draft && !r.prerelease
    && String(r.tag_name || '').startsWith(MAC_TAG_PREFIX)
    && (r.assets || []).some((a) => a.name === 'Onyx.dmg' || a.name === 'Onyx.zip'));
  candidates.sort((a, b) => compareVersions(b.tag_name.slice(MAC_TAG_PREFIX.length), a.tag_name.slice(MAC_TAG_PREFIX.length)));
  return candidates[0] || null;
}

/**
 * The shape the website and the app use, from a GitHub release and its
 * onyx-mac.json (either may be missing parts). Only https download links are
 * passed on: the updater installs what it downloads.
 */
export function describeRelease({ release = null, feed = {} } = {}) {
  const asset = (name) => (release?.assets || []).find((a) => a.name === name)?.browser_download_url || null;
  const https = (u) => (typeof u === 'string' && u.startsWith('https://') ? u : null);
  const version = String(feed.version || release?.tag_name?.slice(MAC_TAG_PREFIX.length) || '').replace(/^v/, '');
  if (!version) return null;
  const zipUrl = https(feed.zip?.url) || https(asset('Onyx.zip'));
  const dmgUrl = https(feed.dmg?.url) || https(asset('Onyx.dmg'));
  if (!zipUrl && !dmgUrl) return null;
  return {
    version,
    build: feed.build != null ? String(feed.build) : null,
    minimumSystemVersion: feed.minimumSystemVersion || '14.0',
    notes: typeof feed.notes === 'string' ? feed.notes : (release?.body || ''),
    publishedAt: release?.published_at || feed.publishedAt || null,
    dmgUrl,
    zipUrl,
    zipSha256: /^[0-9a-f]{64}$/i.test(feed.zip?.sha256 || '') ? feed.zip.sha256.toLowerCase() : null,
    zipSize: Number(feed.zip?.size) || null,
    pageUrl: https(release?.html_url) || null,
  };
}

let cached = null; // { at, value }

/**
 * The latest Mac release, or null when there is none (or it cannot be
 * reached — a download page must still render). Cached for ten minutes: the
 * GitHub API allows sixty unauthenticated requests an hour, and every copy of
 * the app asks.
 */
export async function latestMacRelease({ fetchImpl = fetch, now = Date.now(), env = process.env } = {}) {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  let value = null;
  try {
    if (env.ONYX_MAC_RELEASE_URL) {
      const feed = await getJson(fetchImpl, env.ONYX_MAC_RELEASE_URL);
      value = describeRelease({ feed });
    } else {
      const repo = env.ONYX_RELEASES_REPO || DEFAULT_RELEASES_REPO;
      const releases = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/releases?per_page=30`, {
        accept: 'application/vnd.github+json',
      });
      const release = pickMacRelease(releases);
      if (release) {
        const feedUrl = release.assets.find((a) => a.name === 'onyx-mac.json')?.browser_download_url;
        const feed = feedUrl ? await getJson(fetchImpl, feedUrl).catch(() => ({})) : {};
        value = describeRelease({ release, feed });
      }
    }
  } catch (e) {
    console.warn('[mac-release] lookup failed:', e.message);
    // Keep serving the last answer rather than flapping to "no release".
    if (cached) return cached.value;
  }
  cached = { at: now, value };
  return value;
}

/** For tests. */
export function _resetMacReleaseCache() { cached = null; }

async function getJson(fetchImpl, url, headers = {}) {
  const r = await fetchImpl(url, { headers: { 'user-agent': 'onyx-release-check', ...headers }, cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}
