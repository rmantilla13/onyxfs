// A route's work as it goes, one line of JSON at a time (NDJSON): what PATCH
// /api/files/folders streams when the caller asks to see progress. Every
// line but the last is progress, { phase, done, total }; the last is the
// answer, { status, body }, which a streamed response cannot put in its
// status line — that went out before the work began.
//
// Web streams and nothing else, so the same module serves the route and the
// page.

const isAnswer = (obj) => !!obj && typeof obj === 'object' && 'status' in obj && 'body' in obj;

/**
 * A Response that streams `run(report)`'s progress and then its answer.
 * `report(phase, done, total)` sends a line — at most every `everyMs` within
 * a phase, always for a new phase or a phase's last step — and never throws:
 * a reader who has gone away does not stop the work. `run` resolves the
 * answer, { status, body }; a throw becomes a 500 answer.
 */
export function ndjsonResponse(run, { everyMs = 200 } = {}) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (obj) => {
        if (!open) return;
        try { controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`)); } catch { open = false; }
      };
      let phase = null;
      let last = 0;
      const report = (p, done = null, total = null) => {
        const now = Date.now();
        const edge = p !== phase || (done != null && total != null && done >= total);
        if (!edge && now - last < everyMs) return;
        phase = p;
        last = now;
        send({ phase: p, done, total });
      };
      let answer;
      try {
        answer = await run(report);
      } catch (e) {
        answer = { status: 500, body: { error: e?.message || 'Something went wrong.' } };
      }
      send(isAnswer(answer) ? answer : { status: 500, body: { error: 'No answer.' } });
      if (open) { try { controller.close(); } catch {} }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      // Proxies that buffer until the end would hold every line back.
      'x-accel-buffering': 'no',
    },
  });
}

/** Whether `response` is one of these. */
export const isNdjson = (response) => /application\/x-ndjson/i.test(response?.headers?.get('content-type') || '');

/**
 * Read `response`'s lines as they arrive: onLine(obj) for each progress
 * line. → the answer, { status, body }, or null when the stream ended
 * without one — the function was stopped, or the connection dropped.
 */
export async function readNdjson(response, onLine) {
  const reader = response?.body?.getReader?.();
  if (!reader) return null;
  const dec = new TextDecoder();
  let buf = '';
  let answer = null;
  const take = (text) => {
    const line = text.trim();
    if (!line) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (isAnswer(obj)) answer = obj;
    else onLine?.(obj);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        take(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    take(buf + dec.decode());
  } catch {
    // Cut off part-way: what arrived is what there is.
  }
  return answer;
}
