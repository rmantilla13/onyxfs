// Resolve the `@/…` path alias for `node --test`.
//
// next.config / jsconfig map `@/x` to `<root>/x`, and Node knows nothing about
// it — so any test that imports a real app module (rather than a lib one by
// relative path) failed at resolution with ERR_MODULE_NOT_FOUND. That pushed
// tests toward asserting on extracted helpers instead of on the thing that
// actually runs, which is how a test ends up passing while the code it is
// named after is broken.
//
// Registered from the `test` script in package.json, so it applies to the
// whole suite and nothing has to opt in.

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve as resolvePath } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Node does not guess extensions for file URLs the way a bundler does.
const CANDIDATES = ['', '.js', '.mjs', '.jsx', '/index.js', '/index.mjs'];

function resolveAlias(specifier) {
  const base = resolvePath(ROOT, specifier.slice(2));
  for (const suffix of CANDIDATES) {
    const candidate = suffix.startsWith('/') ? join(base, suffix.slice(1)) : base + suffix;
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const url = resolveAlias(specifier);
      if (url) return { url, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      // Packages built for a bundler assume extensions are added for them.
      // `next` ships no "exports" map, so next-auth's `import 'next/server'`
      // resolves under webpack and not under Node, which adds nothing. Retry
      // with the extension Node's own error message suggests, and only for
      // that specific failure.
      if (e?.code !== 'ERR_MODULE_NOT_FOUND' || /\.[cm]?jsx?$/.test(specifier)) throw e;
      return nextResolve(`${specifier}.js`, context);
    }
  },
});
