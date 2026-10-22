import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crumbs, shortenPath } from './paths';

test('a path is shortened to ~ for the home folder, and to its last three folders when long', () => {
  assert.equal(shortenPath('/Users/ada/Projects/site'), '~/Projects/site');
  assert.equal(shortenPath('/home/ada'), '~');
  assert.equal(shortenPath('/root/app'), '~/app');
  assert.equal(shortenPath('/Users/ada/Projects/clients/acme/web/app'), '…/acme/web/app');
  assert.equal(shortenPath('/srv/work/site'), '/srv/work/site');
  assert.equal(shortenPath('/a/b/c/d/e/f'), '…/d/e/f');
  assert.equal(shortenPath('/'), '/');
  assert.equal(shortenPath('/Users/adamant'), '~', 'only the whole first folder counts as the home folder');
  assert.equal(shortenPath('/Usersx/ada'), '/Usersx/ada');
});

test('the breadcrumb has the root and every folder down to the path', () => {
  assert.deepEqual(crumbs('/'), [{ label: '/', path: '/' }]);
  assert.deepEqual(crumbs('/Users/ada/site'), [
    { label: '/', path: '/' },
    { label: 'Users', path: '/Users' },
    { label: 'ada', path: '/Users/ada' },
    { label: 'site', path: '/Users/ada/site' },
  ]);
});
