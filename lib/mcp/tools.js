// lib/mcp/tools.js — what Claude can do in Onyx (the MCP server, lib/mcp/
// server.js). Each tool is a thin translation onto one of Onyx's own routes
// (lib/mcp/call.js), so it is held to the same rules as the web: Claude sees
// only what the signed-in person can open and changes only what they could.
// Nothing here deletes.
//
// Results are compact JSON — what a model needs to answer or to call the
// next tool (ids, names, paths, cursors) — with a link to open each file in
// Onyx. Pictures come back as images Claude can see.

import { callRoute, refusalText } from './call.js';
import * as filesRoute from '@/app/api/files/route';
import * as fileRoute from '@/app/api/files/[id]/route';
import * as foldersRoute from '@/app/api/files/folders/route';
import * as folderMetaRoute from '@/app/api/files/folders/meta/route';
import * as drivesRoute from '@/app/api/space/filespaces/route';
import * as transcriptRoute from '@/app/api/files/[id]/transcript/route';
import * as reviewRoute from '@/app/api/files/[id]/review/route';
import * as commentsRoute from '@/app/api/files/[id]/comments/route';
import * as sharesRoute from '@/app/api/files/[id]/shares/route';
import * as collectionsRoute from '@/app/api/collections/route';
import * as collectionRoute from '@/app/api/collections/[id]/route';

const KINDS = ['image', 'video', 'audio', 'doc', 'other'];
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const TEXT_MAX_BYTES = 2 * 1024 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|javascript|x-subrip))/;
const TEXT_NAMES = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|srt|vtt|html?|css|js|ts|log|rtf)$/i;

class ToolError extends Error {}
const refuse = (r) => { throw new ToolError(refusalText(r)); };

const iso = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);

/** A file as Claude is told of it. */
function fileOut(f, origin) {
  if (!f) return null;
  const { placeholder, ...metadata } = f.metadata || {}; // eslint-disable-line no-unused-vars
  return {
    id: f.id,
    name: f.name,
    folder: f.folder || '',
    kind: f.kind || null,
    mime: f.mime || null,
    size: f.size ?? null,
    tags: f.tags || [],
    metadata,
    created: iso(f.fileCreatedAt || f.createdAt),
    modified: iso(f.fileModifiedAt || f.updatedAt),
    review_status: f.reviewStatus || null,
    open_comments: f.openComments ?? 0,
    has_preview: !!(f.thumbnailKey || f.thumbnailUrl),
    url: `${origin}/files/${encodeURIComponent(f.id)}`,
  };
}

const page = (r, origin) => ({
  files: (r.body?.files || []).map((f) => fileOut(f, origin)),
  next_cursor: r.body?.cursor || null,
  ...(r.body?.total != null ? { total: r.body.total } : {}),
});

const drive = { type: 'string', description: 'A drive id (from onyx_list_drives). Leave out for All Files: everything this account can open.' };
const cursor = { type: 'string', description: 'next_cursor from the previous page, for the next one.' };
const limit = { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Files per page.' };
const fileId = { type: 'string', description: 'A file id (from a listing or search).' };
const rulesSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  description: 'What a file must meet. A tag or metadata rule also holds when a folder above the file carries the value.',
  items: {
    type: 'object',
    required: ['field'],
    properties: {
      field: { type: 'string', description: '"kind", "tag", or "meta:<field key>" (keys from onyx_list_collections\' fields).' },
      op: { type: 'string', enum: ['any', 'none', 'set', 'unset', 'before', 'after'], default: 'any', description: 'any/none of values; set/unset; before/after a day (date fields only).' },
      values: { type: 'array', items: { type: 'string' }, description: 'For any/none: the values (kinds: image, video, audio, doc, other). For before/after: one YYYY-MM-DD.' },
    },
  },
};

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const TOOLS = [
  // ── Finding and reading ─────────────────────────────────────────────────
  {
    name: 'onyx_list_drives',
    title: 'List drives',
    description: 'The drives this account can open, with its role in each (viewer, editor, owner). Files outside every drive are in All Files (no drive id).',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
    async run(_args, ctx) {
      const r = await ctx.call(drivesRoute.GET, { path: '/api/space/filespaces' });
      if (!r.ok) refuse(r);
      return { drives: (r.body?.filespaces || []).map((d) => ({ id: d.id, name: d.name, role: d.role || null })) };
    },
  },
  {
    name: 'onyx_browse_folder',
    title: 'Browse a folder',
    description: 'A folder\'s subfolders and the files directly in it, a page at a time. Folder paths look like "Campaigns/2026"; "" is the top.',
    inputSchema: {
      type: 'object',
      properties: {
        drive_id: drive,
        folder: { type: 'string', default: '', description: 'The folder path; "" for the top.' },
        sort: { type: 'string', enum: ['name', 'new', 'old', 'size', 'modified'], default: 'name' },
        limit, cursor,
      },
    },
    annotations: READ,
    async run(a, ctx) {
      const folder = String(a.folder || '').replace(/^\/+|\/+$/g, '');
      const [tree, files] = await Promise.all([
        a.cursor ? null : ctx.call(foldersRoute.GET, { path: '/api/files/folders', query: { filespace: a.drive_id } }),
        ctx.call(filesRoute.GET, {
          path: '/api/files',
          query: { filespace: a.drive_id, folder, sort: a.sort || 'name', limit: a.limit || 50, cursor: a.cursor, folders: '0' },
        }),
      ]);
      if (!files.ok) refuse(files);
      const out = page(files, ctx.origin);
      if (tree?.ok) {
        out.subfolders = (tree.body?.folders || [])
          .filter((f) => (f.parent || '') === folder)
          .map((f) => ({ path: f.folder, name: f.name, files: f.count ?? null, ...(f.tags ? { tags: f.tags } : {}), ...(f.metadata ? { metadata: f.metadata } : {}) }));
      }
      return out;
    },
  },
  {
    name: 'onyx_search_files',
    title: 'Search files',
    description: 'Search file names and text across a drive (or all of Onyx), optionally within a folder and its subfolders, by kind or tags. Newest first unless sorted otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find in names and descriptions. Leave out to filter by kind or tags alone.' },
        drive_id: drive,
        folder: { type: 'string', description: 'Only within this folder and the ones inside it.' },
        kinds: { type: 'array', items: { type: 'string', enum: KINDS } },
        tags: { type: 'array', items: { type: 'string' }, description: 'Files carrying any of these tags.' },
        sort: { type: 'string', enum: ['new', 'old', 'name', 'size', 'modified'], default: 'new' },
        limit, cursor,
      },
    },
    annotations: READ,
    async run(a, ctx) {
      const r = await ctx.call(filesRoute.GET, {
        path: '/api/files',
        query: {
          filespace: a.drive_id, q: a.query, folderPrefix: a.folder || '', kind: a.kinds?.join(','),
          tags: a.tags?.join(','), tagMode: 'any', sort: a.sort || 'new', limit: a.limit || 50, cursor: a.cursor,
          folders: '0', withTotal: a.cursor ? undefined : '1',
        },
      });
      if (!r.ok) refuse(r);
      return page(r, ctx.origin);
    },
  },
  {
    name: 'onyx_get_file',
    title: 'Get a file',
    description: 'One file\'s details: where it is, its tags and metadata, dates, review status, and whether this account may change it.',
    inputSchema: { type: 'object', required: ['file_id'], properties: { file_id: fileId } },
    annotations: READ,
    async run(a, ctx) {
      const r = await ctx.call(fileRoute.GET, { path: `/api/files/${a.file_id}`, params: { id: a.file_id } });
      if (!r.ok) refuse(r);
      return { ...fileOut(r.body.file, ctx.origin), can_change: !!r.body.canWrite };
    },
  },
  {
    name: 'onyx_view_image',
    title: 'Look at a file',
    description: 'See a picture, or a video\'s or document\'s preview frame, as an image. "small" (about 512px) is enough to tell what it shows; "large" (up to 2400px) for detail.',
    inputSchema: {
      type: 'object',
      required: ['file_id'],
      properties: { file_id: fileId, size: { type: 'string', enum: ['small', 'large'], default: 'small' } },
    },
    annotations: READ,
    async run(a, ctx) {
      const r = await ctx.call(fileRoute.GET, { path: `/api/files/${a.file_id}`, params: { id: a.file_id } });
      if (!r.ok) refuse(r);
      const f = r.body.file;
      const small = [f.smUrl, f.thumbnailUrl, f.posterUrl];
      const large = [f.posterUrl, f.thumbnailUrl, f.smUrl];
      let url = (a.size === 'large' ? large : small).find(Boolean);
      // No preview yet: a small enough picture is shown as it is.
      if (!url && f.kind === 'image' && Number(f.size) <= IMAGE_MAX_BYTES && /^image\/(jpeg|png|webp|gif)$/.test(f.mime || '')) url = f.url;
      if (!url) throw new ToolError('This file has no preview yet. Onyx draws one for pictures a few minutes after they are added.');
      const res = await fetch(url);
      if (!res.ok) throw new ToolError(`The preview could not be fetched (${res.status}).`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > IMAGE_MAX_BYTES) throw new ToolError('The preview is too large to show. Try size "small".');
      const mimeType = (res.headers.get('content-type') || 'image/webp').split(';')[0];
      return {
        content: [
          { type: 'image', data: bytes.toString('base64'), mimeType },
          { type: 'text', text: JSON.stringify(fileOut(f, ctx.origin)) },
        ],
      };
    },
  },
  {
    name: 'onyx_read_text',
    title: 'Read a text file',
    description: 'The text of a text-like file (txt, md, csv, json, srt, html…), up to max_chars. For a video or a sound, use onyx_get_transcript.',
    inputSchema: {
      type: 'object',
      required: ['file_id'],
      properties: { file_id: fileId, max_chars: { type: 'integer', minimum: 100, maximum: 200000, default: 50000 } },
    },
    annotations: READ,
    async run(a, ctx) {
      const meta = await ctx.call(fileRoute.GET, { path: `/api/files/${a.file_id}`, params: { id: a.file_id } });
      if (!meta.ok) refuse(meta);
      const f = meta.body.file;
      if (!TEXT_TYPES.test(f.mime || '') && !TEXT_NAMES.test(f.name || '')) {
        throw new ToolError(`“${f.name}” is not a text file. Use onyx_view_image to look at it, or onyx_get_transcript for a video or sound.`);
      }
      if (Number(f.size) > TEXT_MAX_BYTES) throw new ToolError('The file is too large to read here (over 2 MB).');
      if (!f.url) throw new ToolError('This file cannot be read from here.');
      const res = await fetch(f.url);
      if (!res.ok) throw new ToolError(`The file could not be read (${res.status}).`);
      const text = await res.text();
      const max = a.max_chars || 50000;
      return { name: f.name, chars: text.length, truncated: text.length > max, text: text.slice(0, max) };
    },
  },
  {
    name: 'onyx_get_transcript',
    title: 'Get a transcript',
    description: 'A video\'s or sound\'s transcript, with timestamps, when one has been made.',
    inputSchema: { type: 'object', required: ['file_id'], properties: { file_id: fileId } },
    annotations: READ,
    async run(a, ctx) {
      const r = await ctx.call(transcriptRoute.GET, { path: `/api/files/${a.file_id}/transcript`, params: { id: a.file_id } });
      if (!r.ok) refuse(r);
      const t = r.body?.transcript;
      if (!t) return { status: 'none', note: 'No transcript has been made. One can be asked for on the file\'s page in Onyx.' };
      return {
        status: t.status, language: t.language || null,
        segments: (t.segments || []).map((s) => ({ start: s.s ?? null, end: s.e ?? null, text: s.t })),
      };
    },
  },

  // ── Collections ─────────────────────────────────────────────────────────
  {
    name: 'onyx_list_collections',
    title: 'List collections',
    description: 'Collections — files gathered by rules on kind, tags and metadata — in All Files and the drives this account can open. Also the workspace\'s metadata fields (for rules) and where a new collection may be made.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
    async run(_a, ctx) {
      const r = await ctx.call(collectionsRoute.GET, { path: '/api/collections' });
      if (!r.ok) refuse(r);
      return {
        collections: (r.body.collections || []).map((c) => ({ id: c.id, name: c.name, drive_id: c.driveId || null, match: c.match, rules: c.rules, can_edit: !!c.canEdit })),
        fields: r.body.fields || [],
        can_create_in: (r.body.canCreate || []).map((d) => d || null),
      };
    },
  },
  {
    name: 'onyx_list_collection_files',
    title: 'List a collection\'s files',
    description: 'The files a collection gathers, a page at a time, optionally narrowed by a search.',
    inputSchema: {
      type: 'object',
      required: ['collection_id'],
      properties: { collection_id: { type: 'string' }, query: { type: 'string' }, sort: { type: 'string', enum: ['new', 'old', 'name', 'size', 'modified'], default: 'new' }, limit, cursor },
    },
    annotations: READ,
    async run(a, ctx) {
      const r = await ctx.call(filesRoute.GET, {
        path: '/api/files',
        query: { collection: a.collection_id, q: a.query, sort: a.sort || 'new', limit: a.limit || 50, cursor: a.cursor, withTotal: a.cursor ? undefined : '1' },
      });
      if (!r.ok) refuse(r);
      return page(r, ctx.origin);
    },
  },
  {
    name: 'onyx_create_collection',
    title: 'Make a collection',
    description: 'Make a collection that gathers the files meeting its rules, in a drive or in All Files. Everyone who can open that drive sees it.',
    inputSchema: {
      type: 'object',
      required: ['name', 'rules'],
      properties: {
        name: { type: 'string', maxLength: 80 },
        drive_id: drive,
        match: { type: 'string', enum: ['all', 'any'], default: 'all', description: 'Whether a file must meet all of the rules or any one.' },
        rules: rulesSchema,
      },
    },
    annotations: WRITE,
    async run(a, ctx) {
      const r = await ctx.call(collectionsRoute.POST, {
        method: 'POST', path: '/api/collections',
        body: { name: a.name, driveId: a.drive_id || '', match: a.match || 'all', rules: a.rules },
      });
      if (!r.ok) refuse(r);
      return { collection: r.body.collection };
    },
  },
  {
    name: 'onyx_update_collection',
    title: 'Change a collection',
    description: 'Rename a collection, or change its rules or whether files must meet all or any of them. What is left out stays as it is.',
    inputSchema: {
      type: 'object',
      required: ['collection_id'],
      properties: { collection_id: { type: 'string' }, name: { type: 'string', maxLength: 80 }, match: { type: 'string', enum: ['all', 'any'] }, rules: rulesSchema },
    },
    annotations: { ...WRITE, idempotentHint: true },
    async run(a, ctx) {
      const body = {};
      for (const k of ['name', 'match', 'rules']) if (a[k] !== undefined) body[k] = a[k];
      const r = await ctx.call(collectionRoute.PATCH, { method: 'PATCH', path: `/api/collections/${a.collection_id}`, params: { id: a.collection_id }, body });
      if (!r.ok) refuse(r);
      return { collection: r.body.collection };
    },
  },

  // ── Organizing ──────────────────────────────────────────────────────────
  {
    name: 'onyx_update_file',
    title: 'Tag, describe, rename or move a file',
    description: 'Change a file: add or remove tags, set metadata fields (null clears one), rename it, or move it to another folder in its drive. Never deletes.',
    inputSchema: {
      type: 'object',
      required: ['file_id'],
      properties: {
        file_id: fileId,
        add_tags: { type: 'array', items: { type: 'string' } },
        remove_tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object', description: 'Field key → value (a list for multi-value fields); null clears it. Keys from onyx_list_collections\' fields.', additionalProperties: true },
        name: { type: 'string', description: 'A new name, extension included.' },
        folder: { type: 'string', description: 'The folder to move it to; "" for the top of its drive.' },
      },
    },
    annotations: WRITE,
    async run(a, ctx) {
      const body = {};
      if (a.add_tags?.length || a.remove_tags?.length) {
        const cur = await ctx.call(fileRoute.GET, { path: `/api/files/${a.file_id}`, params: { id: a.file_id } });
        if (!cur.ok) refuse(cur);
        const drop = new Set((a.remove_tags || []).map((t) => String(t).trim().toLowerCase()));
        const tags = new Set((cur.body.file.tags || []).filter((t) => !drop.has(String(t).toLowerCase())));
        for (const t of a.add_tags || []) if (String(t).trim()) tags.add(String(t).trim().toLowerCase());
        body.tags = [...tags];
      }
      if (a.metadata !== undefined) body.metadata = a.metadata;
      if (a.name !== undefined) body.name = a.name;
      if (a.folder !== undefined) body.folder = a.folder;
      if (!Object.keys(body).length) throw new ToolError('Nothing to change: give tags, metadata, a name or a folder.');
      const r = await ctx.call(fileRoute.PATCH, { method: 'PATCH', path: `/api/files/${a.file_id}`, params: { id: a.file_id }, body });
      if (!r.ok) refuse(r);
      return { file: fileOut(r.body.file || r.body, ctx.origin) };
    },
  },
  {
    name: 'onyx_tag_folder',
    title: 'Tag a folder',
    description: 'Set a folder\'s own tags (the whole list) and metadata. Every file in it, and in the folders inside it, counts as having them in collections; the files themselves are not changed.',
    inputSchema: {
      type: 'object',
      required: ['folder'],
      properties: {
        drive_id: drive,
        folder: { type: 'string', description: 'The folder path, in the drive the files are in.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'The folder\'s tags, replacing what it had.' },
        metadata: { type: 'object', additionalProperties: true, description: 'Field key → value; null clears it.' },
      },
    },
    annotations: { ...WRITE, idempotentHint: true },
    async run(a, ctx) {
      const r = await ctx.call(folderMetaRoute.PUT, {
        method: 'PUT', path: '/api/files/folders/meta',
        body: { folder: a.folder, filespaceId: a.drive_id || undefined, tags: a.tags, metadata: a.metadata },
      });
      if (!r.ok) refuse(r);
      return { folder: a.folder, ...r.body };
    },
  },
  {
    name: 'onyx_move_folder',
    title: 'Rename or move a folder',
    description: 'Rename or move a folder, with everything in it, within its drive: "from" and "to" are full paths ("Shoots/Day 1" → "Shoots/Day One"). A big folder takes several steps; this waits for them.',
    inputSchema: {
      type: 'object',
      required: ['from', 'to'],
      properties: { drive_id: drive, from: { type: 'string' }, to: { type: 'string' } },
    },
    annotations: WRITE,
    async run(a, ctx) {
      for (let round = 0; round < 40; round++) {
        const r = await ctx.call(foldersRoute.PATCH, {
          method: 'PATCH', path: '/api/files/folders',
          body: { from: a.from, to: a.to, filespaceId: a.drive_id || undefined, resumable: true },
        });
        if (r.status === 202 && r.body?.more) continue;
        if (!r.ok) refuse(r);
        return { from: a.from, to: a.to, files_moved: r.body?.files ?? null, folders_moved: r.body?.folders ?? null };
      }
      throw new ToolError('The folder is taking long to move. Ask again: it carries on where it stopped.');
    },
  },

  // ── Sharing and review ──────────────────────────────────────────────────
  {
    name: 'onyx_create_share_link',
    title: 'Make a share link',
    description: 'Make a link to a file. "private": only people in the workspace who can open it. "public": anyone with the link. "password": anyone with the link and the password. A review link also takes comments, or approvals. What this account\'s role allows is checked.',
    inputSchema: {
      type: 'object',
      required: ['file_id', 'kind'],
      properties: {
        file_id: fileId,
        kind: { type: 'string', enum: ['private', 'public', 'password'] },
        password: { type: 'string', description: 'For a password link.' },
        expires_days: { type: 'string', enum: ['never', '1', '7', '30'], default: '7' },
        review: { type: 'string', enum: ['view', 'comment', 'approve'], default: 'view', description: 'What people with a public or password link may do. A private link is view only.' },
      },
    },
    annotations: { ...WRITE, openWorldHint: true },
    async run(a, ctx) {
      const r = await ctx.call(sharesRoute.POST, {
        method: 'POST', path: `/api/files/${a.file_id}/shares`, params: { id: a.file_id },
        body: { kind: a.kind, password: a.password, expires: a.expires_days || '7', review: a.review || 'view' },
      });
      if (!r.ok) refuse(r);
      return { share: r.body.share };
    },
  },
  {
    name: 'onyx_list_comments',
    title: 'Read review comments',
    description: 'A file\'s review comments and approvals, and its review status.',
    inputSchema: { type: 'object', required: ['file_id'], properties: { file_id: fileId } },
    annotations: READ,
    async run(a, ctx) {
      const r = await ctx.call(reviewRoute.GET, { path: `/api/files/${a.file_id}/review`, params: { id: a.file_id } });
      if (!r.ok) refuse(r);
      const b = r.body || {};
      return {
        status: b.status || null,
        open_comments: b.openComments ?? 0,
        comments: (b.comments || []).filter((c) => !c.deletedAt).map((c) => ({
          id: c.id, parent_id: c.parentId || null, author: c.author?.name || c.author?.email || null, body: c.body,
          resolved: !!c.resolvedAt, at: iso(c.createdAt), ...(c.frameIn != null ? { frame: c.frameIn } : {}),
        })),
        decisions: (b.decisions || []).map((d) => ({ by: d.name || d.email || null, decision: d.status, note: d.note, at: iso(d.decidedAt) })),
      };
    },
  },
  {
    name: 'onyx_add_comment',
    title: 'Add a review comment',
    description: 'Comment on a file, or reply to a comment (parent_id). It is posted as this account, and the people watching the file are told.',
    inputSchema: {
      type: 'object',
      required: ['file_id', 'body'],
      properties: { file_id: fileId, body: { type: 'string', maxLength: 5000 }, parent_id: { type: 'string', description: 'The comment to reply to.' } },
    },
    annotations: { ...WRITE, openWorldHint: true },
    async run(a, ctx) {
      const r = await ctx.call(commentsRoute.POST, {
        method: 'POST', path: `/api/files/${a.file_id}/comments`, params: { id: a.file_id },
        body: { body: a.body, ...(a.parent_id ? { parentId: a.parent_id } : {}) },
      });
      if (!r.ok) refuse(r);
      const c = r.body?.comment || r.body;
      return { comment: { id: c?.id, body: c?.body, at: iso(c?.createdAt) } };
    },
  },
];

export { ToolError };

/** The tools as tools/list gives them. */
export function listTools() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
}
