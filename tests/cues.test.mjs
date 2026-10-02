import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCues } from '../lib/cues.mjs';

const source = {
  id: 'demo',
  scenes: [{
    id: 'one', title: 'The path',
    cuePhrases: ['first idea', { phrase: 'the idea', occurrence: 2 }],
    words: [
      { word: 'The', start: 0, end: .2 },
      { word: 'idea,', start: .2, end: .5 },
      { word: 'then', start: .5, end: .8 },
      { word: 'the', start: .8, end: 1 },
      { word: 'first', start: 1, end: 1.2 },
      { word: 'idea.', start: 1.2, end: 1.5 },
      { word: 'the', start: 1.5, end: 1.7 },
      { word: 'idea', start: 1.7, end: 2 }
    ]
  }]
};

test('resolves contiguous phrases to scene-local word times without mutating input', () => {
  const result = resolveCues(source);
  assert.deepEqual(result.scenes[0].cues, [
    { phrase: 'first idea', start: 1, end: 1.5, wordIndex: 4 },
    { phrase: 'the idea', start: 1.5, end: 2, wordIndex: 6 }
  ]);
  assert.equal(source.scenes[0].cues, undefined);
  assert.notEqual(result.scenes[0], source.scenes[0]);
});

test('empty cue phrases clear stale resolved cues', () => {
  const result = resolveCues({ scenes: [{ cuePhrases: [], cues: [{ phrase: 'old', start: 1 }] }] });
  assert.deepEqual(result.scenes[0].cues, []);
});

test('missing, ambiguous, and out-of-range phrase matches fail clearly', () => {
  const withPhrase = cuePhrases => ({ scenes: [{ ...source.scenes[0], cuePhrases }] });
  assert.throws(() => resolveCues(withPhrase(['absent words'])), /not found/);
  assert.throws(() => resolveCues(withPhrase(['the idea'])), /matches 2 times/);
  assert.throws(() => resolveCues(withPhrase([{ phrase: 'the idea', occurrence: 3 }])), /only 2 occurrences/);
  assert.throws(() => resolveCues(withPhrase([{ phrase: 'the idea', occurrence: 0 }])), /positive integer/);
});

test('cue phrases require timed words and valid matched timestamps', () => {
  assert.throws(() => resolveCues({ scenes: [{ title: 'No words', cuePhrases: ['hello'], words: [] }] }), /needs timed words/);
  assert.throws(() => resolveCues({ scenes: [{ title: 'Bad time', cuePhrases: ['hello'], words: [{ word: 'hello', start: 2, end: 1 }] }] }), /invalid timing/);
});
