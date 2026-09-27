// lib/builtin-views.js — the predetermined views (lib/views.js has what
// they are and how they apply). Data only, so the top bar's palette can list
// them on every page without the rest of the view model.

/**
 * The predetermined views, in the order the Select view menu lists them.
 *
 * The kinds flatten by default: a kind has always been a search through
 * everything beneath the open folder ("every video in this drive"), and one
 * level at a time would find next to nothing at the top of a drive. Turning
 * Flatten off in the Display popover goes back to folder by folder.
 */
export const BUILTIN_VIEWS = Object.freeze([
  { id: 'all', name: 'All files', icon: 'files', filters: {}, sort: 'new', display: { layout: 'grid', fields: ['size', 'type', 'modified'] } },
  { id: 'recent', name: 'Recent', icon: 'clock', filters: {}, sort: 'modified', display: { layout: 'grid', fields: ['modified', 'folder'], flatten: true } },
  { id: 'images', name: 'Images', icon: 'image', filters: { kinds: ['image'] }, sort: 'new', display: { layout: 'tile', fields: ['dimensions'], flatten: true } },
  { id: 'video', name: 'Video', icon: 'film', filters: { kinds: ['video'] }, sort: 'new', display: { layout: 'grid', fields: ['duration', 'dimensions', 'size'], flatten: true } },
  { id: 'audio', name: 'Audio', icon: 'audio-lines', filters: { kinds: ['audio'] }, sort: 'new', display: { layout: 'list', fields: ['duration', 'size', 'modified'], flatten: true } },
  { id: 'documents', name: 'Documents', icon: 'file-text', filters: { kinds: ['doc'] }, sort: 'new', display: { layout: 'list', fields: ['type', 'size', 'modified'], flatten: true } },
  { id: 'other', name: 'Other', icon: 'file', filters: { kinds: ['other'] }, sort: 'new', display: { layout: 'list', fields: ['size', 'type', 'modified'], flatten: true } },
].map((v) => Object.freeze({ ...v, builtin: true })));

export const DEFAULT_VIEW_ID = 'all';
