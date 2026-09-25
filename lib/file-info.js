// lib/file-info.js — what "Get info" says about a file, or about several.
//
// Rows of raw values with a type, not strings: the dialog formats dates and
// sizes for the viewer's locale and time zone, and the tests pin what is
// said without depending on either. Dependency-free, shared by the client.

import { deriveAuto } from './dam.js';
import { effectiveKind } from './media.js';

const KIND_NAME = { image: 'image', video: 'video', audio: 'audio', doc: 'document', other: 'file' };

/** "JPG image", "MP4 video", "file" — the way a file manager names a kind. */
export function kindLabel(file) {
  const format = deriveAuto(file).format;
  const kind = KIND_NAME[effectiveKind(file)] || 'file';
  return format ? `${format} ${kind}` : kind[0].toUpperCase() + kind.slice(1);
}

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * The facts about one file, in the order they are worth reading: what it is,
 * where it is, when and by whom, then what people have said about it (tags
 * and the schema's metadata fields, only those that have a value).
 *
 * Each row is { key, label, type, value } with type one of
 *   text · bytes · date (epoch ms) · day ('YYYY-MM-DD') · list · folder · seconds
 */
export function fileFacts(file, schema) {
  if (!file) return [];
  const md = file.metadata || {};
  const rows = [];
  const add = (key, label, type, value) => { if (!isEmpty(value)) rows.push({ key, label, type, value }); };

  add('kind', 'Kind', 'text', kindLabel(file));
  add('size', 'Size', 'bytes', file.size != null ? Number(file.size) : null);
  if (Number(md.width) > 0 && Number(md.height) > 0) {
    const aspect = deriveAuto(file).aspect_ratio;
    add('dimensions', 'Dimensions', 'text', `${md.width} × ${md.height}${aspect ? ` (${aspect})` : ''}`);
  }
  add('duration', 'Duration', 'seconds', Number(md.duration) > 0 ? Number(md.duration) : null);
  rows.push({ key: 'where', label: 'Where', type: 'folder', value: file.folder || '' });
  add('added', 'Added', 'date', file.createdAt || null);
  add('added_by', 'Added by', 'text', file.createdBy || null);
  add('modified', 'Modified', 'date', file.updatedAt || null);
  add('tags', 'Tags', 'list', Array.isArray(file.tags) ? file.tags : []);
  for (const f of schema?.fields || []) {
    const v = md[f.key];
    if (f.type === 'multiselect') add(`meta:${f.key}`, f.label, 'list', Array.isArray(v) ? v : v ? [String(v)] : []);
    else if (f.type === 'date') add(`meta:${f.key}`, f.label, 'day', v ? String(v).slice(0, 10) : null);
    else add(`meta:${f.key}`, f.label, 'text', v != null ? String(v) : null);
  }
  add('mime', 'Content type', 'text', file.mime || null);
  add('stored', 'Stored as', 'text', file.storageKey || null);
  return rows;
}

/** Several files at once: how many, how much, and of what kinds. */
export function selectionFacts(files) {
  const list = files || [];
  const kinds = new Map();
  let bytes = 0;
  for (const f of list) {
    bytes += Number(f.size) || 0;
    const k = kindLabel(f);
    kinds.set(k, (kinds.get(k) || 0) + 1);
  }
  return {
    count: list.length,
    bytes,
    kinds: [...kinds.entries()].map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    folders: [...new Set(list.map((f) => f.folder || ''))],
  };
}
