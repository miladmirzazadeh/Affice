import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainLine } from './plain-line';

test('bold, italic, code and strike markers go, the words stay', () => {
  assert.equal(plainLine('Done. src/hello.js has **12 lines**, one `console.log`.'), 'Done. src/hello.js has 12 lines, one console.log.');
  assert.equal(plainLine('It is __really__ *fine* and _good_ and ~~wrong~~.'), 'It is really fine and good and wrong.');
  assert.equal(plainLine('Run ``git status`` now'), 'Run git status now');
});

test('headings, list dashes, numbers and quotes at the start of a line go', () => {
  assert.equal(plainLine('# Report\n- first\n- second'), 'Report first second');
  assert.equal(plainLine('## Plan'), 'Plan');
  assert.equal(plainLine('* one'), 'one');
  assert.equal(plainLine('1. one\n2) two'), 'one two');
  assert.equal(plainLine('> quoted'), 'quoted');
});

test('links keep their text, a dash inside a sentence stays, and so do names with underscores', () => {
  assert.equal(plainLine('See [the guide](https://example.com/a) and ![shot](x.png).'), 'See the guide and shot.');
  assert.equal(plainLine('Fixed read_file and the snake_case_name, 3 * 4 = 12, a - b'), 'Fixed read_file and the snake_case_name, 3 * 4 = 12, a - b');
});

test('a marker left open by a cut line is dropped too', () => {
  assert.equal(plainLine('It found **12 lines in the…'), 'It found 12 lines in the…');
  assert.equal(plainLine('Wrote `src/hel…'), 'Wrote src/hel…');
});

test('nothing, blank and plain text are fine', () => {
  assert.equal(plainLine(null), '');
  assert.equal(plainLine(undefined), '');
  assert.equal(plainLine('   '), '');
  assert.equal(plainLine('Waiting for the tests.'), 'Waiting for the tests.');
});
