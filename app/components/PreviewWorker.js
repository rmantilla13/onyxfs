'use client';

import { useEffect } from 'react';
import { registerPreviewWorker } from '@/lib/preview-cache';

/**
 * Installs the preview worker (public/thumb-sw.js), which keeps thumbnails
 * and the other previews on this device by their key, so a picture seen once
 * loads from disk on every later visit. In the root layout, so it is there
 * on every page that shows one — the library, Quick Look, a file's page, a
 * share link — once per page load. Renders nothing.
 */
export default function PreviewWorker() {
  useEffect(() => { registerPreviewWorker(); }, []);
  return null;
}
