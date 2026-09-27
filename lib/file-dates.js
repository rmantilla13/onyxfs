// lib/file-dates.js — a file's Created and Modified, as the web shows them.
//
// A file row has two pairs of times. createdAt and updatedAt are the row's:
// when the file was added here, and when anything about it last changed (a
// rename, a tag). fileCreatedAt and fileModifiedAt are the file's own, from
// where it came: the Mac's file system, the browser's File.lastModified, a
// photo's capture date. They are NULL where the source said nothing, which
// is every file recorded before they existed, so each falls back to the row.
//
// The listing sorts the same way (SORTS in lib/file-query.js), or a column
// sorted by date would not read in order. Import-free: shared by the client.

/** When the file was made: its own date where it came with one, else when it was added. */
export function whenCreated(file) {
  return file?.fileCreatedAt || file?.createdAt || null;
}

/** When the file itself last changed: its own date where it came with one, else when its row did. */
export function whenModified(file) {
  return file?.fileModifiedAt || file?.updatedAt || null;
}
