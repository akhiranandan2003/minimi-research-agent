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

const userContext = { userId: 'user-123', supabase: {} };

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

  const result = await runAgent({ ...userContext, conversationId: 'conversation-1', message: 'What did I tell you earlier about my target?' });

  assert.equal(historyArgs[0], 'conversation-1');
  assert.equal(historyArgs[1], 40);
  assert.equal(historyArgs[2], 'What did I tell you earlier about my target?');
  assert.deepEqual(historyArgs[3], userContext);
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
  assert.equal(saved[0].userId, userContext.userId);
  assert.equal(saved[0].supabase, userContext.supabase);
  assert.equal(saved[1].metadata.historical, true);
  assert.equal(saved[1].metadata.temporal, false);
});

test('temporal orchestration forces two distinct dated searches and preserves citations', async () => {
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
    ...userContext,
    conversationId: 'conversation-2',
    message: 'Compare CPI inflation in 2020 with the latest available figure.',
  });

  assert.deepEqual(searched, [
    'official inflation metric 2020',
    'latest official inflation metric 2026',
  ]);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].tool_choice, 'required');
  assert.match(requests[0].instructions, /at least two distinct successful web_search queries/);
  assert.equal(requests[1].tool_choice, 'required');
  assert.match(requests[1].input[1].content, /Search one missing period now/);
  assert.match(requests[1].input[1].content, /Do not repeat these attempted queries/);
  assert.equal(requests[2].tool_choice, 'auto');
  assert.equal(requests[1].previous_response_id, 'turn-1');
  assert.equal(requests[2].previous_response_id, 'turn-2');
  assert.match(requests[1].input[0].output, /Official 2020 CPI release/);
  assert.match(requests[1].input[0].output, /"citation":1/);
  assert.match(requests[2].input[0].output, /Latest CPI release/);
  assert.match(requests[2].input[0].output, /"citation":2/);
  assert.equal(requests.every((request) => request.tools.length === 1 && request.tools[0].name === 'web_search'), true);
  assert.deepEqual(result.sources.map((source) => source.citation), [1, 2]);
  assert.ok(result.answer.includes('2020 [1] and the latest period [2]'));
  assert.equal(saved[1].metadata.temporal, true);
  assert.equal(saved[1].metadata.historical, false);
});

test('then-and-now orchestration credits a recent 2025 source to latest, not baseline', async () => {
  const { client, requests } = mockClient([
    { id: 'baseline-turn', output: [functionCall('baseline-search', 'historical CPI 2020 baseline')] },
    { id: 'latest-turn', output: [functionCall('latest-search', 'latest CPI 2025')] },
    { id: 'complete-answer', output: [], output_text: 'The historical baseline and latest observation are sourced separately [1] [2].' },
  ]);
  const searched = [];
  const runAgent = createAgentRunner({
    getClient: () => client,
    search: async (raw) => {
      const { query } = JSON.parse(raw);
      searched.push(query);
      if (query.includes('historical')) {
        return [{
          title: 'Historical CPI observations for 2020',
          url: 'https://stats.example/cpi-2020',
          publishedDate: '2021-01-12',
          content: 'Annual CPI observations for 2020.',
        }];
      }
      return [{
        title: 'Latest CPI release for 2025',
        url: 'https://stats.example/cpi-2025-latest',
        publishedDate: '2026-10-15',
        content: 'Latest annual CPI observations for 2025.',
      }];
    },
    getHistory: async () => [],
    saveMessage: async () => {},
    model: 'test-model',
  });

  const result = await runAgent({
    ...userContext,
    conversationId: 'conversation-relative-periods',
    message: 'Compare CPI then and now.',
  });

  assert.deepEqual(searched, ['historical CPI 2020 baseline', 'latest CPI 2025']);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].tool_choice, 'required');
  assert.equal(requests[2].tool_choice, 'auto');
  assert.match(requests[2].input[0].output, /Latest CPI release for 2025/);
  assert.deepEqual(result.sources.map((source) => source.citation), [1, 2]);
  assert.match(result.answer, /baseline and latest observation are sourced separately/);
});

test('two distinct successful queries for the same baseline do not satisfy latest-period coverage', async () => {
  const { client, requests } = mockClient([
    { id: 'baseline-search-1', output: [functionCall('baseline-1', 'official CPI inflation 2020 historical data')] },
    { id: 'baseline-search-2', output: [functionCall('baseline-2', '2020 government CPI annual baseline report')] },
    { id: 'still-incomplete', output: [], output_text: 'I found two sources about 2020.' },
    { id: 'guarded-final', output: [], output_text: 'Both successful searches cover 2020. I could not verify the latest period, so I cannot calculate a change.' },
  ]);
  const runAgent = createAgentRunner({
    getClient: () => client,
    search: async (raw) => {
      const { query } = JSON.parse(raw);
      return [{
        title: 'Historical CPI source',
        url: query.includes('government') ? 'https://stats.example/2020-government' : 'https://stats.example/2020-official',
        publishedDate: '2021-01-12',
        content: 'Historical CPI observations for 2020.',
      }];
    },
    getHistory: async () => [],
    saveMessage: async () => {},
    model: 'test-model',
  });

  const result = await runAgent({
    ...userContext,
    conversationId: 'conversation-same-period',
    message: 'Compare CPI inflation in 2020 with the latest available figure.',
  });

  assert.equal(requests.length, 4);
  assert.equal(requests[2].tool_choice, 'required');
  assert.match(requests[2].input[1].content, /Source text has not yet substantiated required period\(s\): latest\/current period/);
  assert.equal(requests[3].tool_choice, 'none');
  assert.match(requests[3].input[0].content, /Source text mentions these requested periods: 2020/);
  assert.match(requests[3].input[0].content, /Missing source-text period mentions: latest\/current period/);
  assert.match(result.answer, /could not verify the latest period/);
  assert.equal(result.sources.length, 2);
});

test('a year in the search query does not count when returned source text omits that observation year', async () => {
  const { client, requests } = mockClient([
    { id: 'query-2020-a', output: [functionCall('query-a', 'official CPI inflation 2020 annual data')] },
    { id: 'query-2020-b', output: [functionCall('query-b', 'government CPI 2020 annual statistics')] },
    { id: 'query-2020-c', output: [functionCall('query-c', 'CPI inflation observations 2020 report')] },
    { id: 'still-incomplete', output: [], output_text: 'The searches returned pages, but the observation period is unclear.' },
    { id: 'guarded-final', output: [], output_text: 'The sources do not disclose the 2020 observation period, so I cannot verify the comparison.' },
  ]);
  let searchIndex = 0;
  const runAgent = createAgentRunner({
    getClient: () => client,
    search: async () => [{
      title: 'Annual CPI release',
      url: `https://stats.example/undated-${++searchIndex}`,
      publishedDate: '2021-01-12',
      content: 'Annual CPI release. The page publication date is 2021-01-12; no data observation year is stated.',
    }],
    getHistory: async () => [],
    saveMessage: async () => {},
    model: 'test-model',
  });

  const result = await runAgent({
    ...userContext,
    conversationId: 'conversation-undated-evidence',
    message: 'Compare CPI inflation in 2020 with the latest available figure.',
  });

  assert.equal(searchIndex, 3);
  assert.equal(requests.length, 5);
  assert.equal(requests[3].tool_choice, 'auto');
  assert.equal(requests[4].tool_choice, 'none');
  assert.match(requests[4].input[0].content, /Missing source-text period mentions: 2020, latest\/current period/);
  assert.match(requests[4].instructions, /A source publication date is not its data observation date/i);
  assert.match(result.answer, /do not disclose the 2020 observation period/i);
  assert.equal(result.sources.length, 3);
});

test('temporal answer explicitly reports incomplete evidence when only one distinct search succeeds', async () => {
  const { client, requests } = mockClient([
    { id: 'one-search', output: [functionCall('baseline', 'official CPI inflation 2020')] },
    { id: 'premature-answer', output: [], output_text: 'Inflation increased by 4%.' },
    { id: 'guarded-final', output: [], output_text: 'I found one dated source set, so I cannot verify a like-for-like change yet.' },
  ]);
  const originalError = console.error;
  console.error = () => {};

  try {
    const runAgent = createAgentRunner({
      getClient: () => client,
      search: async () => [{
        title: '2020 CPI release',
        url: 'https://stats.example/2020',
        publishedDate: '2021-01-12',
        content: 'Historical CPI observation',
      }],
      getHistory: async () => [],
      saveMessage: async () => {},
      model: 'test-model',
    });

    const result = await runAgent({
      ...userContext,
      conversationId: 'conversation-incomplete',
      message: 'Compare CPI inflation in 2020 with the latest available figure.',
    });

    assert.equal(requests.length, 3);
    assert.equal(requests[1].tool_choice, 'required');
    assert.equal(requests[2].tool_choice, 'none');
    assert.match(requests[2].input[0].content, /Exactly 1 distinct web-search queries returned usable sources/);
    assert.match(requests[2].input[0].content, /Do not present a verified like-for-like comparison/);
    assert.match(result.answer, /cannot verify a like-for-like change/);
    assert.equal(result.sources.length, 1);
  } finally {
    console.error = originalError;
  }
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

    const result = await runAgent({ ...userContext, conversationId: 'conversation-3', message: 'What is the latest status?' });

    assert.match(requests[1].input[0].output, /Web search failed/);
    assert.doesNotMatch(requests[1].input[0].output, /private API token/);
    assert.equal(result.answer, 'I cannot verify this claim [citation unavailable].');
    assert.deepEqual(result.sources, []);
    assert.equal(saved[1].metadata.sources.length, 0);
  } finally {
    console.error = originalError;
  }
});

test('agent runner refuses to access memory without authenticated database context', async () => {
  const { client } = mockClient([]);
  const runAgent = createAgentRunner({
    getClient: () => client,
    search: async () => [],
    getHistory: async () => [],
    saveMessage: async () => {},
    model: 'test-model',
  });
  await assert.rejects(
    runAgent({ conversationId: 'conversation-no-user', message: 'Hello' }),
    /Authenticated user context is required/,
  );
});
