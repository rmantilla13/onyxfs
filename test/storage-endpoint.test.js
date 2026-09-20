// The endpoint field, and the "Invalid URL" that came out of it.
//
// A B2 bucket would not connect. Diagnostics said "Read access — fail,
// TypeError Invalid URL", and then, confidently: the key is fine, so check
// the bucket, the region or the endpoint. All three were correct. The actual
// fault was that the endpoint had been pasted the way the Backblaze console
// prints it — "s3.us-west-004.backblazeb2.com", with no scheme. The AWS SDK
// parses the endpoint into a URL before it opens a socket, so nothing was
// ever sent, and the error named a type rather than a field.
//
// Reproduced against the real SDK first:
//   "s3.us-west-004.backblazeb2.com"         -> TypeError: Invalid URL
//   "https://s3.us-west-004.backblazeb2.com" -> reaches the network
//
// Everything below is pure, so it runs without a bucket.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeEndpoint, endpointProblem, storageProvider, b2RegionFromEndpoint } =
  await import('../lib/storage.js');

describe('normalizeEndpoint', () => {
  test('adds the scheme the console does not print', () => {
    // THE bug. Everything else here is guarding the fix.
    const n = normalizeEndpoint('s3.us-west-004.backblazeb2.com');
    assert.equal(n.endpoint, 'https://s3.us-west-004.backblazeb2.com');
    assert.equal(n.problem, null);
    assert.equal(n.changed, true, 'the caller needs to know it was repaired');
  });

  test('https, never http, when the scheme is supplied by us', () => {
    assert.ok(normalizeEndpoint('example.com').endpoint.startsWith('https://'));
  });

  test('an explicit http:// endpoint is left alone', () => {
    // MinIO on a private network is a real deployment; do not silently
    // upgrade it to a scheme its certificate cannot answer.
    assert.equal(normalizeEndpoint('http://minio.internal:9000').endpoint, 'http://minio.internal:9000');
  });

  test('surrounding whitespace and trailing slashes are removed', () => {
    assert.equal(normalizeEndpoint('  https://s3.eu-central-003.backblazeb2.com/  ').endpoint,
      'https://s3.eu-central-003.backblazeb2.com');
  });

  test('an already-correct endpoint is unchanged and not flagged', () => {
    const n = normalizeEndpoint('https://s3.us-west-004.backblazeb2.com');
    assert.equal(n.endpoint, 'https://s3.us-west-004.backblazeb2.com');
    assert.equal(n.changed, false, 'a warning on a correct value is noise');
  });

  test('empty means AWS, which is not a problem', () => {
    for (const blank of ['', null, undefined, '   ']) {
      const n = normalizeEndpoint(blank);
      assert.equal(n.endpoint, '');
      assert.equal(n.problem, null, `${JSON.stringify(blank)} should not be an error`);
    }
  });

  test('case is normalized on the host but the path is left alone', () => {
    // S3 keys are case-sensitive; hostnames are not.
    assert.equal(normalizeEndpoint('HTTPS://S3.Us-West-004.backblazeb2.com').endpoint,
      'https://s3.us-west-004.backblazeb2.com');
  });

  describe('values it refuses rather than guesses at', () => {
    test('a non-http scheme', () => {
      const n = normalizeEndpoint('s3://my-bucket');
      assert.equal(n.endpoint, '');
      assert.match(n.problem, /s3:\/\//);
      assert.match(n.problem, /https/);
    });

    test('something that is not a URL at all', () => {
      for (const junk of ['not a host', 'https://', '://x']) {
        const n = normalizeEndpoint(junk);
        assert.equal(n.endpoint, '', `${junk} should not produce an endpoint`);
        assert.ok(n.problem, `${junk} should explain itself`);
      }
    });

    test('the message names the value and shows a correct one', () => {
      // A diagnostic that does not show the shape of the right answer just
      // moves the guessing somewhere else.
      const { problem } = normalizeEndpoint('not a host');
      assert.match(problem, /not a host/);
      assert.match(problem, /https:\/\/s3\./);
    });
  });

  test('the result is stable under repeated normalization', () => {
    const once = normalizeEndpoint('s3.us-west-004.backblazeb2.com').endpoint;
    assert.equal(normalizeEndpoint(once).endpoint, once);
    assert.equal(normalizeEndpoint(once).changed, false);
  });
});

describe('endpointProblem', () => {
  test('catches the bucket pasted onto the end of the endpoint', () => {
    // Path-style addressing appends the bucket itself, so this sends every
    // request to /b/b/<key> while the bucket, region and key are all correct.
    const p = endpointProblem({ endpoint: 'https://s3.us-west-004.backblazeb2.com/photos', bucket: 'photos' });
    assert.ok(p);
    assert.match(p.fix, /Remove "\/photos"/);
  });

  test('bucket matching is case-insensitive', () => {
    assert.ok(endpointProblem({ endpoint: 'https://s3.us-west-004.backblazeb2.com/Photos', bucket: 'photos' }));
  });

  test('a path that is not the bucket is left alone', () => {
    // A gateway mounted under a path prefix is legitimate.
    assert.equal(endpointProblem({ endpoint: 'https://gw.example.com/s3', bucket: 'photos' }), null);
  });

  test('a clean config has no problem', () => {
    assert.equal(endpointProblem({ endpoint: 'https://s3.us-west-004.backblazeb2.com', bucket: 'photos' }), null);
    assert.equal(endpointProblem({ endpoint: '', bucket: 'photos' }), null);
  });

  test('an unparseable endpoint is reported here too', () => {
    const p = endpointProblem({ endpoint: 's3://photos', bucket: 'photos' });
    assert.ok(p);
    assert.match(p.fix, /https:\/\//);
  });
});

describe('the scheme-less endpoint still identifies its provider', () => {
  // This is why the bug survived: every check that looked at the endpoint
  // matched on substrings and was perfectly happy with it. Only the SDK,
  // which parses it, was not — and it spoke last.
  test('provider detection', () => {
    assert.equal(storageProvider({ endpoint: 's3.us-west-004.backblazeb2.com' }), 'b2');
  });
  test('region extraction', () => {
    assert.equal(b2RegionFromEndpoint('s3.us-west-004.backblazeb2.com'), 'us-west-004');
  });
});
