import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openerEnv } from './open-browser';

test('the browser opener gets the minimal environment plus the desktop session, and none of the credentials', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/ada',
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: '/run/user/1000',
    BROWSER: 'firefox',
    ANTHROPIC_API_KEY: 'secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    GITHUB_TOKEN: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    NPM_TOKEN: 'secret',
    SSH_AUTH_SOCK: '/tmp/agent',
    NODE_OPTIONS: '--require /tmp/x.js',
  };
  const env = openerEnv(base);
  for (const name of ['PATH', 'HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'BROWSER']) {
    assert.equal(env[name], base[name], name);
  }
  assert.deepEqual(Object.keys(env).sort(), ['BROWSER', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'HOME', 'PATH', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']);
});

test('a desktop variable that is not set stays out', () => {
  assert.deepEqual(openerEnv({ PATH: '/usr/bin' }), { PATH: '/usr/bin' });
});
