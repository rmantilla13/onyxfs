// lib/share-brands-store.js — the brand kits (lib/share-brands.js) on the
// server: changing them, for the admin routes, and holding a link's look to
// the kits there are, for the routes that make and change links. Its own
// module rather than lib/share-guard.js, which much more imports.
//
// The kits are one settings row, so every change reads the row, changes the
// list and writes it back. The read is fresh and strict (lib/db.js
// getSetting): a read that timed out must never be taken for "no kits",
// or the write that follows would erase every kit there was — the way a
// slow database once wiped the storage config on save.

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getShareBrands, setShareBrands } from '@/lib/db';
import { readKits, findKit } from '@/lib/share-brands';

/** A new kit's id: random, never derived from its name, so a rename changes no link. */
export const newKitId = () => `k${randomBytes(9).toString('base64url')}`;

/** The kits as stored now → { kits } or { error } (a 503 to send). */
export async function readKitsForChange() {
  try {
    return { kits: readKits(await getShareBrands({ fresh: true, strict: true })) };
  } catch {
    return { error: NextResponse.json({ error: 'Could not read the brand kits, so nothing was changed. Try again.' }, { status: 503 }) };
  }
}

/** Keep `kits` as the whole list. */
export const writeKits = (kits, by) => setShareBrands({ kits }, by);

/**
 * A look that names a brand kit there is none of → the response to send, or
 * null. The look's parser checks only an id's shape (lib/share-kinds.js);
 * this is where it is held to the kits there are, read fresh, so a kit an
 * admin removed a moment ago is not put on a new link. `kept` is the kit
 * the link already names: a change that leaves it as it was is not
 * refused for it, even removed — the page shows the workspace's look for an
 * id with no kit, and the sharer is never stuck on a link they cannot save.
 */
export async function kitRefusal(look, { kept = null } = {}) {
  const id = look?.brand;
  if (!id || id === kept) return null;
  let stored;
  try {
    stored = await getShareBrands({ fresh: true, strict: true });
  } catch {
    return NextResponse.json({ error: 'Could not read the brand kits, so nothing was saved. Try again.' }, { status: 503 });
  }
  if (findKit(stored, id)) return null;
  return NextResponse.json({ error: 'That brand kit is no longer available. Choose another, or the workspace’s look.' }, { status: 400 });
}
