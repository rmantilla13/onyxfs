// What the uploader says when the bucket refuses a PUT. Before, a CORS refusal
// read "Failed to fetch" and everything else "Upload failed (400)", for a
// second and a half.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeBucketError } from '../lib/multipart-client.js';

const xml = (code, message) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;

test('no status means the browser blocked it, which is CORS when online', () => {
  assert.match(describeBucketError(0), /CORS.*Admin → Storage.*Apply CORS/);
});

test('bad keys point at the key fields', () => {
  for (const code of ['SignatureDoesNotMatch', 'InvalidAccessKeyId']) {
    const text = describeBucketError(403, xml(code, 'The request signature we calculated does not match'));
    assert.match(text, new RegExp(`storage keys \\(${code}\\)`));
    assert.match(text, /Admin → Storage/);
  }
});

test('a missing permission is named as one', () => {
  assert.match(describeBucketError(403, xml('AccessDenied', 'Access Denied')), /not allowed to write.*AccessDenied/);
});

test('anything else quotes the bucket', () => {
  assert.equal(
    describeBucketError(400, xml('InvalidRequest', 'Value for x-amz-checksum-crc32 header is invalid.')),
    'The bucket rejected the upload (InvalidRequest: Value for x-amz-checksum-crc32 header is invalid.).'
  );
  assert.equal(describeBucketError(502, '<html>Bad gateway</html>'), 'The bucket rejected the upload (HTTP 502).');
});
