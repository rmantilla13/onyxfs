// lib/bulk-items.js — an action on a selection that holds folders: which of
// them it acts on, and how it says so.
//
// Pure, so the rules are tested without a page (app/files/FilesClient.js
// applies them). A selection is the folder paths and file ids picked in the
// files pane: folders side by side in the open folder, as a rule, and the
// files beside them. Each folder goes through the routes one folder takes
// (PATCH and DELETE /api/files/folders), one after another; what is here is
// the arithmetic around them.
//
//   outermostFolders  the folders an action needs: one inside another goes with it
//   planMove          which of them a destination moves, has already, or is inside of
//   sumSummaries      what a delete of them all takes, from each folder's ?summary=
//   describeItems     "3 folders", "5 items", "2 folders and 3 files"
//   deleteWords       the one confirmation a delete of them all asks
//   movedWords        how a move went, in a sentence
//   deletedWords      how a delete went, in a sentence

import { isWithin, parentOf } from './folder-ops.js';

const count = (n, one, many = `${one}s`) => `${(Number(n) || 0).toLocaleString('en-US')} ${n === 1 ? one : many}`;

// "3 folders" when all of them, "2 of 3 folders" when not.
const share = ([done, of], one) => (done === of ? count(of, one) : `${done.toLocaleString('en-US')} of ${count(of, one)}`);

/**
 * The folders an action on `paths` has to act on: each once, in the order
 * given, leaving out any inside another of them — moving or deleting the
 * outer one takes it along, and acting on it again would find it gone.
 * The top level ('') is not a folder anyone picks.
 */
export function outermostFolders(paths) {
  const list = [...new Set([...(paths || [])].filter((p) => typeof p === 'string' && p))];
  return list.filter((p) => !list.some((q) => q !== p && isWithin(p, q)));
}

/**
 * Moving `paths` into `dest` ('' is the top level): { move, here, into } —
 * the outermost folders that move, those already in `dest` (nothing to
 * do), and those `dest` is inside of. A folder cannot go into itself, so a
 * move with anything `into` is refused whole, as a drop on one of them is.
 */
export function planMove(paths, dest) {
  const at = typeof dest === 'string' ? dest : '';
  const move = [];
  const here = [];
  const into = [];
  for (const p of outermostFolders(paths)) {
    if (isWithin(at, p)) into.push(p);
    else if (parentOf(p) === at) here.push(p);
    else move.push(p);
  }
  return { move, here, into };
}

/**
 * Each folder's ?summary= (GET /api/files/folders: { files, folders,
 * outside }) added up: what a delete of them all would take.
 */
export function sumSummaries(list) {
  const out = { files: 0, folders: 0, outside: 0 };
  for (const s of list || []) {
    out.files += Number(s?.files) || 0;
    out.folders += Number(s?.folders) || 0;
    out.outside += Number(s?.outside) || 0;
  }
  return out;
}

/**
 * How many of what: "1 folder", "3 folders", "4 files" — and folders with
 * files "5 items", or with `exact` "2 folders and 3 files".
 */
export function describeItems({ folders = 0, files = 0 } = {}, { exact = false } = {}) {
  if (folders && files) return exact ? `${count(folders, 'folder')} and ${count(files, 'file')}` : count(folders + files, 'item');
  if (folders) return count(folders, 'folder');
  return count(files, 'file');
}

/**
 * The confirmation for deleting `folders` folders, and `files` files picked
 * with them, at once: { title, body, confirmLabel }. `inside` is what the
 * folders hold (sumSummaries); `trash` whether the files go to Trash, where
 * they are kept `days`, or are deleted for good. A folder's own tags, notes
 * and stars go with its row either way — a restore brings back its files.
 */
export function deleteWords({ folders = 0, files = 0, inside = {}, trash = false, days = 30 } = {}) {
  const one = folders === 1;
  const held = [];
  if (inside.files) held.push(count(inside.files, 'file'));
  if (inside.folders) held.push(count(inside.folders, 'subfolder'));
  const they = files ? (one ? 'The folder' : 'The folders') : (one ? 'It' : 'They');
  const lines = [held.length
    ? `${they} ${one ? 'holds' : 'hold'} ${held.join(' and ')}.`
    : `${they} ${one ? 'is' : 'are'} empty.`];
  const going = (Number(inside.files) || 0) + (Number(files) || 0);
  if (going && trash) {
    lines.push(`${going === 1 ? 'The file goes' : 'The files go'} to Trash, where you can restore ${going === 1 ? 'it' : 'them'} for ${days} days; the ${one ? 'folder’s' : 'folders’'} own tags, notes and stars are not kept.`);
  } else if (going) {
    lines.push(`${going === 1 ? 'The file' : `All ${count(going, 'file')}`} will be permanently deleted. This cannot be undone.`);
  }
  if (inside.outside) lines.push(`${count(inside.outside, 'file')} from another filespace at ${one ? 'this path' : 'these paths'} will stay.`);
  return {
    title: `Delete ${describeItems({ folders, files }, { exact: true })}?`,
    body: lines.join(' '),
    confirmLabel: `Delete ${describeItems({ folders, files })}`,
  };
}

/**
 * How a move of folders and files went: `folders` and `files` are
 * [moved, tried]. "Moved 3 folders to Archive.", "Moved 2 of 3 folders and
 * 4 files to Archive." Null when nothing moved.
 */
export function movedWords({ folders = [0, 0], files = [0, 0] } = {}, where = '') {
  const parts = [];
  if (folders[0]) parts.push(share(folders, 'folder'));
  if (files[0]) parts.push(share(files, 'file'));
  return parts.length ? `Moved ${parts.join(' and ')} to ${where}.` : null;
}

/**
 * How a delete of folders, and files picked with them, went: `folders` is
 * [deleted, tried], `files` how many files went in all (theirs and the
 * picked ones), `trash` whether those went to Trash. "Deleted 3 folders and
 * moved 42 files to Trash." Null when nothing went.
 */
export function deletedWords({ folders = [0, 0], files = 0, trash = false } = {}) {
  const gone = files ? count(files, 'file') : '';
  if (!folders[0]) {
    if (!files) return null;
    return trash ? `Moved ${gone} to Trash.` : `Deleted ${gone}.`;
  }
  const f = share(folders, 'folder');
  if (!files) return `Deleted ${f}.`;
  return trash ? `Deleted ${f} and moved ${gone} to Trash.` : `Deleted ${f} and ${gone}.`;
}
