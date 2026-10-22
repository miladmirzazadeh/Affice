// The licenses the npm package must carry (needs `npm run build`): Trella's own, and the font licenses of
// the board that Trella ships, which scripts/build-server.mjs collects into dist/trella/FONT-LICENSES.txt.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const trella = join(import.meta.dirname, '..', 'dist', 'trella');
const skip = existsSync(join(trella, 'web', 'index.html')) ? false : 'dist/trella is not built (npm run build)';

test('dist/trella carries Trella\'s license and the licenses of the fonts of its board', { skip }, () => {
  assert.match(readFileSync(join(trella, 'LICENSE'), 'utf8'), /^MIT License/);
  const text = readFileSync(join(trella, 'FONT-LICENSES.txt'), 'utf8');
  for (const family of ['Instrument Sans', 'Instrument Serif', 'JetBrains Mono']) {
    assert.match(text, new RegExp(`^${family}$`, 'm'), `${family} has a block`);
  }
  assert.equal(text.match(/SIL OPEN FONT LICENSE Version 1\.1/g)?.length, 3, 'the license text is there once for each package');
  assert.match(text, /Copyright \d{4} The Instrument Sans Project Authors/);
  assert.match(text, /Copyright \d{4} The Instrument Serif Project Authors/);
  assert.match(text, /Copyright \d{4} The JetBrains Mono Project Authors/);
  assert.ok(!/[\u2013\u2014]/.test(text), 'no em or en dash');
});

test('every font file of the board is named in FONT-LICENSES.txt', { skip }, () => {
  const text = readFileSync(join(trella, 'FONT-LICENSES.txt'), 'utf8');
  const fonts = readdirSync(join(trella, 'web', 'assets')).filter((file) => /\.(woff2?|ttf|otf)$/i.test(file));
  assert.ok(fonts.length > 0, 'the board has font files');
  for (const font of fonts) assert.ok(text.includes(font), `${font} is listed`);
});
