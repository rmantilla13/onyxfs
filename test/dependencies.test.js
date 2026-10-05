// What package.json and next.config.js promise the deployed app.
//
// ffmpeg-static stayed in `dependencies`, approved to run its install script
// and traced into a route, long after the route and the code that ran it were
// gone. Every install downloaded a binary nothing executed. These tests catch
// that kind of leftover: a production dependency no shipped code imports, and
// a file traced into a route that does not exist.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const nextConfig = createRequire(import.meta.url)('../next.config.js');

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.(c|m)?jsx?$/.test(name)) out.push(rel);
  }
  return out;
}

// What the build ships. scripts/ is left out on purpose: a package only a
// script uses belongs in devDependencies.
const SHIPPED = [
  ...sourceFiles('app'), ...sourceFiles('lib'),
  'middleware.js', 'auth.js', 'auth.config.js', 'next.config.js',
].filter((f) => existsSync(join(ROOT, f)));

/**
 * The bare package names a file imports, requires or dynamically imports.
 * `@/…` is this repo's path alias (jsconfig.json), not a package.
 */
function importedPackages(text) {
  const names = new Set();
  const specifiers = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"./][^'"]*)['"]/g;
  for (const [, spec] of text.matchAll(specifiers)) {
    if (spec.startsWith('@/')) continue;
    const parts = spec.split('/');
    names.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  return names;
}

describe('dependencies', () => {
  test('every production dependency is imported by code the build ships', () => {
    const used = new Set();
    for (const f of SHIPPED) {
      for (const name of importedPackages(readFileSync(join(ROOT, f), 'utf8'))) used.add(name);
    }
    const unused = Object.keys(pkg.dependencies).filter((name) => !used.has(name));
    assert.deepEqual(unused, [], `in dependencies but imported by nothing under app/ or lib/: ${unused.join(', ')}`);
  });

  test('the import scan sees each form the code uses', () => {
    const seen = importedPackages([
      "import sharp from 'sharp';",
      "import { put } from '@vercel/blob';",
      "import { NextResponse } from 'next/server';",
      "const { Input } = await import('mediabunny');",
      "const x = require('postgres');",
      "import './local.css';",
      "import { db } from '@/lib/db';",
    ].join('\n'));
    assert.deepEqual([...seen].sort(), ['@vercel/blob','mediabunny', 'next', 'postgres', 'sharp']);
  });
});

/** Every app route's URL path, with (group) segments dropped as Next does. */
function appRoutes(dir = 'app', out = new Set()) {
  const names = readdirSync(join(ROOT, dir));
  if (names.some((n) => /^(route|page)\.(c|m)?jsx?$/.test(n))) {
    const segments = dir.split('/').slice(1).filter((s) => !/^\(.*\)$/.test(s));
    out.add('/' + segments.join('/'));
  }
  for (const name of names) {
    if (statSync(join(ROOT, dir, name)).isDirectory()) appRoutes(join(dir, name), out);
  }
  return out;
}

describe('file tracing', () => {
  const includes = {
    ...nextConfig.experimental?.outputFileTracingIncludes,
    ...nextConfig.outputFileTracingIncludes,
  };

  test('every traced route exists', () => {
    const routes = appRoutes();
    for (const key of Object.keys(includes)) {
      // A glob is checked by the part before its first wildcard.
      const prefix = key.split(/[*?{]/)[0];
      const exists = prefix === key ? routes.has(key) : [...routes].some((r) => r.startsWith(prefix));
      assert.ok(exists, `outputFileTracingIncludes names ${key}, which no route under app/ serves`);
    }
  });

  test('every traced package file comes from a declared dependency', () => {
    for (const paths of Object.values(includes)) {
      for (const p of paths) {
        const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(p);
        if (m) assert.ok(m[1] in pkg.dependencies, `${p} is traced, but ${m[1]} is not in dependencies`);
      }
    }
  });

  test('the route scan finds routes the app has', () => {
    const routes = appRoutes();
    assert.ok(routes.has('/api/cron/previews'));
    assert.ok(routes.has('/api/files/[id]'));
    assert.ok(!routes.has('/api/files/thumbs'));
  });
});
