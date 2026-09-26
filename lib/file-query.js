// lib/file-query.js — the file listing query, built as a pure function.
//
// This module returns SQL text and a parameter array. It touches no database
// and imports nothing, which is the point: the listing query carries the access
// rules, and access rules that can only be exercised against a live database
// do not get tested. Everything here is verifiable with plain assertions.
//
// The invariant it encodes — AUTHORIZE → FILTER → PRESIGN — now happens inside
// one query. The previous implementation loaded the entire table, filtered in
// JavaScript, applied ACLs in JavaScript, and only then sliced for pagination,
// which made every page load proportional to the size of the library rather
// than the size of the page.
//
// Pagination is keyset, not OFFSET. At 100k rows OFFSET has to walk and discard
// every row it skips, so the last page costs the most; a keyset cursor reads
// only the page it returns, whatever its depth.

/** The columns a listing returns. Kept explicit so `SELECT *` drift can't leak a column. */
export const FILE_COLUMNS = [
  'id', 'name', 'folder', 'kind', 'mime', 'size', 'url', 'storage', 'storage_key',
  'tags', 'notes', 'caption', 'visibility', 'thumbnail_url', 'thumbnail_key', 'filmstrip_key',
  'thumb_status', 'metadata', 'created_by', 'created_at', 'updated_at',
  'deleted_at', 'trash_key', 'seq', 'version', 'content_hash',
  'review_status', 'open_comments',
].join(', ');

// Sort keys → the column ordered on, plus its direction. `id` is always the
// tiebreaker: without a unique final term, rows sharing a sort value can appear
// on two consecutive pages or on neither.
//
// `nullAs` is for nullable columns. A keyset comparison against NULL is NULL,
// not true or false, so a page ending on a NULL-sized file used to yield an
// empty next page and the listing stopped there (and Postgres sorts NULLs
// first under DESC, so "Largest" put them on page one). Ordering and paging on
// coalesce(col, nullAs) instead treats a missing value as the lowest one:
// last under DESC, first under ASC, and consistent across pages either way.
// One expression per column, so a single index would serve both directions.
const SORTS = {
  new: { column: 'created_at', dir: 'DESC' },
  old: { column: 'created_at', dir: 'ASC' },
  name: { column: 'name', dir: 'ASC' },
  name_desc: { column: 'name', dir: 'DESC' },
  size: { column: 'size', dir: 'DESC', nullAs: -1 },
  small: { column: 'size', dir: 'ASC', nullAs: -1 },
  type: { column: 'mime', dir: 'ASC', nullAs: '' },
  type_desc: { column: 'mime', dir: 'DESC', nullAs: '' },
  modified: { column: 'updated_at', dir: 'DESC' },
  modified_old: { column: 'updated_at', dir: 'ASC' },
};

export const SORT_KEYS = Object.keys(SORTS);

export function sortSpec(sort) {
  return (Object.hasOwn(SORTS, sort) && SORTS[sort]) || SORTS.new;
}

/** The SQL a sort orders and pages on: the column, or its NULL-free form. */
function sortExpr({ column, nullAs }) {
  if (nullAs === undefined) return `f.${column}`;
  // A literal, not a parameter: it is a constant from the table above, and an
  // expression index can only match a query whose expression is literal.
  const lit = typeof nullAs === 'number' ? String(nullAs) : `'${String(nullAs).replace(/'/g, "''")}'`;
  return `coalesce(f.${column}, ${lit})`;
}

// Generated thumbnails, matched the way _isThumbArtifact does in JS: anything
// under a `_thumbs/` segment, plus the legacy `<rand>-thumb-<name>.<ext>` form
// that older bucket syncs ingested as standalone rows.
//
// Note the escaped underscore. LIKE treats `_` as a single-character wildcard,
// so `LIKE '_thumbs/%'` would also match `Xthumbs/...`. These are regexes, where
// `_` is literal, which sidesteps the trap entirely.
const THUMB_ARTIFACT_RE = '(^|/)_thumbs/|(^|/)[^/]*-thumb-[^/]*\\.(jpe?g|png|webp)$';

// OS junk that should never surface as a file.
/** A literal for LIKE: backslash, `%` and `_` stand for themselves (backslash is Postgres's default escape). */
const likeLiteral = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

const SYSTEM_KEY_RE = '(^|/)(\\.DS_Store|\\.localized|Thumbs\\.db|desktop\\.ini|\\._[^/]*)$';

// A regex costs many times what a LIKE does, and on a scan of the whole
// library — the folder tree's, a count's — nearly every key matches neither
// of the two above. So each regex only runs for keys that match one of its
// hints first: LIKE patterns that every key the regex can match also matches.
// `_thumbs/` and `-thumb-` both contain "thumb"; an OS-junk name starts the
// key or follows a slash with a dot, or is Thumbs.db or desktop.ini. A hint
// may match more than its regex, which costs a regex call, but never less,
// which would let an artifact through — test/file-query.test.js holds them
// to that. Measured on the folder tree at 500k files: 981 ms without the
// hints, 258 ms with.
const THUMB_HINTS = ['%thumb%'];
const SYSTEM_HINTS = ['%/.%', '.%', '%Thumbs.db', '%desktop.ini'];

/**
 * What is not a file at all: generated thumbnails and OS junk. Shared by the
 * listing and the delta, so a device is never handed a row the library hides.
 */
export function artifactClauses(push) {
  // The hint arm goes first: Postgres evaluates an OR's arms in order and
  // stops at the first true one, so a key no hint matches skips the regex.
  // NOT LIKE terms rather than LIKE ANY, which marks the drive clause.
  const unless = (hints, re) => {
    const none = hints.map((h) => `f.storage_key NOT LIKE ${push(h)}`).join(' AND ');
    return `(f.storage_key IS NULL OR (${none}) OR f.storage_key !~ ${push(re)})`;
  };
  return [
    unless(THUMB_HINTS, THUMB_ARTIFACT_RE),
    unless(SYSTEM_HINTS, SYSTEM_KEY_RE),
    // Legacy rows: a file whose key is some other row's thumbnail is a preview,
    // not a file. NOT EXISTS rather than NOT IN — `NOT IN` against a subquery
    // containing a single NULL evaluates to NULL for every row and silently
    // returns nothing.
    'NOT EXISTS (SELECT 1 FROM files t WHERE t.thumbnail_key = f.storage_key)',
  ];
}

/**
 * Who may see a row: the WHERE fragments for `principal`, none for an admin.
 * The one statement of the rule — the listing, its count and the delta all
 * build from it, so a sync client can never be shown a file the library
 * would refuse.
 */
export function accessClauses({ principal, push }) {
  const where = [];
  // Admins see everything; everyone else must satisfy one of four grants. This
  // is the rule that previously ran in JavaScript after the whole table was
  // loaded, which meant a LIMIT applied before it returned short pages.
  if (!principal?.isAdmin) {
    const email = String(principal?.email || '').toLowerCase();
    const roleId = principal?.roleId || null;
    const grants = Array.isArray(principal?.folderGrants) ? principal.folderGrants : [];

    const clauses = [
      `lower(coalesce(f.created_by, '')) = ${push(email)}`,   // owner
      `f.visibility = 'org'`,                                  // org-visible
      `EXISTS (SELECT 1 FROM file_acl a WHERE a.file_id = f.id
          AND ((a.scope = 'user' AND a.principal = ${push(email)})
            OR (a.scope = 'role' AND a.principal = ${push(roleId)})))`,
    ];

    // A grant on any ancestor folder allows the file. Rather than expanding
    // each file's ancestors, invert it: the file's folder either equals a
    // granted folder or sits beneath one. A grant on '' is the whole library.
    if (grants.length) {
      const g = push(grants);
      // starts_with, not LIKE: a grant is a folder NAME, and folder names
      // hold `_` and `%`, which LIKE reads as wildcards — a grant on
      // "Q1_2024" matching "Q1-2024/hr/…" is a file handed to someone who was
      // never given it.
      clauses.push(`EXISTS (SELECT 1 FROM unnest(${g}::text[]) AS gf
          WHERE gf = '' OR f.folder = gf OR starts_with(f.folder, gf || '/'))`);
    }

    where.push(`(${clauses.join(' OR ')})`);

    // Drives (lib/drive-access.js): a file inside one is for its members, on
    // top of everything above — a private file in a drive stays private to
    // its grantees. The LIKE patterns arrive ready-made on the principal
    // (buildPrincipal), so this module still imports nothing. A grant on the
    // file itself is the one way past the boundary: sharing a file is a
    // deliberate act.
    const all = Array.isArray(principal?.drivePatterns?.all) ? principal.drivePatterns.all : [];
    if (all.length) {
      const mine = Array.isArray(principal.drivePatterns.mine) ? principal.drivePatterns.mine : [];
      const key = `coalesce(f.storage_key, '')`;
      const allowed = [`NOT (${key} LIKE ANY(${push(all)}::text[]))`];
      if (mine.length) allowed.push(`${key} LIKE ANY(${push(mine)}::text[])`);
      allowed.push(`EXISTS (SELECT 1 FROM file_acl a WHERE a.file_id = f.id
          AND ((a.scope = 'user' AND a.principal = ${push(email)})
            OR (a.scope = 'role' AND a.principal = ${push(roleId)})))`);
      where.push(`(${allowed.join(' OR ')})`);
    }
  }

  return where;
}

/**
 * Build the WHERE fragments shared by the listing and its count.
 *
 * `push` appends a parameter and returns its `$n` placeholder, so callers never
 * hand-number placeholders — the single most common way to build a query that
 * reads correctly and binds the wrong values.
 */
function buildFilters({ opts, principal, push }) {
  const where = [];

  // ── Trash ────────────────────────────────────────────────────────────────
  // Soft-deleted rows are hidden everywhere except an explicit trash view.
  where.push(opts.trashed ? 'f.deleted_at IS NOT NULL' : 'f.deleted_at IS NULL');

  // ── Artifacts ────────────────────────────────────────────────────────────
  where.push(...artifactClauses(push));

  // ── Filespace scope ──────────────────────────────────────────────────────
  // A filespace is a bucket prefix. Match the prefix itself or anything under
  // it, never a sibling that merely shares a leading substring.
  if (opts.storagePrefix != null) {
    const sp = String(opts.storagePrefix).replace(/^\/+|\/+$/g, '');
    if (sp) {
      const p = push(sp);
      where.push(`(f.storage_key = ${p} OR f.storage_key LIKE ${push(likeLiteral(sp) + '/%')})`);
    }
  }

  // ── Folder ───────────────────────────────────────────────────────────────
  if (opts.folderPrefix !== undefined && opts.folderPrefix !== null) {
    const prefix = String(opts.folderPrefix);
    if (prefix === '') {
      // Root prefix means every folder — no predicate.
    } else {
      where.push(`(f.folder = ${push(prefix)} OR f.folder LIKE ${push(likeLiteral(prefix) + '/%')})`);
    }
  } else if (opts.folder !== undefined && opts.folder !== null) {
    where.push(`f.folder = ${push(String(opts.folder))}`);
  }

  // ── Kind ─────────────────────────────────────────────────────────────────
  const kinds = opts.kind ? (Array.isArray(opts.kind) ? opts.kind : [opts.kind]).filter(Boolean) : [];
  if (kinds.length) where.push(`f.kind = ANY(${push(kinds)})`);

  // ── Tags ─────────────────────────────────────────────────────────────────
  // Containment (`@>`), not the key-existence operators (`?|` / `?&`). The GIN
  // index on tags uses jsonb_path_ops, which is smaller and faster than the
  // default opclass but supports ONLY containment — `?&` would compile fine and
  // then seq-scan the whole table.
  //
  // Tags are normalized to lowercase on write (see createFile), so comparing
  // lowercased input here preserves the case-insensitive matching the previous
  // JavaScript filter had.
  const tags = Array.isArray(opts.tags)
    ? [...new Set(opts.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
    : [];
  if (tags.length) {
    if (opts.tagMode === 'any') {
      // OR of single-element containments: each one is still an index lookup.
      where.push(`(${tags.map((t) => `f.tags @> ${push(JSON.stringify([t]))}::jsonb`).join(' OR ')})`);
    } else {
      where.push(`f.tags @> ${push(JSON.stringify(tags))}::jsonb`);
    }
  }

  // ── Date range ───────────────────────────────────────────────────────────
  if (opts.createdAfter) where.push(`f.created_at >= ${push(Number(opts.createdAfter))}`);
  if (opts.createdBefore) where.push(`f.created_at <= ${push(Number(opts.createdBefore))}`);

  // ── Search ───────────────────────────────────────────────────────────────
  // Full text over the generated tsvector, OR a substring match on the name.
  // Both are needed: full text is stemmed and token-based, so it will not match
  // a partial word, and people search filenames by fragment constantly.
  if (opts.q) {
    const q = String(opts.q).trim();
    if (q) {
      where.push(
        `(f.search_tsv @@ websearch_to_tsquery('english', ${push(q)}) OR f.name ILIKE ${push('%' + q + '%')})`
      );
    }
  }

  // ── Access ───────────────────────────────────────────────────────────────
  where.push(...accessClauses({ principal, push }));

  return where;
}

/**
 * Build the listing query.
 *
 * `opts.cursor` is `{ value, id }` from the previous page's last row — the
 * sort column's value and that row's id.
 *
 * Returns { text, params, countText, countParams }. The count is a separate
 * statement on purpose: a window-function count over a keyset page cannot see
 * past the LIMIT, and running it only when the caller wants a total keeps it
 * off the common path.
 */
export function buildFileQuery({ opts = {}, principal = {} } = {}) {
  const params = [];
  const push = (v) => `$${params.push(v)}`;

  const where = buildFilters({ opts, principal, push });

  const spec = sortSpec(opts.sort);
  const { column, dir } = spec;
  const expr = sortExpr(spec);

  // Keyset predicate. For DESC the next page is strictly "less than" the
  // cursor; for ASC, greater. Comparing the row-value `(col, id)` rather than
  // two chained conditions keeps it index-friendly and correct on ties.
  if (opts.cursor && opts.cursor.id != null) {
    const op = dir === 'DESC' ? '<' : '>';
    const value = opts.cursor.value ?? spec.nullAs ?? null;
    where.push(`(${expr}, f.id) ${op} (${push(value)}, ${push(opts.cursor.id)})`);
  }

  // Invalid input falls back to the default rather than being clamped into
  // range. Clamping a negative to 1 would return a single row, which a paging
  // client reads as "end of data" — a silent truncation is far worse than
  // ignoring a nonsense parameter.
  const requested = Number(opts.limit);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 100;

  const whereSql = where.length ? `WHERE ${where.join('\n  AND ')}` : '';
  const text = `SELECT ${FILE_COLUMNS.split(', ').map((c) => `f.${c}`).join(', ')}
FROM files f
${whereSql}
ORDER BY ${expr} ${dir}, f.id ${dir}
LIMIT ${push(limit)}`;

  // The count reuses the same filters, minus the keyset predicate — a total
  // that shrank as you paged would be worse than no total at all.
  const countParams = [];
  const countPush = (v) => `$${countParams.push(v)}`;
  const countWhere = buildFilters({ opts, principal, push: countPush });
  const countText = `SELECT count(*)::int AS n FROM files f
${countWhere.length ? `WHERE ${countWhere.join('\n  AND ')}` : ''}`;

  return { text, params, countText, countParams, limit, sort: spec };
}

/**
 * The folders holding files the principal may see, and how many each holds
 * directly — what the sidebar tree is built from.
 *
 * The listing's own WHERE, drive boundary included, grouped by folder instead
 * of paged: the tree can then only show a folder the listing would open onto,
 * and it shows every such folder. It used to be derived from one default page
 * of the listing, which kept only the folders of the 100 newest files. One row
 * per folder keeps the answer the size of the tree, but getting it reads every
 * live row in scope — who may see a file is decided row by row — and the files
 * page waits for it. The artifact hints above are what keep that affordable.
 *
 * Returns { text, params }. Sort, cursor and limit are ignored — they are the
 * listing's paging, and the tree has none.
 */
export function buildFolderCountQuery({ opts = {}, principal = {} } = {}) {
  const params = [];
  const push = (v) => `$${params.push(v)}`;
  const where = buildFilters({ opts, principal, push });
  const text = `SELECT f.folder, count(*)::int AS n
FROM files f
${where.length ? `WHERE ${where.join('\n  AND ')}` : ''}
GROUP BY f.folder`;
  return { text, params };
}

/**
 * The cursor for the page after `rows`. Null when the page was not full, which
 * is how a caller knows it has reached the end without a second query.
 */
export function nextCursor(rows, { column, nullAs }, limit) {
  if (!Array.isArray(rows) || rows.length < limit) return null;
  const last = rows[rows.length - 1];
  if (!last) return null;
  return { value: last[column] ?? nullAs ?? null, id: last.id };
}

/** Encode a cursor for a URL. Opaque by design — its shape is not an API. */
export function encodeCursor(cursor) {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(encoded) {
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(encoded), 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && parsed.id != null) return parsed;
  } catch {
    // A malformed cursor means the first page, not an error. Cursors travel in
    // URLs and get truncated by things outside our control.
  }
  return null;
}

/**
 * One page of the change feed a sync client enumerates against
 * (/api/files/delta): every row written since `cursor`, in `seq` order, each
 * marked with whether this principal may see it in this scope.
 *
 * The page is read over ALL rows, not only the visible ones, and that is
 * deliberate. A row that stops being visible — moved to a drive you are not
 * in, unshared, trashed — changes like any other, and the device holding a
 * copy has to be told to drop it. So a row that is not `shown` goes back as a
 * bare deletion, its id and nothing else: the caller never learns a name, a
 * folder or a key it could not have listed. Filtering in the WHERE instead
 * would silently leave those copies on the device for ever.
 *
 * `scope`:
 *   { drivePattern }     one drive — keys under its prefix (a LIKE pattern,
 *                        escaped, as drivePatterns makes them)
 *   { libraryPatterns }  the library — keys under none of these drives
 *   {}                   everything the principal may see
 */
export function buildDeltaQuery({ cursor = 0, limit = 500, principal = {}, scope = {} } = {}) {
  const params = [];
  const push = (v) => `$${params.push(v)}`;

  const shown = ['f.deleted_at IS NULL', ...artifactClauses(push)];
  const key = `coalesce(f.storage_key, '')`;
  if (scope.drivePattern) {
    shown.push(`${key} LIKE ${push(String(scope.drivePattern))}`);
  } else if (Array.isArray(scope.libraryPatterns) && scope.libraryPatterns.length) {
    shown.push(`NOT (${key} LIKE ANY(${push(scope.libraryPatterns)}::text[]))`);
  }
  shown.push(...accessClauses({ principal, push }));

  const requested = Number(limit);
  const n = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), 1000) : 500;
  const from = Math.max(0, Number(cursor) || 0);

  // coalesce: a NULL anywhere in the rule (a NULL visibility, say) must read
  // as "not shown", exactly as it excludes the row from a listing.
  const text = `SELECT ${FILE_COLUMNS.split(', ').map((c) => `f.${c}`).join(', ')},
  coalesce((${shown.join('\n    AND ')}), false) AS shown
FROM files f
WHERE f.seq > ${push(from)}
ORDER BY f.seq ASC
LIMIT ${push(n)}`;

  return { text, params, limit: n, cursor: from };
}
