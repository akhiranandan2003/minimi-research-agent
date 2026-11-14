import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSearchCallResults } from '../src/agent/logic.js';

test('parallel search calls receive stable global citations in original call order', () => {
  const merged = mergeSearchCallResults([
    {
      sources: [
        { title: 'Alpha', url: 'https://alpha.example/source', citation: 1 },
        { title: 'Shared', url: 'https://shared.example/source', citation: 2 },
      ],
    },
    {
      sources: [
        { title: 'Beta', url: 'https://beta.example/source', citation: 1 },
        { title: 'Shared duplicate', url: 'https://shared.example/source', citation: 2 },
      ],
    },
  ]);

  assert.deepEqual(
    merged.sources.map(({ title, citation }) => ({ title, citation })),
    [
      { title: 'Alpha', citation: 1 },
      { title: 'Shared', citation: 2 },
      { title: 'Beta', citation: 3 },
    ],
  );
  assert.deepEqual(merged.outputs[0].results.map((source) => source.citation), [1, 2]);
  assert.deepEqual(merged.outputs[1].results.map((source) => source.citation), [3, 2]);
});

test('a failed search call produces a bounded error result without discarding other sources', () => {
  const merged = mergeSearchCallResults([
    { error: new Error('private provider details') },
    { sources: [{ title: 'Valid source', url: 'https://valid.example/source' }] },
  ]);

  assert.match(merged.outputs[0].error, /Web search failed/);
  assert.doesNotMatch(merged.outputs[0].error, /private provider details/);
  assert.equal(merged.sources.length, 1);
  assert.equal(merged.outputs[1].results[0].citation, 1);
});


test('citations remain stable when the agent performs a later search round', () => {
  const firstRound = mergeSearchCallResults([
    { sources: [{ title: 'First round', url: 'https://first.example/source' }] },
  ]);
  const secondRound = mergeSearchCallResults([
    { sources: [{ title: 'Second round', url: 'https://second.example/source' }] },
  ], firstRound.sources);

  assert.deepEqual(secondRound.sources.map((source) => source.citation), [1, 2]);
  assert.equal(secondRound.sources[0].title, 'First round');
  assert.equal(secondRound.outputs[0].results[0].citation, 2);
});
