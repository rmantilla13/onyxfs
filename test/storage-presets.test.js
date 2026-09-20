// Tests for the provider presets behind Admin → Storage.
//
// The form is where a storage misconfiguration is born, and the two mistakes
// that cost the most are silent: picking a preset that quietly overwrites a
// hand-typed endpoint, and a preset whose endpoint template still contains
// {region} when it reaches the SDK.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_PRESETS, presetById, detectPreset, applyPreset, summarizeChecks,
} from '../lib/storage-presets.js';
import { storageProvider } from '../lib/storage.js';

describe('detectPreset', () => {
  test('agrees with the server about which provider a config is', () => {
    // The form and the credential ladder must not disagree — the ladder is
    // what decides whether a viewer can mount, and the form is what tells
    // the admin whether they can.
    const cases = [
      ['', 'aws'],
      ['https://s3.us-west-004.backblazeb2.com', 'b2'],
      ['https://abc.r2.cloudflarestorage.com', 'r2'],
      ['https://nyc3.digitaloceanspaces.com', 'spaces'],
      ['https://s3.us-east-1.wasabisys.com', 'wasabi'],
      ['https://minio.internal:9000', 'other'],
    ];
    for (const [endpoint, expected] of cases) {
      assert.equal(detectPreset(endpoint), expected, endpoint || '(blank)');
      assert.equal(storageProvider({ endpoint }), expected, `server disagrees on ${endpoint || '(blank)'}`);
    }
  });
});

describe('applyPreset', () => {
  test('fills in an empty endpoint and region', () => {
    const out = applyPreset({ provider: 's3' }, 'b2');
    assert.equal(out.region, 'us-west-004');
    assert.equal(out.endpoint, 'https://s3.us-west-004.backblazeb2.com');
  });

  test('substitutes the region already typed', () => {
    const out = applyPreset({ provider: 's3', region: 'eu-central-003' }, 'b2');
    assert.equal(out.endpoint, 'https://s3.eu-central-003.backblazeb2.com');
  });

  test('never overwrites an endpoint the admin typed', () => {
    // Choosing a preset by accident must not discard real configuration.
    const typed = 'https://s3.eu-central-003.backblazeb2.com';
    assert.equal(applyPreset({ endpoint: typed }, 'b2').endpoint, typed);
    assert.equal(applyPreset({ endpoint: typed }, 'wasabi').endpoint, typed);
  });

  test('switching to AWS clears the endpoint, because that is what AWS is', () => {
    const out = applyPreset({ endpoint: 'https://s3.us-west-004.backblazeb2.com' }, 'aws');
    assert.equal(out.endpoint, '');
    assert.equal(storageProvider(out), 'aws');
  });

  test('always selects the S3 provider', () => {
    assert.equal(applyPreset({ provider: 'blob' }, 'b2').provider, 's3');
  });

  test('an unknown preset changes nothing', () => {
    const form = { provider: 's3', endpoint: 'x' };
    assert.deepEqual(applyPreset(form, 'nope'), form);
  });

  test('no preset leaves an unresolved {region} in a real endpoint', () => {
    // A template reaching the SDK produces a hostname that does not resolve,
    // and the error says nothing about a placeholder.
    for (const p of STORAGE_PRESETS) {
      const out = applyPreset({ provider: 's3' }, p.id);
      if (p.id === 'r2') continue;   // {account} is documented for the admin to fill in
      assert.ok(!String(out.endpoint || '').includes('{'), `${p.id} left a placeholder: ${out.endpoint}`);
    }
  });

  test('every preset is round-trippable through detection', () => {
    for (const p of STORAGE_PRESETS) {
      if (p.id === 'other' || p.id === 'r2') continue;  // no canonical hostname to detect
      const out = applyPreset({ provider: 's3' }, p.id);
      assert.equal(detectPreset(out.endpoint), p.id, `${p.id} → ${out.endpoint}`);
    }
  });

  test('presets declare whether scoped credentials exist there', () => {
    // This is what decides whether read-only members can mount.
    assert.equal(presetById('aws').scoped, true);
    assert.equal(presetById('b2').scoped, true);
    assert.equal(presetById('r2').scoped, false);
  });
});

describe('summarizeChecks', () => {
  const c = (status) => ({ id: status, status });

  test('a single failure is not "all passed"', () => {
    const s = summarizeChecks([c('pass'), c('pass'), c('fail')]);
    assert.equal(s.ok, false);
    assert.match(s.label, /1 of 3 checks failed/);
  });

  test('warnings do not fail the run but are counted', () => {
    const s = summarizeChecks([c('pass'), c('warn')]);
    assert.equal(s.ok, true);
    assert.equal(s.warned, 1);
    assert.match(s.label, /1 with a warning/);
  });

  test('an empty run is not success', () => {
    assert.equal(summarizeChecks([]).ok, false);
    assert.equal(summarizeChecks(undefined).ok, false);
  });
});

// ── Submissions ─────────────────────────────────────────────────────────────
// The admin form is populated from sanitizeStorageConfig, which ADDS derived
// fields for display. Posting it back unfiltered wrote those into the stored
// row — a config with a working secret persisted `hasSecret: false`.

const { sanitizeStorageSubmission, storageMode } = await import('../lib/storage.js');

describe('sanitizeStorageSubmission', () => {
  test('drops the derived display fields', () => {
    const out = sanitizeStorageSubmission({
      provider: 's3', bucket: 'b', hasSecret: false, mode: 'blob', somethingNew: 'x',
    });
    assert.ok(!('hasSecret' in out), 'hasSecret was persisted');
    assert.ok(!('mode' in out), 'mode was persisted');
    assert.ok(!('somethingNew' in out), 'an unknown field was persisted');
    assert.equal(out.bucket, 'b');
  });

  test('mode stays computed from the real config', () => {
    // The bug this prevents: a stale literal shadowing the live answer.
    const out = sanitizeStorageSubmission({ provider: 's3', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', mode: 'blob' });
    assert.equal(storageMode(out), 's3');
  });

  test('normalises the slashes that produce unreachable keys', () => {
    const out = sanitizeStorageSubmission({
      endpoint: 'https://s3.us-west-004.backblazeb2.com/',
      prefix: '/files/',
      publicBaseUrl: 'https://cdn.example.com/',
      region: 'US-WEST-004',
    });
    assert.equal(out.endpoint, 'https://s3.us-west-004.backblazeb2.com');
    assert.equal(out.prefix, 'files');
    assert.equal(out.publicBaseUrl, 'https://cdn.example.com');
    assert.equal(out.region, 'us-west-004');
  });

  test('provider is one of two values, whatever was posted', () => {
    assert.equal(sanitizeStorageSubmission({ provider: 's3' }).provider, 's3');
    assert.equal(sanitizeStorageSubmission({ provider: 'nonsense' }).provider, 'blob');
  });

  test('absent keys stay absent, so a partial edit does not blank the rest', () => {
    const out = sanitizeStorageSubmission({ bucket: 'b' });
    assert.deepEqual(Object.keys(out), ['bucket']);
  });

  test('a non-object is empty, not a crash', () => {
    assert.deepEqual(sanitizeStorageSubmission(null), {});
    assert.deepEqual(sanitizeStorageSubmission('nope'), {});
  });
});
