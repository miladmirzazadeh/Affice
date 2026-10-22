// Builds everything the npm package runs, without tsx or Vite at runtime (npm run build:server):
//
//   dist/server.js          the office server (server/index.ts), ESM for node 22, `ws` stays external
//   dist/cli.js             the doctor and init commands (server/cli.ts)
//   dist/approvals-mcp.js   the office MCP server the managers run (server/claude/approvals-mcp.ts)
//   dist/run-script.mjs     `node run-script.mjs <script>`: how the managers' --mcp-config starts it
//   dist/fixtures/          the neutral office.json new offices are seeded from
//   dist/trella/            Trella, bundled: bin/trella.js, dist/index.js (cli, server, core and mcp in one
//                           file), web/ (the built board), its license (LICENSE) and the licenses of the
//                           fonts its board ships (FONT-LICENSES.txt); no workspace packages needed
//
// dist/client (the built page) comes from `vite build`. Run `npm run build:trella` first: the board's web UI
// is copied from vendor/trella/apps/web/dist.
//
// Two source-level facts need a little help once the modules are one file:
//   1. import.meta.url. Modules find files relative to their own place (host.ts: `..`, project/index.ts:
//      `../..`). Every `import.meta.url` of Affice's own sources becomes the place that module would have
//      inside dist/ if it were not bundled (dist/server/host.ts), so each relative path resolves as in
//      development, with dist/ standing in for the repository root.
//   2. The managers' MCP server. server/host.ts passes `<root>/node_modules/tsx/dist/cli.mjs` and
//      `<root>/server/claude/approvals-mcp.ts` (the TypeScript one, run with tsx). In the bundle those two
//      paths become dist/run-script.mjs and dist/approvals-mcp.js. The build fails loudly when host.ts no
//      longer contains those expressions, so the replacement cannot rot silently; once host.ts chooses the
//      paths itself this replacement can go.

import { build } from 'esbuild';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const TRELLA = join(ROOT, 'vendor/trella');

const HOST_REPLACEMENTS = [
  ["join(AFFICE_DIR, 'node_modules/tsx/dist/cli.mjs')", "join(AFFICE_DIR, 'run-script.mjs')"],
  ["join(AFFICE_DIR, 'server/claude/approvals-mcp.ts')", "join(AFFICE_DIR, 'approvals-mcp.js')"],
];

const SOURCE_PLACE_BANNER = [
  "import { fileURLToPath as __afficeFileUrl, pathToFileURL as __afficeToUrl } from 'node:url';",
  "import { dirname as __afficeDirname, join as __afficeJoin } from 'node:path';",
  'const __afficeDist = __afficeDirname(__afficeFileUrl(import.meta.url));',
  'const __afficeAt = (place) => __afficeToUrl(__afficeJoin(__afficeDist, place)).href;',
].join('\n');

/** The sources of Affice (not node_modules): import.meta.url becomes their place inside dist/, and host.ts is adjusted. */
const afficeSources = {
  name: 'affice-sources',
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, (args) => {
      if (!args.path.startsWith(ROOT) || args.path.includes(`${sep}node_modules${sep}`)) return undefined;
      const place = relative(ROOT, args.path).split(sep).join('/');
      let text = readFileSync(args.path, 'utf8');
      if (text.includes('import.meta.url')) text = text.replaceAll('import.meta.url', `__afficeAt(${JSON.stringify(place)})`);
      if (place === 'server/host.ts') {
        for (const [from, to] of HOST_REPLACEMENTS) {
          if (!text.includes(from)) {
            throw new Error(`scripts/build-server.mjs: server/host.ts no longer contains ${from}. Update HOST_REPLACEMENTS (or drop it once host.ts picks the managers' MCP paths itself).`);
          }
          text = text.replace(from, to);
        }
      }
      return { contents: text, loader: 'ts' };
    });
  },
};

const common = {
  absWorkingDir: ROOT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
};

// ESM bundles of CommonJS packages (zod, the MCP SDK) call require() for node builtins.
const REQUIRE_BANNER = "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);";

function size(path) {
  return `${(statSync(path).size / 1024).toFixed(0)} kB`;
}

async function buildAffice() {
  await build({
    ...common,
    entryPoints: { server: 'server/index.ts', cli: 'server/cli.ts', 'approvals-mcp': 'server/claude/approvals-mcp.ts' },
    outdir: 'dist',
    external: ['ws'],
    legalComments: 'none',
    banner: { js: SOURCE_PLACE_BANNER },
    plugins: [afficeSources],
  });
  writeFileSync(
    join(DIST, 'run-script.mjs'),
    [
      '// Runs a plain script the way a manager\'s --mcp-config starts it: node run-script.mjs <script>.',
      "import { resolve } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      '',
      'const script = process.argv[2];',
      'if (!script) {',
      "  console.error('usage: node run-script.mjs <script>');",
      '  process.exit(2);',
      '}',
      'await import(pathToFileURL(resolve(script)).href);',
      '',
    ].join('\n'),
  );
  mkdirSync(join(DIST, 'fixtures'), { recursive: true });
  copyFileSync(join(ROOT, 'fixtures/office.json'), join(DIST, 'fixtures/office.json'));
}

// The typefaces of Trella's board, served from Fontsource packages (SIL Open Font License 1.1). The license asks
// that every copy of the fonts carries the copyright notice and the license text, and the packages' own LICENSE
// files are not part of the built board, so they are collected into dist/trella/FONT-LICENSES.txt. `files` are
// the prefixes of the font files each package puts into web/assets (`note`: anything else of the package the board carries).
const FONT_PACKAGES = [
  { family: 'Instrument Sans', name: '@fontsource-variable/instrument-sans', files: ['instrument-sans-'] },
  { family: 'Instrument Serif', name: '@fontsource/instrument-serif', files: ['instrument-serif-'] },
  { family: 'JetBrains Mono', name: '@fontsource-variable/jetbrains-mono', files: ['jetbrains-mono-'], note: 'and one small subset embedded in the stylesheet of the board' },
];

/** The folder of an installed package: next to Trella's web app, in Trella's workspace, or hoisted to the root. */
function installedPackage(name) {
  const places = [join(TRELLA, 'apps/web/node_modules', name), join(TRELLA, 'node_modules', name), join(ROOT, 'node_modules', name)];
  const found = places.find((place) => existsSync(join(place, 'LICENSE')) && existsSync(join(place, 'package.json')));
  if (!found) {
    throw new Error(`scripts/build-server.mjs: the license of ${name} was not found (looked in ${places.join(', ')}). Run npm install, then build again.`);
  }
  return found;
}

/**
 * dist/trella/FONT-LICENSES.txt: for each typeface of Trella's board, which files carry it and the package's
 * own copyright notice and license, copied unchanged. The build fails when a font file of the board has no
 * entry here, or an entry has no file, so the list cannot drift from what the package ships.
 */
function writeFontLicenses(out) {
  const assets = join(out, 'web/assets');
  const fonts = readdirSync(assets).filter((file) => /\.(woff2?|ttf|otf|eot)$/i.test(file));
  const unlisted = fonts.filter((file) => !FONT_PACKAGES.some((font) => font.files.some((prefix) => file.startsWith(prefix))));
  if (unlisted.length) {
    throw new Error(`scripts/build-server.mjs: Trella's board ships font files with no license entry (${unlisted.join(', ')}). Add the package to FONT_PACKAGES.`);
  }
  const blocks = FONT_PACKAGES.map((font) => {
    const own = fonts.filter((file) => font.files.some((prefix) => file.startsWith(prefix)));
    if (!own.length) {
      throw new Error(`scripts/build-server.mjs: no font file of ${font.family} is in Trella's board any more. Remove it from FONT_PACKAGES.`);
    }
    const folder = installedPackage(font.name);
    const version = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).version;
    const license = readFileSync(join(folder, 'LICENSE'), 'utf8').trim();
    return [
      '='.repeat(78),
      `${font.family}`,
      `Package ${font.name} ${version}, license SIL Open Font License 1.1`,
      `Files: ${own.join(', ')}${font.note ? `, ${font.note}` : ''}`,
      '='.repeat(78),
      '',
      license,
    ].join('\n');
  });
  const header = [
    'Font licenses',
    '',
    "The board of Trella (the web/ folder next to this file) uses three typefaces. They come from the Fontsource",
    'packages named below and are licensed under the SIL Open Font License, Version 1.1. The SIL license asks that',
    'every copy of the fonts carries its copyright notice and the license text, so both are reproduced here, one',
    'block per package, copied unchanged from the package.',
    "The license of Trella itself is in the LICENSE file next to this one.",
    '',
    '',
  ].join('\n');
  writeFileSync(join(out, 'FONT-LICENSES.txt'), `${header}${blocks.join('\n\n\n')}\n`);
}

async function buildTrella() {
  const web = join(TRELLA, 'apps/web/dist');
  if (!existsSync(join(web, 'index.html'))) {
    throw new Error("scripts/build-server.mjs: Trella's web UI is not built (vendor/trella/apps/web/dist). Run npm run build:trella first.");
  }
  const out = join(DIST, 'trella');
  await build({
    ...common,
    entryPoints: [join(TRELLA, 'packages/cli/src/index.ts')],
    outfile: join(out, 'dist/index.js'),
    // The workspace packages come from their sources: the bundle needs no tsc output and no node_modules links.
    alias: {
      '@trella/core': './vendor/trella/packages/core/src/index.ts',
      '@trella/server': './vendor/trella/packages/server/src/index.ts',
      '@trella/mcp': './vendor/trella/packages/mcp/src/index.ts',
    },
    legalComments: 'eof',
    banner: { js: REQUIRE_BANNER },
  });
  // The same shape as Trella's own package, which is what its CLI looks for: bin/ and dist/ side by side,
  // the web UI in web/, the version in package.json.
  mkdirSync(join(out, 'bin'), { recursive: true });
  copyFileSync(join(TRELLA, 'packages/cli/bin/trella.js'), join(out, 'bin/trella.js'));
  chmodSync(join(out, 'bin/trella.js'), 0o755);
  cpSync(web, join(out, 'web'), { recursive: true });
  copyFileSync(join(TRELLA, 'LICENSE'), join(out, 'LICENSE'));
  writeFontLicenses(out);
  const version = JSON.parse(readFileSync(join(TRELLA, 'packages/cli/package.json'), 'utf8')).version;
  writeFileSync(join(out, 'package.json'), `${JSON.stringify({ name: 'trella', version, private: true, type: 'module', license: 'MIT' }, null, 2)}\n`);
}

await buildAffice();
await buildTrella();

for (const file of ['server.js', 'cli.js', 'approvals-mcp.js', 'trella/dist/index.js']) {
  console.log(`dist/${file}  ${size(join(DIST, file))}`);
}
console.log('built dist/');
