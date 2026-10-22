import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SERVER_DOWN_ADVICE } from './format';

test('the advice for a server that is not running names npx affice first, and the clone commands second', () => {
  assert.match(SERVER_DOWN_ADVICE, /^Start it with npx affice\. From a clone, use npm start \(or npm run server while developing\)\.$/);
  assert.ok(SERVER_DOWN_ADVICE.indexOf('npx affice') < SERVER_DOWN_ADVICE.indexOf('npm start'));
});
