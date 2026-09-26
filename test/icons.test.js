import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSprite, render, renderSwift, usedNames, usedSwiftNames } from '../scripts/gen-icons.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('icon-data.js is what the generator makes from the kit and the app', () => {
  // A new <Icon name="…"> without `npm run icons` would render nothing.
  const expected = render(parseSprite(read('vendor/lucide/sprite.svg')), usedNames(ROOT));
  assert.equal(read('app/components/ui/icon-data.js'), expected, 'run `npm run icons`');
});

test('LucideData.swift is current with the icons the Mac app names', () => {
  const expected = renderSwift(parseSprite(read('vendor/lucide/sprite.svg')), usedSwiftNames(ROOT));
  assert.equal(read('apple/OnyxMac/LucideData.swift'), expected, 'run `npm run icons`');
  assert.ok(usedSwiftNames(ROOT).includes('hard-drive'), 'the menu bar icon');
});

test('the Mac app draws no SF Symbols of its own any more', () => {
  const dir = 'apple/OnyxMac';
  const walk = (d) => readdirSync(join(ROOT, d)).flatMap((e) => {
    const p = `${d}/${e}`;
    return statSync(join(ROOT, p)).isDirectory() ? walk(p) : e.endsWith('.swift') && e !== 'Lucide.swift' ? [p] : [];
  });
  for (const file of walk(dir)) {
    assert.ok(!/systemName:|systemImage:/.test(read(file)), `${file} uses an SF Symbol — use Image(lucide:)`);
  }
});

test('the kit parses into shapes React can draw', () => {
  const icons = parseSprite(read('vendor/lucide/sprite.svg'));
  assert.ok(Object.keys(icons).length > 400);
  assert.deepEqual(icons.search, [['path', { d: 'm21 21-4.34-4.34' }], ['circle', { cx: '11', cy: '11', r: '8' }]]);
  for (const [name, shapes] of Object.entries(icons)) {
    assert.ok(shapes.length > 0, `${name} has no shapes`);
    for (const [tag, attrs] of shapes) {
      assert.match(tag, /^(path|circle|rect|line|polyline|polygon|ellipse)$/, `${name}: <${tag}>`);
      // camelCase-free attribute names pass straight through to React.
      for (const k of Object.keys(attrs)) assert.match(k, /^[a-z0-9]+$/i, `${name}: ${k}`);
    }
  }
});

test('an unknown icon name fails generation with a pointer to the renames', () => {
  assert.throws(() => render({ search: [] }, ['search', 'filter']), /filter.*icons\.json/);
});

test('icons come from the kit, not hand-drawn SVG or text glyphs', () => {
  // The one SVG a component may draw itself is artwork: the wordmark, and the
  // review tool's drawing layer.
  const allowed = new Set(['app/components/OnyxWordmark.js', 'app/components/review/AnnotationLayer.js']);
  // A lone glyph standing in for an icon; a key hint like "← → step" is text.
  const glyphs = /aria-hidden(?:="true")?>\s*[✕✓✗▾▸▴▶❚⋯‹←→↑↓↕]\s*</u;
  const glyphStrings = /['"](?:✕|✓|✗|▾|▸|▴|⋯|❚❚|🔇|🔊|⛶)['"]/u;
  const walk = (dir) => readdirSync(join(ROOT, dir)).flatMap((e) => {
    const p = `${dir}/${e}`;
    return statSync(join(ROOT, p)).isDirectory() ? walk(p) : /\.jsx?$/.test(e) ? [p] : [];
  });
  for (const file of walk('app')) {
    if (allowed.has(file) || file.endsWith('icon-data.js') || file.endsWith('ui/Icon.js')) continue;
    const text = read(file);
    assert.ok(!/<svg[\s>]/.test(text), `${file} draws its own SVG — use <Icon>`);
    assert.ok(!glyphs.test(text) && !glyphStrings.test(text), `${file} uses a text glyph as an icon — use <Icon>`);
  }
});
