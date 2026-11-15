import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRunner } from '../src/agent/runner.js';

function functionCall(callId, query) {
  return {
    id: `fc_${callId}`,
    type: 'function_call',
    name: 'web_search',
    call_id: callId,
    arguments: JSON.stringify({ query }),
  };
}

function mockClient(responses) {
  const requests = [];
  return {
    requests,
    client: {
      responses: {
        async create(request) {
          requests.push(request);
          const next = responses.shift();
          if (!next) throw new Error('No mocked model response remains.');
          return next;
        },
      },
    },
  };
}

test('history-only orchestration uses retrieved database messages and never executes search', async () => {
  const storedHistory = [
    { id: 12, role: 'user', content: 'My target is 65 kg.', created_at: '2026-10-01T10:00:00Z' },
    { id: 13, role: 'assistant', content: 'You mentioned a 65 kg target.', created_at: '2026-10-01T10:01:00Z' },
  ];
  const { client, requests } = mockClient([
    { id: 'unexpected-tool-response', output: [functionCall('unexpected', 'search despite tool_choice none')] },
    { id: 'history-final', output: [], output_text: 'You previously said your target was 65 kg.' },
  ]);
  const saved = [];
  let searchCalls = 0;
  let historyArgs;

  const runAgent = createAgentRunner({
    getClient: () => client,
    search: async () => { searchCalls += 1; return []; },
    getHistory: async (...args) => { historyArgs = args; return storedHistory; },
    saveMessage: async (message) => saved.push(message),
    model: 'test-model',
  });

  const result = await runAgent({ conversationId: 'conversation-1', message: 'What did I tell you earlier about my target?' });

  assert.equal(historyArgs[0], 'conversation-1');
  assert.equal(historyArgs[1], 40);
  assert.equal(historyArgs[2], 'What did I tell you earlier about my target?');
  assert.deepEqual(requests[0].input.slice(0, 2), [
    { role: 'user', content: 'My target is 65 kg.' },
    { role: 'assistant', content: 'You mentioned a 65 kg target.' },
  ]);
  assert.equal(requests[0].tool_choice, 'none');
  assert.equal(requests[1].model, 'test-model');
  assert.equal(requests[1].tool_choice, 'none');
  assert.equal(requests.every((request) => request.tools.length === 1 && request.tools[0].name === 'web_search'), true);
  assert.equal(searchCalls, 0);
  assert.equal(result.answer, 'You previously said your target was 65 kg.');
  assert.deepEqual(result.sources, []);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].role, 'user');
  assert.equal(saved[1].metadata.historical, true);
  assert.equal(saved[1].metadata.temporal, false);
});

test('temporal orchestration carries real history through two dated searches and preserves citations', async () => {
  const { client, requests } = mockClient([
    { id: 'turn-1', output: [functionCall('search-2020', 'official inflation metric 2020')] },
    { id: 'turn-2', output: [functionCall('search-latest', 'latest official inflation metric 2026')] },
    { id: 'turn-3', output: [], output_text: 'The dated observations are comparable: 2020 [1] and the latest period [2].' },
  ]);
  const saved = [];
  const searched = [];
  const history = [
    { id: 1, role: 'user', content: 'I was tracking CPI inflation in 2020.', created_at: '2020-12-31T00:00:00Z' },
  ];

  const runAgent = createAgentRunner({
    getClient: () => client,
    search: async (raw) => {
      const { query } = JSON.parse(raw);
      searched.push(query);
      return query.includes('2020')
        ? [{ title: 'Official 2020 CPI release', url: 'https://stats.example/2020', publishedDate: '2021-01-12', content: '2020 annual CPI data' }]
        : [{ title: 'Latest CPI release', url: 'https://stats.example/latest', publishedDate: '2026-11-01', content: 'Latest annual CPI data' }];
    },
    getHistory: async () => history,
    saveMessage: async (message) => saved.push(message),
    model: 'test-model',
  });

  const result = await runAgent({
    conversationId: 'conversation-2',
    message: 'Compare CPI inflation in 2020 with the latest available figure.',
  });

  assert.deepEqual(searched, [
    'official inflation metric 2020',
    'latest official inflation metric 2026',
  ]);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].tool_choice, 'auto');
  assert.match(requests[0].instructions, /same metric, unit, geography, population, and scope/);
  assert.equal(requests[1].previous_response_id, 'turn-1');
  assert.equal(requests[2].previous_response_id, 'turn-2');
  assert.match(requests[1].input[0].output, /Official 2020 CPI release/);
  assert.match(requests[1].input[0].output, /"citation":1/);
  assert.match(requests[2].input[0].output, /Latest CPI release/);
  assert.match(requests[2].input[0].output, /"citation":2/);
  assert.equal(requests.every((request) => request.tools.length === 1 && request.tools[0].name === 'web_search'), true);
  assert.deepEqual(result.sources.map((source) => source.citation), [1, 2]);
  assert.match(result.answer, /2020 \[1\].*latest period \[2\]/);
  assert.equal(saved[1].metadata.temporal, true);
  assert.equal(saved[1].metadata.historical, false);
});

test('search failures are isolated, provider details are hidden, and invalid citations are rejected', async () => {
  const { client, requests } = mockClient([
    { id: 'search-request', output: [functionCall('failed-search', 'unavailable source')] },
    { id: 'final-answer', output: [], output_text: 'I cannot verify this claim [1].' },
  ]);
  const saved = [];
  const originalError = console.error;
  console.error = () => {};

  try {
    const runAgent = createAgentRunner({
      getClient: () => client,
      search: async () => { throw new Error('private API token and provider diagnostics'); },
      getHistory: async () => [],
      saveMessage: async (message) => saved.push(message),
      model: 'test-model',
    });

    const result = await runAgent({ conversationId: 'conversation-3', message: 'What is the latest status?' });

    assert.match(requests[1].input[0].output, /Web search failed/);
    assert.doesNotMatch(requests[1].input[0].output, /private API token/);
    assert.equal(result.answer, 'I cannot verify this claim [citation unavailable].');
    assert.deepEqual(result.sources, []);
    assert.equal(saved[1].metadata.sources.length, 0);
  } finally {
    console.error = originalError;
  }
});
