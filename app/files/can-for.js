// app/files/can-for.js — what the library's menus may offer for a file.
//
// Pure, and shared by the client and its tests. The answer comes from the
// server: every row the listing returns carries `can` ({ edit, delete,
// share }), worked out by the same rule the routes apply (fileWriteDecision,
// through lib/file-listing.js withFileCan). The page-level `canWrite` — may
// this role add files here — used to gate Rename, Move and Delete on every
// file, so a Member was offered them on a colleague's file the server would
// refuse, and got a 403 for trying.

/**
 * { edit, delete, share } for one file. A row without the server's answer
 * (one added on this page, say, before the next fetch) falls back to the
 * page's `canWrite`, which is what every file got before.
 */
export function canFor(file, { canWrite = false } = {}) {
  const c = file?.can;
  if (!c || typeof c !== 'object') return { edit: !!canWrite, delete: !!canWrite, share: !!canWrite };
  return { edit: !!c.edit, delete: !!c.delete, share: !!c.share };
}

/**
 * Whether an action may be offered for a selection: when at least one of
 * the selected files allows it. The bulk actions go file by file and say how
 * many could not be done, so a mixed selection is not refused outright —
 * but a selection where none can be is never offered it. Ids not among
 * `files` (selected on a page since scrolled away) count as the page's
 * `canWrite`.
 */
export function canForSome(ids, files, action, { canWrite = false } = {}) {
  const byId = new Map((files || []).map((f) => [f.id, f]));
  return [...(ids || [])].some((id) => (byId.has(id) ? canFor(byId.get(id), { canWrite })[action] : !!canWrite));
}
