// lib/storage-accounts.js — the accounts this library's files are billed on,
// as Admin → Storage → Prices lists them and PUT /api/admin/storage-prices
// checks against. Server-only: it reads the drives with their keys
// (listDriveStorage), which go no further than cfgForDrive — what comes out
// names a service, a host, a region and buckets, never a key.

import { listDriveStorage } from './db.js';
import { getStorageConfig, storageMode, cfgForDrive } from './storage.js';
import { storageLocation, storageAccounts } from './storage-pricing.js';

/**
 * Where files are kept: the Storage bucket, and every drive that keeps its
 * files somewhere else (cfgForDrive — its own bucket, or keys of its own),
 * whether or not it holds anything yet. Nothing while the files are in
 * Vercel Blob, which has no bucket to price, as the Usage estimate has none.
 * → { mode, accounts } (lib/storage-pricing.js storageAccounts).
 */
export async function storageAccountsInUse() {
  const cfg = await getStorageConfig({ fresh: true });
  const mode = storageMode(cfg);
  if (mode !== 's3') return { mode, accounts: [] };
  const uses = [{ location: storageLocation(cfg), drive: null }];
  for (const d of await listDriveStorage()) {
    const own = cfgForDrive(cfg, d);
    if (own !== cfg) uses.push({ location: storageLocation(own), drive: { id: d.id, name: d.name } });
  }
  return { mode, accounts: storageAccounts(uses) };
}
