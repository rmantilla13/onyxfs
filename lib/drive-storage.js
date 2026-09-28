// lib/drive-storage.js — which storage configuration reads an object, by its
// key. Node only: it reaches lib/db.js for the drives' own keys.

import { listDriveStorage } from './db.js';
import { cfgForKey } from './storage.js';

/**
 * `cfg` is the deployment's Storage configuration. Returns key → the config
 * to read that key with.
 *
 * A drive (filespace) in a bucket of its own, or with keys of its own, lives
 * where the Storage config may not reach; its objects are read there
 * (storage.js cfgForKey). Longest prefix first, so a drive nested in another
 * is matched before the one around it. Everything else — and every drive in
 * the base bucket without keys of its own — is read with `cfg`.
 *
 * Server-side only, and the secrets never leave it: listDriveStorage is the
 * list that includes them, for exactly this.
 */
export async function storageForKeys(cfg) {
  const drives = await listDriveStorage();
  return (key) => cfgForKey(cfg, key, drives);
}

/**
 * The drive an object with this key sits in (the longest prefix holding it),
 * with its secret, for the server's own use; null for one in no drive. What
 * a write that names no drive acts under: the object stays in its drive and
 * is moved there, in that drive's bucket, rather than the catalog moving
 * alone and leaving the bytes (and a mounted drive) behind.
 */
export async function driveHoldingKey(key) {
  const k = String(key || '');
  if (!k) return null;
  let holder = null;
  let depth = -1;
  for (const d of await listDriveStorage()) {
    const p = String(d?.prefix || '').replace(/^\/+|\/+$/g, '');
    if (p && k.startsWith(`${p}/`) && p.length > depth) { holder = d; depth = p.length; }
  }
  return holder;
}
