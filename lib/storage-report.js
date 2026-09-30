/**
 * The arithmetic behind /storage and /storage/duplicates, kept apart from the
 * queries (lib/db.js) and the pages so it can be tested without either.
 * Client-safe: no node built-ins.
 */

/** Days a removed file stays in the trash before the daily sweep purges it (app/api/cron/maintenance). */
export const TRASH_RETENTION_DAYS = 30;

export const KIND_LABELS = {
  video: 'Video',
  image: 'Images',
  audio: 'Audio',
  doc: 'Documents',
  other: 'Other',
};

/** Every kind, in the order the Storage page lists them. */
export const KIND_ORDER = ['video', 'image', 'audio', 'doc', 'other'];

export const kindLabel = (kind) => KIND_LABELS[kind] || KIND_LABELS.other;

/**
 * Kinds as the page shows them: all five, biggest first, each with its share
 * of the bytes (0–1). A kind with no files stays in the list at zero, so the
 * legend does not change shape from one library to the next.
 */
export function kindBreakdown(rows = [], totalBytes = 0) {
  const by = new Map(KIND_ORDER.map((k) => [k, { kind: k, files: 0, bytes: 0 }]));
  for (const r of rows) {
    const k = KIND_LABELS[r?.kind] ? r.kind : 'other';
    const cur = by.get(k);
    cur.files += Number(r.files) || 0;
    cur.bytes += Number(r.bytes) || 0;
  }
  const total = totalBytes || [...by.values()].reduce((n, r) => n + r.bytes, 0);
  return [...by.values()]
    .map((r) => ({ ...r, label: kindLabel(r.kind), share: total > 0 ? r.bytes / total : 0 }))
    .sort((a, b) => b.bytes - a.bytes || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** A format's name as people say it: "mov" → "MOV"; no extension → "No extension". */
export const formatLabel = (ext) => (ext ? String(ext).toUpperCase() : 'No extension');

/**
 * The copy of a duplicate set to keep when nobody chooses: the oldest. It is
 * the original, and the one that links, shares and people's memory point at.
 */
export function keeperOf(files = []) {
  let best = null;
  for (const f of files) {
    if (!best) { best = f; continue; }
    const a = Number(f.createdAt) || Infinity;
    const b = Number(best.createdAt) || Infinity;
    if (a < b || (a === b && String(f.id) < String(best.id))) best = f;
  }
  return best;
}

/**
 * Rows from listDuplicateFiles, as sets of the same bytes: those sharing a
 * content hash AND a size (the hash alone is the bucket's ETag, and the size
 * is a second, independent check on it). Worst first — the set whose extra
 * copies take the most room — with each set's default keeper chosen.
 */
export function groupDuplicates(files = []) {
  const by = new Map();
  for (const f of files) {
    if (!f?.contentHash || !(Number(f.size) > 0)) continue;
    const key = `${f.contentHash}:${Number(f.size)}`;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(f);
  }
  return [...by.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => {
      const size = Number(list[0].size);
      return { key, size, files: list, keep: keeperOf(list).id, reclaim: size * (list.length - 1) };
    })
    .sort((a, b) => b.reclaim - a.reclaim || (a.key < b.key ? -1 : 1));
}

/**
 * What a clean-up would remove: for each set, every file but the one kept.
 * `keep` maps a set's key to the id chosen for it; a set with no choice, or a
 * choice that is not in the set, keeps its default. Never all of a set.
 */
export function copiesToRemove(groups = [], keep = {}) {
  const out = [];
  for (const g of groups) {
    const chosen = g.files.some((f) => f.id === keep[g.key]) ? keep[g.key] : g.keep;
    for (const f of g.files) if (f.id !== chosen) out.push(f);
  }
  return out;
}

/** Bytes a list of files takes up. */
export const bytesOf = (files = []) => files.reduce((n, f) => n + (Number(f?.size) || 0), 0);

const usage = (u) => ({ files: Math.max(0, Number(u?.files) || 0), bytes: Math.max(0, Number(u?.bytes) || 0) });
const less = (a, b) => ({ files: Math.max(0, a.files - b.files), bytes: Math.max(0, a.bytes - b.bytes) });
const cleanPrefix = (p) => String(p || '').replace(/^\/+|\/+$/g, '');

/**
 * What each drive holds, from what is under each drive's prefix.
 *
 * listDrivesWithUsage counts a file toward every drive it sits in, so a drive
 * inside another counts toward both: the right size for a drive, and the wrong
 * one for a bill, where each object is stored once, in one bucket. A file
 * belongs to the deepest drive it sits in (the longest prefix, as
 * lib/storage.js cfgForKey picks the bucket to read it from), so a drive holds
 * what is under its prefix less what is under the drives directly inside it.
 * Two drives on one prefix (each in a bucket of its own) see the same files;
 * the first by id is taken to hold them, and the other nothing.
 *
 * `drives` are { id, prefix, live, trash }, each of the two a { files, bytes }
 * under the prefix. → Map of id → { live, trash }, for every drive given.
 */
export function heldByDrive(drives = []) {
  const holder = new Map();
  const byId = (a, b) => (String(a?.id) < String(b?.id) ? -1 : String(a?.id) > String(b?.id) ? 1 : 0);
  for (const d of [...drives].sort(byId)) {
    const p = cleanPrefix(d?.prefix);
    if (p && !holder.has(p)) holder.set(p, d);
  }
  const out = new Map(drives.map((d) => [d?.id, { live: usage(null), trash: usage(null) }]));
  for (const d of holder.values()) out.set(d.id, { live: usage(d.live), trash: usage(d.trash) });
  const prefixes = [...holder.keys()];
  for (const p of prefixes) {
    // The drive directly around this one, if any: the longest prefix it sits under.
    const around = prefixes.filter((q) => p.startsWith(`${q}/`)).sort((a, b) => b.length - a.length)[0];
    if (!around) continue;
    const inner = holder.get(p);
    const held = out.get(holder.get(around).id);
    held.live = less(held.live, usage(inner.live));
    held.trash = less(held.trash, usage(inner.trash));
  }
  return out;
}
