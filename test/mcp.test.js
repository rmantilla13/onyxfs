// Onyx's MCP server (lib/mcp/server.js) and its tools (lib/mcp/tools.js),
// with the routes they call faked by path: the protocol's answers, and that
// each tool asks its route for what it should and says back what a model
// needs — or the route's refusal, as the tool's answer.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, handleBody, PROTOCOL_VERSIONS } from '../lib/mcp/server.js';
import { TOOLS, listTools } from '../lib/mcp/tools.js';
import { refusalText } from '../lib/mcp/call.js';

const ORIGIN = 'https://onyx.test';

/** A ctx whose routes are `routes[`${method} ${path}`]` → { status, body }, recording each call. */
function fakeCtx(routes) {
  const calls = [];
  return {
    origin: ORIGIN,
    calls,
    async call(_handler, opts) {
      const method = opts.method || 'GET';
      calls.push({ method, path: opts.path, query: opts.query || {}, body: opts.body, params: opts.params });
      const r = routes[`${method} ${opts.path}`];
      if (!r) return { ok: false, status: 404, body: { error: 'File not found' } };
      const out = typeof r === 'function' ? r(opts) : r;
      const status = out.status ?? 200;
      return { ok: status >= 200 && status < 300, status, body: out.body ?? out };
    },
  };
}

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const callTool = (name, args, ctx) => handleMessage(rpc('tools/call', { name, arguments: args }), ctx);
const resultJson = (res) => JSON.parse(res.result.content[0].text);

const file = (over = {}) => ({
  id: 'f1', name: 'shot.jpg', folder: 'Shoots/Day 1', kind: 'image', mime: 'image/jpeg', size: 1234,
  tags: ['hero'], metadata: { client: 'Acme', placeholder: 'data:…' }, createdAt: 1_700_000_000_000,
  reviewStatus: 'approved', openComments: 2, thumbnailKey: '_thumbs/x.webp', ...over,
});

describe('the protocol', () => {
  test('initialize agrees a version it knows, and says what it offers', async () => {
    const res = await handleMessage(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} }), fakeCtx({}));
    assert.equal(res.result.protocolVersion, '2025-03-26');
    assert.ok(res.result.capabilities.tools);
    assert.equal(res.result.serverInfo.name, 'onyx');
    const newer = await handleMessage(rpc('initialize', { protocolVersion: '2099-01-01' }), fakeCtx({}));
    assert.equal(newer.result.protocolVersion, PROTOCOL_VERSIONS[0], 'its own latest, for one it does not know');
  });

  test('notifications get no answer; unknown methods and malformed messages get errors', async () => {
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, fakeCtx({})), null);
    assert.equal((await handleMessage(rpc('nope/never'), fakeCtx({}))).error.code, -32601);
    assert.equal((await handleMessage({ id: 1, method: 'ping' }, fakeCtx({}))).error.code, -32600);
    assert.deepEqual((await handleMessage(rpc('ping'), fakeCtx({}))).result, {});
  });

  test('a batch is answered message by message, without the notifications', async () => {
    const out = await handleBody([rpc('ping', {}, 1), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('ping', {}, 2)], fakeCtx({}));
    assert.deepEqual(out.map((r) => r.id), [1, 2]);
    assert.equal(await handleBody([{ jsonrpc: '2.0', method: 'notifications/initialized' }], fakeCtx({})), null);
  });

  test('tools/list: every tool named onyx_*, described, with an object schema and annotations', async () => {
    const res = await handleMessage(rpc('tools/list'), fakeCtx({}));
    const tools = res.result.tools;
    assert.equal(tools.length, TOOLS.length);
    for (const t of tools) {
      assert.match(t.name, /^onyx_[a-z_]+$/);
      assert.ok(t.description.length > 20, t.name);
      assert.equal(t.inputSchema.type, 'object', t.name);
      assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
      assert.equal(t.annotations.destructiveHint ?? false, false, `${t.name}: nothing here deletes`);
      assert.equal(t.run, undefined, 'the implementation stays here');
    }
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length);
    assert.deepEqual(listTools().map((t) => t.name), tools.map((t) => t.name));
  });

  test('an unknown tool is a protocol error; a refusal is the tool\'s answer', async () => {
    assert.equal((await callTool('onyx_nothing', {}, fakeCtx({}))).error.code, -32602);
    const res = await callTool('onyx_get_file', { file_id: 'nope' }, fakeCtx({}));
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].text, 'File not found');
  });

  test('a tool that throws something unexpected says so plainly, without the detail', async () => {
    const ctx = fakeCtx({});
    ctx.call = async () => { throw new Error('connection refused at 10.0.0.3'); };
    const warn = console.warn; console.warn = () => {};
    try {
      const res = await callTool('onyx_list_drives', {}, ctx);
      assert.equal(res.result.isError, true);
      assert.doesNotMatch(res.result.content[0].text, /10\.0\.0\.3/);
    } finally { console.warn = warn; }
  });
});

describe('finding and reading', () => {
  test('search: the query, scope and filters go to /api/files, and files come back compact', async () => {
    const ctx = fakeCtx({ 'GET /api/files': { files: [file()], cursor: 'c2', total: 41 } });
    const out = resultJson(await callTool('onyx_search_files', { query: 'beach', drive_id: 'd1', folder: 'Shoots', kinds: ['image', 'video'], tags: ['hero'] }, ctx));
    const q = ctx.calls[0].query;
    assert.equal(q.q, 'beach');
    assert.equal(q.filespace, 'd1');
    assert.equal(q.folderPrefix, 'Shoots');
    assert.equal(q.kind, 'image,video');
    assert.equal(q.tags, 'hero');
    assert.equal(q.tagMode, 'any');
    assert.equal(out.next_cursor, 'c2');
    assert.equal(out.total, 41);
    const f = out.files[0];
    assert.equal(f.url, `${ORIGIN}/files/f1`);
    assert.deepEqual(f.metadata, { client: 'Acme' }, 'no placeholder bytes');
    assert.equal(f.review_status, 'approved');
    assert.equal(f.has_preview, true);
  });

  test('browse: the folder\'s files and its direct subfolders only', async () => {
    const ctx = fakeCtx({
      'GET /api/files': { files: [file()], cursor: null },
      'GET /api/files/folders': { folders: [
        { folder: 'Shoots', name: 'Shoots', parent: '', count: 3 },
        { folder: 'Shoots/Day 1', name: 'Day 1', parent: 'Shoots', count: 2, tags: ['wedding'] },
        { folder: 'Shoots/Day 1/Raw', name: 'Raw', parent: 'Shoots/Day 1', count: 9 },
      ] },
    });
    const out = resultJson(await callTool('onyx_browse_folder', { folder: '/Shoots/' }, ctx));
    assert.equal(ctx.calls.find((c) => c.path === '/api/files').query.folder, 'Shoots');
    assert.deepEqual(out.subfolders, [{ path: 'Shoots/Day 1', name: 'Day 1', files: 2, tags: ['wedding'] }]);
  });

  test('looking at a picture returns its preview as an image', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.equal(url, 'https://bucket/sm.webp');
      return new Response(png, { headers: { 'content-type': 'image/webp' } });
    };
    try {
      const ctx = fakeCtx({ 'GET /api/files/f1': { file: file({ smUrl: 'https://bucket/sm.webp', posterUrl: 'https://bucket/p.webp' }), canWrite: true } });
      const res = await callTool('onyx_view_image', { file_id: 'f1' }, ctx);
      const [img, meta] = res.result.content;
      assert.equal(img.type, 'image');
      assert.equal(img.mimeType, 'image/webp');
      assert.equal(Buffer.from(img.data, 'base64').toString('hex'), png.toString('hex'));
      assert.equal(JSON.parse(meta.text).id, 'f1');
    } finally { globalThis.fetch = realFetch; }
  });

  test('no preview and too big to show whole: said, not fetched', async () => {
    const ctx = fakeCtx({ 'GET /api/files/f1': { file: file({ thumbnailKey: null, size: 80e6, url: 'https://bucket/orig' }) } });
    const res = await callTool('onyx_view_image', { file_id: 'f1' }, ctx);
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /no preview/);
  });

  test('reading text only from text files', async () => {
    const ctx = fakeCtx({ 'GET /api/files/f1': { file: file() } });
    const res = await callTool('onyx_read_text', { file_id: 'f1' }, ctx);
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /not a text file/);

    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('hello world, a long note');
    try {
      const ctx2 = fakeCtx({ 'GET /api/files/n1': { file: file({ id: 'n1', name: 'notes.md', mime: 'text/markdown', url: 'https://bucket/n' }) } });
      const out = resultJson(await callTool('onyx_read_text', { file_id: 'n1', max_chars: 100 }, ctx2));
      assert.equal(out.text, 'hello world, a long note');
      assert.equal(out.truncated, false);
    } finally { globalThis.fetch = realFetch; }
  });

  test('a transcript\'s segments, as { start, end, text }', async () => {
    const ctx = fakeCtx({ 'GET /api/files/v1/transcript': { transcript: { status: 'done', language: 'en', segments: [{ s: 0, e: 1.5, t: 'Hi.' }] } } });
    const out = resultJson(await callTool('onyx_get_transcript', { file_id: 'v1' }, ctx));
    assert.deepEqual(out.segments, [{ start: 0, end: 1.5, text: 'Hi.' }]);
  });
});

describe('collections and organizing', () => {
  test('a collection is made with the rules as given, in the drive named', async () => {
    const rules = [{ field: 'tag', op: 'any', values: ['hero'] }];
    const ctx = fakeCtx({ 'POST /api/collections': { status: 201, body: { collection: { id: 'c1', name: 'Heroes' } } } });
    const out = resultJson(await callTool('onyx_create_collection', { name: 'Heroes', drive_id: 'd1', rules }, ctx));
    assert.deepEqual(ctx.calls[0].body, { name: 'Heroes', driveId: 'd1', match: 'all', rules });
    assert.equal(out.collection.id, 'c1');
  });

  test('tags are added and removed against what the file has, not replaced blind', async () => {
    const ctx = fakeCtx({
      'GET /api/files/f1': { file: file({ tags: ['hero', 'draft'] }) },
      'PATCH /api/files/f1': ({ body }) => ({ body: { file: file({ tags: body.tags }) } }),
    });
    const out = resultJson(await callTool('onyx_update_file', { file_id: 'f1', add_tags: ['Final'], remove_tags: ['DRAFT'] }, ctx));
    const patch = ctx.calls.find((c) => c.method === 'PATCH');
    assert.deepEqual(patch.body, { tags: ['hero', 'final'] });
    assert.deepEqual(out.file.tags, ['hero', 'final']);
  });

  test('nothing to change is said, and nothing is sent', async () => {
    const ctx = fakeCtx({});
    const res = await callTool('onyx_update_file', { file_id: 'f1' }, ctx);
    assert.equal(res.result.isError, true);
    assert.equal(ctx.calls.length, 0);
  });

  test('a folder move goes on through its steps, resumable', async () => {
    let n = 0;
    const ctx = fakeCtx({
      'PATCH /api/files/folders': () => (++n < 3 ? { status: 202, body: { more: true } } : { body: { ok: true, files: 2885, folders: 4 } }),
    });
    const out = resultJson(await callTool('onyx_move_folder', { from: 'A', to: 'B', drive_id: 'd1' }, ctx));
    assert.equal(ctx.calls.length, 3);
    assert.ok(ctx.calls.every((c) => c.body.resumable === true && c.body.filespaceId === 'd1'));
    assert.equal(out.files_moved, 2885);
  });

  test('a viewer\'s refusal comes back in the route\'s words', async () => {
    const ctx = fakeCtx({ 'PUT /api/files/folders/meta': { status: 403, body: { error: 'You can view this drive but not change it.' } } });
    const res = await callTool('onyx_tag_folder', { folder: 'A', tags: ['x'], drive_id: 'd1' }, ctx);
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].text, 'You can view this drive but not change it.');
  });
});

describe('sharing and review', () => {
  test('a share link is asked for as the web asks', async () => {
    const ctx = fakeCtx({ 'POST /api/files/f1/shares': { body: { share: { url: 'https://onyx.test/s/abc' } } } });
    await callTool('onyx_create_share_link', { file_id: 'f1', kind: 'public', review: 'comment' }, ctx);
    assert.deepEqual(ctx.calls[0].body, { kind: 'public', password: undefined, expires: '7', review: 'comment' });
  });

  test('comments: the thread, without deleted ones; a reply names its parent', async () => {
    const ctx = fakeCtx({
      'GET /api/files/f1/review': { body: { comments: [
        { id: 'c1', body: 'Brighter?', author: { name: 'Sam' }, createdAt: 1, frameIn: 48 },
        { id: 'c2', body: '', deletedAt: 5, author: {} },
      ], decisions: [{ name: 'Sam', status: 'approved', decidedAt: 2 }], status: 'approved', openComments: 1 } },
      'POST /api/files/f1/comments': { status: 201, body: { comment: { id: 'c3', body: 'Done', createdAt: 3 } } },
    });
    const thread = resultJson(await callTool('onyx_list_comments', { file_id: 'f1' }, ctx));
    assert.equal(thread.comments.length, 1);
    assert.equal(thread.comments[0].author, 'Sam');
    assert.equal(thread.comments[0].frame, 48);
    assert.equal(thread.decisions[0].decision, 'approved');
    await callTool('onyx_add_comment', { file_id: 'f1', body: 'Done', parent_id: 'c1' }, ctx);
    assert.deepEqual(ctx.calls.at(-1).body, { body: 'Done', parentId: 'c1' });
  });
});

test('refusalText', () => {
  assert.equal(refusalText({ status: 400, body: { error: 'Nope.' } }), 'Nope.');
  assert.match(refusalText({ status: 404, body: null }), /Not found/);
  assert.match(refusalText({ status: 403 }), /not allowed/);
});
