// One S3 client per bucket config (lib/storage.js s3ClientFor): the existence
// checks an upload makes — s3UniqueKey's HEADs, then the HEAD that records
// what landed — go over one connection instead of opening one each, which
// against B2 is a TLS handshake a request. And a config saved with a new
// key, region or endpoint is never answered by the client made for the old
// one.
//
// Against a small HTTP server on this machine that answers HEADs the way a
// bucket does and counts the connections made to it. moto will not do for
// this one: it closes every connection after its answer.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const {
  s3ClientFor, s3ClientCache, s3ObjectExists, s3HeadObject, s3DeleteObject, s3CreateMultipartUpload,
} = await import('../lib/storage.js');

/** A bucket that holds `files/there` (7 bytes) and nothing else. */
function fakeBucket() {
  const seen = [];
  let connections = 0;
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
    if (req.method === 'POST' && /[?&]uploads/.test(req.url)) {
      const body = '<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>';
      res.writeHead(200, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    } else if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
    } else if (req.url.split('?')[0].endsWith('/files/there')) {
      res.writeHead(200, { etag: `"${'a'.repeat(32)}"`, 'content-length': 7 });
      res.end();
    } else {
      res.writeHead(404, { 'content-type': 'application/xml', 'content-length': 0 });
      res.end();
    }
  });
  server.on('connection', () => { connections += 1; });
  return {
    seen,
    get connections() { return connections; },
    start: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    stop: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

describe('one S3 client per bucket config', () => {
  const a = fakeBucket();
  const b = fakeBucket();
  let cfg;
  let other;

  before(async () => {
    cfg = { provider: 's3', bucket: 'onyx', region: 'us-east-1', endpoint: await a.start(), accessKeyId: 'AKIDONE', secretAccessKey: 'one', prefix: 'files' };
    other = await b.start();
  });
  after(async () => { await a.stop(); await b.stop(); });
  beforeEach(() => s3ClientCache.clear());

  test('the checks an upload makes share one connection', async () => {
    const before = a.connections;
    for (let i = 0; i < 5; i++) assert.equal(await s3ObjectExists(cfg, `files/free-${i}`), false);
    assert.equal(await s3ObjectExists(cfg, 'files/there'), true);
    assert.deepEqual(await s3HeadObject(cfg, 'files/there'), { etag: 'a'.repeat(32), size: 7, modified: null });
    assert.equal(await s3DeleteObject(cfg, 'files/gone'), true);
    assert.equal(a.connections - before, 1, 'eight requests, one connection');
  });

  test('so do a multipart create and the HEADs that pick its name', async () => {
    const before = a.connections;
    const up = await s3CreateMultipartUpload(cfg, { filename: 'there', folder: '', contentType: 'video/mp4' });
    assert.equal(up.key, 'files/there (2)', 'the name is taken, so the next one');
    assert.equal(up.uploadId, 'up-1');
    assert.equal(a.connections - before, 1);
    assert.equal((await s3ClientFor(cfg)).client, (await s3ClientFor({ ...cfg })).client, 'an equal config is the same client');
  });

  test('a new key, secret, region, bucket or endpoint is a client of its own', async () => {
    const { client } = await s3ClientFor(cfg);
    for (const change of [
      { accessKeyId: 'AKIDTWO' }, { secretAccessKey: 'two' }, { region: 'us-west-2' }, { bucket: 'elsewhere' }, { endpoint: other },
    ]) {
      assert.notEqual((await s3ClientFor({ ...cfg, ...change })).client, client, JSON.stringify(change));
    }
    const rotated = (await s3ClientFor({ ...cfg, secretAccessKey: 'two' })).client;
    assert.equal((await rotated.config.credentials()).secretAccessKey, 'two', 'signed with the new secret');
  });

  test('the bucket hears the new key and region, at the new endpoint', async () => {
    a.seen.length = 0;
    b.seen.length = 0;
    await s3ObjectExists(cfg, 'files/x');
    await s3ObjectExists({ ...cfg, accessKeyId: 'AKIDTWO', region: 'us-west-2' }, 'files/x');
    await s3ObjectExists({ ...cfg, endpoint: other }, 'files/x');
    assert.match(a.seen[0].auth, /Credential=AKIDONE\/\d{8}\/us-east-1\/s3\//);
    assert.match(a.seen[1].auth, /Credential=AKIDTWO\/\d{8}\/us-west-2\/s3\//);
    assert.equal(a.seen.length, 2);
    assert.equal(b.seen.length, 1, 'the new endpoint, not the old client’s');
  });

  test('only so many are kept: the least recently used go first', async () => {
    const keep = (await s3ClientFor(cfg)).client;
    const first = (await s3ClientFor({ ...cfg, accessKeyId: 'AKID0' })).client;
    for (let i = 1; i < 40; i++) {
      await s3ClientFor({ ...cfg, accessKeyId: `AKID${i}` });
      if (i % 4 === 0) await s3ClientFor(cfg); // in use all along
    }
    assert.ok(s3ClientCache.size <= 16, `${s3ClientCache.size} kept`);
    assert.equal((await s3ClientFor(cfg)).client, keep, 'the one in use is kept');
    assert.notEqual((await s3ClientFor({ ...cfg, accessKeyId: 'AKID0' })).client, first, 'one unused since is made again');
  });
});
