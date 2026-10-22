// Tests of the Claude Code seam with fake `claude` scripts in a temporary folder (selected with CLAUDE_BIN or
// PATH). The real claude is never run, and no sign-in or sign-out ever touches a real login.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import type { AppState, ClaudeStatus } from '../../shared/types';
import type { HostHandle } from '../host';
import { HttpRouter } from '../router';
import {
  cancelLogin,
  claudeStatus,
  findClaude,
  loginTiming,
  looksSignedOut,
  MIN_CLAUDE_VERSION,
  parseAuthStatus,
  registerClaudeRoutes,
  scrapeLoginUrl,
  startLogin,
  systemLocations,
} from './setup';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'affice-claude-')));
after(() => rmSync(root, { recursive: true, force: true }));

// The account details a real `auth status` carries: none of them may ever reach ClaudeStatus.
const ACCOUNT = { email: 'someone@example.com', orgId: 'org-9f3', orgName: 'Example Org', subscriptionType: 'max' };
const signedInJson = (authMethod: string) => JSON.stringify({ loggedIn: true, authMethod, apiProvider: 'firstParty', analyticsDisabled: false, ...ACCOUNT });
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', analyticsDisabled: false });
const LOGIN_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=fake-client&state=abc123';

interface Fake {
  dir: string;
  bin: string;
  /** What the fake was asked to run, one line per call of auth status or auth login. */
  calls(): string[];
  /** The environment variables that must not reach it, if it saw any. */
  leaked(): string | null;
  pid(): number | null;
}

let n = 0;

/** A fake `claude` in its own folder. `status` is what `auth status` prints; `code` its exit code; `login` the shell body of `auth login`. */
function fake(options: { version?: string; status?: string; code?: number; login?: string; statusBody?: string } = {}): Fake {
  const dir = join(root, `fake${(n += 1)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.json'), options.status ?? SIGNED_OUT);
  writeFileSync(join(dir, 'status.code'), String(options.code ?? 1));
  writeFileSync(join(dir, 'signedin.json'), signedInJson('claude.ai'));
  const script = `#!/bin/sh
DIR="${dir}"
if [ "$1" = "--version" ]; then echo "${options.version ?? '2.1.287'} (Claude Code)"; exit 0; fi
if [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo "$ANTHROPIC_API_KEY$CLAUDE_CODE_OAUTH_TOKEN" >> "$DIR/leaked"; fi
if [ "$1 $2" = "auth status" ]; then
  echo "$@" >> "$DIR/calls"
  ${options.statusBody ?? 'cat "$DIR/status.json"; exit "$(cat "$DIR/status.code")"'}
fi
if [ "$1 $2" = "auth login" ]; then
  echo "$@" >> "$DIR/calls"
  echo $$ > "$DIR/pid"
  ${options.login ?? 'exit 1'}
fi
echo "unexpected: $@" >> "$DIR/calls"
exit 2
`;
  const bin = join(dir, 'claude');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  return {
    dir,
    bin,
    calls: () => read('calls').split('\n').filter(Boolean),
    leaked: () => (existsSync(join(dir, 'leaked')) ? read('leaked') : null),
    pid: () => (read('pid').trim() ? Number(read('pid').trim()) : null),
  };
}

/** The sign-in of a real CLI: the page link on a line of its output, then the browser finishes it. */
const loginPrinting = `echo "Opening browser to sign in..."; echo "If the browser does not open, visit: ${LOGIN_URL}"`;
/** Flips the status to signed in (the way a finished sign-in does). */
const flip = 'cp "$DIR/signedin.json" "$DIR/status.json"; echo 0 > "$DIR/status.code"';

const savedEnv = { CLAUDE_BIN: process.env.CLAUDE_BIN, PATH: process.env.PATH, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
const savedTiming = { ...loginTiming };
const SYSTEM_PATH = '/usr/bin:/bin';

/** Selects the fake as `claude` by CLAUDE_BIN. */
function use(f: Fake): void {
  process.env.CLAUDE_BIN = f.bin;
}

before(() => {
  Object.assign(loginTiming, { pollMs: 150, exitWaitMs: 300, urlWaitMs: 2_000, killGraceMs: 500, authTimeoutMs: 2_000, timeoutMs: 60_000 });
});

afterEach(async () => {
  // A test that left a sign-in running must not leak it into the next one. With nothing running, cancelLogin
  // is a status check: aim it at a path that does not exist, so no test ever runs the real claude.
  process.env.CLAUDE_BIN = join(root, 'no-such-claude');
  await cancelLogin();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  Object.assign(loginTiming, savedTiming, { pollMs: 150, exitWaitMs: 300, urlWaitMs: 2_000, killGraceMs: 500, authTimeoutMs: 2_000, timeoutMs: 60_000 });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (done: () => boolean, ms = 5_000): Promise<void> => {
  const start = Date.now();
  while (!done() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
  assert.ok(done(), 'timed out waiting');
};

// ------------------------------------------------------------------------------------------ pure parts

test('auth status output: only a Claude subscription is signed in, every other state is not, nothing else read', () => {
  for (const method of ['claude.ai', 'oauth_token']) {
    assert.deepEqual(parseAuthStatus(signedInJson(method)), { state: 'in', method });
  }
  // Signed in another way: not usable, and the method is named for the sentence.
  for (const method of ['third_party', 'api_key', 'api_key_helper']) {
    assert.deepEqual(parseAuthStatus(signedInJson(method)), { state: 'out', other: method });
  }
  assert.deepEqual(parseAuthStatus(SIGNED_OUT), { state: 'out' });
  assert.deepEqual(parseAuthStatus('{"loggedIn":true,"authMethod":"none"}'), { state: 'out' });
  assert.deepEqual(parseAuthStatus('{"loggedIn":false}'), { state: 'out' });
  // An unknown method is not a subscription; a strange or missing one is unreadable.
  assert.deepEqual(parseAuthStatus('{"loggedIn":true,"authMethod":"future_method"}'), { state: 'out', other: 'future_method' });
  assert.deepEqual(parseAuthStatus('{"loggedIn":true,"authMethod":"<script>"}'), { state: 'out', other: null });
  assert.deepEqual(parseAuthStatus('{"loggedIn":true}'), { state: 'out', other: null });
  // Text forms: `auth status --text` and the `-p` messages.
  assert.deepEqual(parseAuthStatus('Not logged in. Run claude auth login to authenticate.'), { state: 'out' });
  assert.deepEqual(parseAuthStatus('Not logged in · Please run /login'), { state: 'out' });
  assert.deepEqual(parseAuthStatus('', 'Login expired · Please run /login'), { state: 'out' });
  assert.equal(parseAuthStatus('boom').state, 'unknown');
  assert.equal(parseAuthStatus('').state, 'unknown');
  assert.equal(parseAuthStatus('[1,2]').state, 'unknown');
  assert.ok(looksSignedOut('Login expired · Please run /login'));
  assert.ok(!looksSignedOut('hello'));
  // The parsed value never carries account details.
  assert.ok(!JSON.stringify(parseAuthStatus(signedInJson('claude.ai'))).includes('example.com'));
});

test('the sign-in link is the first https link of the output, cleaned', () => {
  assert.equal(scrapeLoginUrl(`If the browser does not open, visit: ${LOGIN_URL}\n`), LOGIN_URL);
  assert.equal(scrapeLoginUrl(`\u001b[1mVisit\u001b[0m \u001b[4m${LOGIN_URL}\u001b[0m.\n`), LOGIN_URL);
  assert.equal(scrapeLoginUrl(`See (${LOGIN_URL}), then wait`), LOGIN_URL);
  assert.equal(scrapeLoginUrl('Open http://localhost:3000/callback or https://claude.ai/a?b=1\n'), 'https://claude.ai/a?b=1');
  assert.equal(scrapeLoginUrl('no link here'), null);
  assert.equal(scrapeLoginUrl('only http://example.com/x'), null);
  assert.equal(scrapeLoginUrl('javascript:alert(1)'), null);
  // A link that ends the text so far may be cut: not yet, unless that is all there will be.
  assert.equal(scrapeLoginUrl('visit: https://claude.ai/oauth/auth', false), null);
  assert.equal(scrapeLoginUrl('visit: https://claude.ai/oauth/auth', true), 'https://claude.ai/oauth/auth');
  assert.equal(scrapeLoginUrl('visit: https://claude.ai/oauth/auth\n', false), 'https://claude.ai/oauth/auth');
});

test('the places searched after PATH', () => {
  assert.deepEqual(systemLocations('darwin', '/home/u'), ['/home/u/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/home/u/.claude/local/claude']);
  assert.deepEqual(systemLocations('linux', '/home/u'), systemLocations('darwin', '/home/u'));
  assert.equal(systemLocations('win32', 'C:\\Users\\u').length, 1);
  assert.equal(MIN_CLAUDE_VERSION, '2.1.211');
});

// ------------------------------------------------------------------------------------------ finding

test('CLAUDE_BIN wins, and a wrong one is an error, not a silent fallback', async () => {
  const good = fake();
  use(good);
  assert.deepEqual(await findClaude({ locations: [] }), { path: good.bin, version: '2.1.287' });
  process.env.CLAUDE_BIN = join(root, 'does-not-exist');
  assert.equal(await findClaude({ locations: [good.bin] }), null);
  const status = await claudeStatus({ locations: [good.bin] });
  assert.equal(status.installed, false);
  assert.match(status.error ?? '', /CLAUDE_BIN is set to .*does-not-exist/);
});

test('found on PATH, then in the fixed places, in that order', async () => {
  const onPath = fake({ version: '2.1.300' });
  const fixed = fake({ version: '2.1.250' });
  delete process.env.CLAUDE_BIN;
  process.env.PATH = `${onPath.dir}:${SYSTEM_PATH}`;
  assert.deepEqual(await findClaude({ locations: [fixed.bin] }), { path: onPath.bin, version: '2.1.300' });
  const empty = join(root, 'empty');
  mkdirSync(empty, { recursive: true });
  process.env.PATH = `${empty}:${SYSTEM_PATH}`;
  assert.deepEqual(await findClaude({ locations: [join(root, 'missing'), fixed.bin] }), { path: fixed.bin, version: '2.1.250' });
  // A file that is there but does not answer --version is skipped.
  const broken = join(root, 'broken-claude');
  writeFileSync(broken, '#!/bin/sh\nexit 3\n');
  chmodSync(broken, 0o755);
  assert.deepEqual(await findClaude({ locations: [broken, fixed.bin] }), { path: fixed.bin, version: '2.1.250' });
});

// ------------------------------------------------------------------------------------------ the status

test('not installed: nothing found, no error sentence (the screen explains)', async () => {
  delete process.env.CLAUDE_BIN;
  const empty = join(root, 'empty');
  mkdirSync(empty, { recursive: true });
  process.env.PATH = `${empty}:${SYSTEM_PATH}`;
  const status = await claudeStatus({ locations: [] });
  assert.equal(status.installed, false);
  assert.equal(status.path, null);
  assert.equal(status.version, null);
  assert.equal(status.signedIn, false);
  assert.equal(status.tooOld, false);
  assert.equal(status.minVersion, MIN_CLAUDE_VERSION);
  assert.equal(status.error, null);
});

test('too old: the version is known, tooOld is set, and the sign-in state is still read', async () => {
  const f = fake({ version: '2.1.100' });
  use(f);
  const status = await claudeStatus();
  assert.equal(status.installed, true);
  assert.equal(status.version, '2.1.100');
  assert.equal(status.tooOld, true);
  assert.equal(status.signedIn, false);
  const newer = fake({ version: '2.1.211', status: signedInJson('claude.ai'), code: 0 });
  use(newer);
  assert.equal((await claudeStatus()).tooOld, false);
  assert.equal((await claudeStatus()).signedIn, true);
});

test('too old and unable to report a sign-in: the error says to update', async () => {
  const f = fake({ version: '2.1.100', statusBody: 'echo "error: unknown command" >&2; exit 1' });
  use(f);
  const status = await claudeStatus();
  assert.equal(status.signedIn, false);
  assert.match(status.error ?? '', /older than 2\.1\.211: update it/);
});

test('signed out: auth status exits 1 with loggedIn false', async () => {
  const f = fake();
  use(f);
  const status = await claudeStatus();
  assert.deepEqual(
    { installed: status.installed, signedIn: status.signedIn, authMethod: status.authMethod, signingIn: status.signingIn, loginUrl: status.loginUrl, error: status.error },
    { installed: true, signedIn: false, authMethod: null, signingIn: false, loginUrl: null, error: null },
  );
  assert.equal(status.path, f.bin);
  assert.equal(status.version, '2.1.287');
  assert.deepEqual(f.calls(), ['auth status']);
});

test('signed out as text only (a -p style message)', async () => {
  const f = fake({ statusBody: 'echo "Not logged in · Please run /login"; exit 1' });
  use(f);
  const status = await claudeStatus();
  assert.equal(status.signedIn, false);
  assert.equal(status.error, null);
});

test('signed in with each subscription method, and never with account details', async () => {
  for (const method of ['claude.ai', 'oauth_token']) {
    const f = fake({ status: signedInJson(method), code: 0 });
    use(f);
    const status = await claudeStatus();
    assert.equal(status.signedIn, true, method);
    assert.equal(status.authMethod, method);
    assert.equal(status.error, null);
    const text = JSON.stringify(status);
    for (const secret of Object.values(ACCOUNT)) assert.ok(!text.includes(secret), `${secret} leaked into the status`);
    assert.deepEqual(Object.keys(status).sort(), ['authMethod', 'error', 'installed', 'loginUrl', 'minVersion', 'path', 'signedIn', 'signingIn', 'tooOld', 'version']);
  }
});

test('signed in another way (an API key, a key helper, a third party provider) is signed out, with a sentence that asks for the subscription', async () => {
  for (const method of ['api_key', 'api_key_helper', 'third_party']) {
    const f = fake({ status: signedInJson(method), code: 0 });
    use(f);
    const status = await claudeStatus();
    assert.equal(status.signedIn, false, method);
    assert.equal(status.authMethod, null, method);
    assert.equal(status.error, `Claude Code is signed in another way (${method}), but Affice needs a Claude subscription. Sign in with your Claude account.`);
    const text = JSON.stringify(status);
    for (const secret of Object.values(ACCOUNT)) assert.ok(!text.includes(secret), `${secret} leaked into the status`);
  }
});

test('no API key mode: ANTHROPIC and CLAUDE credentials in Affice environment are never passed to claude, and the status is the subscription sign-in', async () => {
  // A claude that would report an API key if it saw one, and the subscription sign-in when it sees none.
  const f = fake({ statusBody: `if [ -n "$ANTHROPIC_API_KEY" ]; then echo '${signedInJson('api_key')}'; else echo '${signedInJson('claude.ai')}'; fi; exit 0` });
  use(f);
  process.env.ANTHROPIC_API_KEY = 'test-key-0123456789';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'token-test-abcdef';
  const status = await claudeStatus();
  assert.equal(f.leaked(), null, 'the managers environment (no credentials) is what claude sees');
  assert.equal(status.signedIn, true);
  assert.equal(status.authMethod, 'claude.ai', 'the status is computed where the sessions run: the sign-in, not the key');
  assert.equal(status.error, null, 'no note about a key');
  assert.ok(!JSON.stringify(status).includes('0123456789'));
});

test('auth status that hangs is stopped after the timeout and reported, not waited for', async () => {
  const f = fake({ statusBody: 'exec sleep 30' });
  use(f);
  loginTiming.authTimeoutMs = 300;
  const start = Date.now();
  const status = await claudeStatus();
  assert.ok(Date.now() - start < 3_000);
  assert.equal(status.installed, true);
  assert.equal(status.signedIn, false);
  assert.match(status.error ?? '', /did not answer claude auth status within/);
});

// ------------------------------------------------------------------------------------------ sign-in

test('a sign-in that prints a link, then the status flips: link first, then signed in, child gone', async () => {
  const f = fake({ login: `${loginPrinting}; sleep 0.6; ${flip}; exec sleep 30` });
  use(f);
  const seen: ClaudeStatus[] = [];
  const first = await startLogin((status) => seen.push(status));
  // Answered once the link was known.
  assert.equal(first.signingIn, true);
  assert.equal(first.loginUrl, LOGIN_URL);
  assert.equal(first.signedIn, false);
  assert.equal(first.installed, true);
  // A status check during the sign-in keeps showing it (the screen must not lose the link).
  const during = await claudeStatus();
  assert.equal(during.signingIn, true);
  assert.equal(during.loginUrl, LOGIN_URL);
  // Only one at a time: a second start joins the first.
  const second = await startLogin(() => assert.fail('a second sign-in must not start'));
  assert.equal(second.loginUrl, LOGIN_URL);
  assert.equal(f.calls().filter((line) => line === 'auth login').length, 1);

  await until(() => seen.some((status) => status.signedIn));
  const done = seen[seen.length - 1];
  assert.equal(done.signedIn, true);
  assert.equal(done.signingIn, false);
  assert.equal(done.loginUrl, null);
  assert.equal(done.authMethod, 'claude.ai');
  assert.equal(done.error, null);
  assert.ok(seen.some((status) => status.signingIn && status.loginUrl === LOGIN_URL), 'the link was announced while signing in');
  // The CLI that did not exit by itself is stopped.
  const pid = f.pid();
  assert.ok(pid);
  await until(() => !alive(pid));
  // Nothing signs out or asks for a token, ever.
  assert.ok(f.calls().every((line) => line === 'auth login' || line === 'auth status'), f.calls().join(' | '));
  assert.equal((await claudeStatus()).signingIn, false);
});

test('a sign-in whose CLI exits after finishing is also seen as done', async () => {
  const f = fake({ login: `${loginPrinting}; sleep 0.3; ${flip}; exit 0` });
  use(f);
  const seen: ClaudeStatus[] = [];
  await startLogin((status) => seen.push(status));
  await until(() => seen.some((status) => status.signedIn));
  assert.equal(seen[seen.length - 1].error, null);
});

test('a sign-in that is cancelled: the CLI is killed and the status is signed out, without an error', async () => {
  const f = fake({ login: `${loginPrinting}; exec sleep 30` });
  use(f);
  const seen: ClaudeStatus[] = [];
  const first = await startLogin((status) => seen.push(status));
  assert.equal(first.loginUrl, LOGIN_URL);
  const pid = f.pid();
  assert.ok(pid && alive(pid));
  const after = await cancelLogin();
  assert.equal(after.signingIn, false);
  assert.equal(after.loginUrl, null);
  assert.equal(after.signedIn, false);
  assert.equal(after.error, null);
  await until(() => !alive(pid));
  assert.deepEqual(seen[seen.length - 1], after);
  // Cancelling when nothing runs is just a status check.
  assert.equal((await cancelLogin()).signingIn, false);
});

test('a sign-in that fails: an error sentence with the last line of output, signingIn off', async () => {
  const f = fake({ login: 'echo "Failed to start OAuth callback server" >&2; exit 1' });
  use(f);
  const seen: ClaudeStatus[] = [];
  const first = await startLogin((status) => seen.push(status));
  assert.equal(first.loginUrl, null);
  await until(() => seen.some((status) => !status.signingIn));
  const done = seen[seen.length - 1];
  assert.equal(done.signingIn, false);
  assert.equal(done.signedIn, false);
  assert.match(done.error ?? '', /stopped before it finished: Failed to start OAuth callback server/);
  assert.match(done.error ?? '', /claude auth login/);
  // The status after it carries no leftover sign-in.
  assert.equal((await claudeStatus()).signingIn, false);
});

test('a sign-in that is not finished in time is stopped', async () => {
  const f = fake({ login: `${loginPrinting}; exec sleep 30` });
  use(f);
  loginTiming.timeoutMs = 500;
  const seen: ClaudeStatus[] = [];
  await startLogin((status) => seen.push(status));
  await until(() => seen.some((status) => !status.signingIn));
  assert.match(seen[seen.length - 1].error ?? '', /not finished in time/);
  const pid = f.pid();
  assert.ok(pid);
  await until(() => !alive(pid));
});

test('a link that arrives in pieces is read whole', async () => {
  const f = fake({ login: `printf "visit: https://claude.ai/oauth/auth"; sleep 0.2; printf "orize?state=xyz\\n"; exec sleep 30` });
  use(f);
  const first = await startLogin(() => undefined);
  assert.equal(first.loginUrl, 'https://claude.ai/oauth/authorize?state=xyz');
});

test('no sign-in is started when Claude Code is missing or already signed in', async () => {
  process.env.CLAUDE_BIN = join(root, 'does-not-exist');
  const missing = await startLogin(() => assert.fail('nothing to call'));
  assert.equal(missing.installed, false);
  assert.ok(missing.error);
  const f = fake({ status: signedInJson('claude.ai'), code: 0, login: 'exit 1' });
  use(f);
  const status = await startLogin(() => assert.fail('already signed in'));
  assert.equal(status.signedIn, true);
  assert.ok(!f.calls().includes('auth login'));
});

// ------------------------------------------------------------------------------------------ the route

test('GET /api/claude answers the status the host holds, or a fresh check with ?refresh=1', async () => {
  const held: ClaudeStatus = { installed: true, path: '/x/claude', version: '2.1.287', minVersion: '2.1.211', tooOld: false, signedIn: true, authMethod: 'claude.ai', signingIn: false, loginUrl: null, error: null };
  const fresh: ClaudeStatus = { ...held, authMethod: 'oauth_token' };
  let refreshed = 0;
  const host = {
    appState: () => ({ claude: held, project: null, recent: [] }) satisfies AppState,
    refreshClaude: async () => {
      refreshed += 1;
      return fresh;
    },
  } as unknown as HostHandle;
  const router = new HttpRouter();
  registerClaudeRoutes(router, host);
  const server: Server = createServer((req, res) => {
    void router.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.deepEqual(await (await fetch(`${base}/api/claude`)).json(), held);
    assert.equal(refreshed, 0);
    assert.deepEqual(await (await fetch(`${base}/api/claude?refresh=1`)).json(), fresh);
    assert.equal(refreshed, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
