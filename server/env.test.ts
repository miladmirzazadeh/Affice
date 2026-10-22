import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minimalEnv } from './env';

test('minimalEnv keeps what a helper needs and none of the user\'s credentials', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/someone',
    USER: 'someone',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TMPDIR: '/var/tmp',
    TERM: 'xterm-256color',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
    CLAUDECODE: '1',
    MCP_FOO: 'x',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    AWS_PROFILE: 'work',
    GITHUB_TOKEN: 'ghp_secret',
    GH_TOKEN: 'gh-secret',
    NPM_TOKEN: 'npm-secret',
    NODE_AUTH_TOKEN: 'node-secret',
    OPENAI_API_KEY: 'openai-secret',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    GIT_SSH_COMMAND: 'ssh -i key',
    GIT_CONFIG_GLOBAL: '/elsewhere',
    NODE_OPTIONS: '--require /evil.js',
    LC_SECRET_TOKEN: 'hidden-in-a-locale-name',
    MY_PASSWORD: 'pw',
    TRELLA_PROJECT: '/another/workspace',
    TRELLA_AGENT_ID: 'agent:x',
  };
  const env = minimalEnv({}, base);
  assert.deepEqual(env, {
    PATH: '/usr/bin:/bin',
    HOME: '/home/someone',
    USER: 'someone',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TMPDIR: '/var/tmp',
    TERM: 'xterm-256color',
  });
});

test('minimalEnv puts the extra variables on top, skips undefined ones, and never changes the base', () => {
  const base: NodeJS.ProcessEnv = { PATH: '/bin', LC_ALL: 'de_DE.UTF-8', GITHUB_TOKEN: 'secret' };
  const env = minimalEnv({ NO_COLOR: '1', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', NOT_SET: undefined }, base);
  assert.deepEqual(env, { PATH: '/bin', LC_ALL: 'C', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' });
  assert.deepEqual(base, { PATH: '/bin', LC_ALL: 'de_DE.UTF-8', GITHUB_TOKEN: 'secret' });
});

test('minimalEnv reads the server\'s own environment by default and passes no secret from it', () => {
  const saved = { token: process.env.AFFICE_TEST_SECRET_TOKEN, key: process.env.AFFICE_TEST_API_KEY };
  process.env.AFFICE_TEST_SECRET_TOKEN = 'canary-1';
  process.env.AFFICE_TEST_API_KEY = 'canary-2';
  try {
    const env = minimalEnv();
    assert.equal(env.PATH, process.env.PATH);
    assert.ok(!('AFFICE_TEST_SECRET_TOKEN' in env) && !('AFFICE_TEST_API_KEY' in env));
    for (const name of Object.keys(env)) assert.doesNotMatch(name, /TOKEN|KEY|SECRET|PASSWORD|^AWS_|^ANTHROPIC_|^GITHUB_/);
  } finally {
    if (saved.token === undefined) delete process.env.AFFICE_TEST_SECRET_TOKEN;
    else process.env.AFFICE_TEST_SECRET_TOKEN = saved.token;
    if (saved.key === undefined) delete process.env.AFFICE_TEST_API_KEY;
    else process.env.AFFICE_TEST_API_KEY = saved.key;
  }
});
