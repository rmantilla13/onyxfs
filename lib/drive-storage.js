// lib/drive-storage.js — which storage configuration reads an object, by its
// key. Node only: it reaches lib/db.js for the drives' own keys.

import { listFilespaces, getFilespace } from './db.js';
import { cfgForFilespace } from './storage.js';

/**
 * `cfg` is the deployment's Storage configuration. Returns key → the config
 * to read that key with.
 *
 * A drive (filespace) with keys of its own lives in a bucket the Storage keys
 * may not open; its objects are read with its keys. Longest prefix first, so
 * a drive nested in another is matched before the one around it. Everything
 * else — and every drive without keys of its own — is read with `cfg`.
 *
 * Server-side only, and the secrets never leave it: getFilespace is the one
 * getter that includes them, for exactly this.
 */
export async function storageForKeys(cfg) {
  const own = [];
  for (const f of await listFilespaces()) {
    if (!f.accessKeyId || !f.hasSecret) continue;
    const full = await getFilespace(f.id);
    const prefix = String(full?.prefix || '').replace(/^\/+|\/+$/g, '');
    if (full && prefix) own.push({ prefix, cfg: cfgForFilespace(cfg, full) });
  }
  own.sort((a, b) => b.prefix.length - a.prefix.length);
  return (key) => own.find((o) => String(key).startsWith(`${o.prefix}/`))?.cfg || cfg;
}
