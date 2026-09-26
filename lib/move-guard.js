/**
 * The server's backstop in front of a save that would repoint stored files
 * (PUT /api/admin/storage, PATCH /api/admin/filespaces). The forms ask
 * first; this is for anything that skipped the question.
 *
 * It fails closed. When the count of what is stored cannot be read — a
 * locked table, a database past its timeout — the answer is "nothing was
 * saved", never "there was nothing to strand". Treating a failed count as
 * zero once let a bucket change through with ten files behind it.
 *
 *   const stop = await guardMove({ changed, confirmed: body.confirmMove, count, message });
 *   if (stop) return NextResponse.json(stop.body, { status: stop.status });
 *
 * `count` resolves to { files }; `message(files)` is the 409's sentence.
 * Only a literal `true` confirms: "true", 1 or "yes" from a hand-written
 * request do not.
 */
export async function guardMove({ changed, confirmed, count, message }) {
  if (!changed || confirmed === true) return null;
  let files;
  try {
    files = Number((await count())?.files);
  } catch (e) {
    return couldNotCount(e);
  }
  if (!Number.isFinite(files)) return couldNotCount(null);
  if (files <= 0) return null;
  return {
    status: 409,
    body: { error: message(files), code: 'confirm_move', files },
  };
}

function couldNotCount(e) {
  return {
    status: 503,
    body: {
      error: 'Could not check what is stored there, so nothing was saved. Try again in a moment.',
      code: 'count_failed',
      ...(e?.message ? { detail: e.message } : {}),
    },
  };
}
