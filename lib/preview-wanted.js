// lib/preview-wanted.js — whether an original a viewer shows should become
// its file's preview (lib/thumbnail-client.js), asked before the download:
// not when none would be made (imagePreviewFor), nor if skipped here lately.

import { drawableKind, isThumbKey, THUMB_SOURCE_MAX_BYTES } from './media.js';
import { imagePreviewFor } from './poster.js';

const SKIP_PREFIX = 'onyx:thumb-skip:';
const SKIP_MS = 7 * 24 * 3600 * 1000;

// `what`: '' thumbnails, 'sizes', 'preview'.
export function skippedRecently(id, what = '') {
  try { return Date.now() - Number(localStorage.getItem(SKIP_PREFIX + (what ? `${what}:` : '') + id) || 0) < SKIP_MS; } catch { return false; }
}

export function rememberSkip(id, what = '') {
  try { localStorage.setItem(SKIP_PREFIX + (what ? `${what}:` : '') + id, String(Date.now())); } catch {}
}

export function imageMime(file) {
  return String(file?.mime || file?.type || (/\.gif$/i.test(file?.name || '') ? 'image/gif' : ''));
}

export function previewWanted(file, { probe } = {}) {
  if (!file?.id || file.storage !== 's3' || file.posterUrl || file.posterKey) return false;
  if (drawableKind(file, { probe }) !== 'image') return false;
  if (!(Number(file.size) > 0) || Number(file.size) > THUMB_SOURCE_MAX_BYTES) return false;
  if (!isThumbKey(file.thumbnailKey)) return !skippedRecently(file.id);
  if (skippedRecently(file.id, 'preview')) return false;
  const mime = imageMime(file);
  if (/gif/i.test(mime)) return false;
  const w = Number(file.metadata?.width);
  const h = Number(file.metadata?.height);
  return !(w > 0 && h > 0) || !!imagePreviewFor({ width: w, height: h }, { bytes: file.size, mime });
}
