// lib/request-body.js — a JSON request body, read with a ceiling.
//
// req.json() reads whatever arrives before parsing it. A route that stores
// what it is sent (a saved view) should refuse a megabyte before holding it,
// not after — and say which of "too big" and "not JSON" it was.

export const DEFAULT_MAX_BODY = 32 * 1024;

/** → { body } or { error, status }. An empty body is an error unless `optional`. */
export async function readJsonBody(req, { max = DEFAULT_MAX_BODY, optional = false } = {}) {
  const declared = Number(req.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) return { error: 'That request is too large.', status: 413 };
  let text = '';
  try { text = await req.text(); } catch { return { error: 'The request body could not be read.', status: 400 }; }
  // The declared length can be absent or wrong (chunked); what arrived is not.
  if (Buffer.byteLength(text, 'utf8') > max) return { error: 'That request is too large.', status: 413 };
  if (!text.trim()) return optional ? { body: {} } : { error: 'Send a JSON body.', status: 400 };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: 'The body is not valid JSON.', status: 400 };
  }
}
