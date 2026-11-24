import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRunner } from '../src/agent/runner.js';

function functionCall(callId, query) {
  return {
    id: 'fc_' + callId,
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

const userContext = { userId: 'user-123', supabase: {} };

const baselineSource = {
  title: '2020 annual CPI inflation for all urban consumers in the United States',
  url: 'https://stats.example/cpi-2020',
  publishedDate: '2021-01-12',
  content: '2020 annual CPI inflation for all urban consumers in the United States was 2.1% annual average.',
};

const latestSource = {
  title: 'Latest 2025 annual CPI inflation for all urban consumers in the United States',
  url: 'https://stats.example/cpi-latest',
  publishedDate: '2026-10-15',
  content: 'Latest 2025 annual CPI inflation for all urban consumers in the United States was 3.0% annual average.',
};

function webClaim({ citation, value, period, unit = '%', source }) {
  return {
    evidence_type: 'web',
    metric: 'CPI inflation',
    value,
    unit,
    observation_period: period,
    geography: 'United States',
    population: 'all urban consumers',
    scope: 'annual average',
    source_citation: citation,
    evidence_quote: source.content,
  };
}

function createRunner({ responses, latest = latestSource, extractor, saved = [] }) {
  const { client, requests } = mockClient(responses);
  const searched = [];
  const runAgent = createAgentRunner({
    getClient: () => client,
    search: async (raw) => {
      const query = JSON.parse(raw).query;
      searched.push(query);
      return query.includes('2020') ? [baselineSource] : [latest];
    },
    getHistory: async () => [],
    saveMessage: async (message) => saved.push(message),
    model: 'test-model',
    extractTemporalAnswer: extractor,
  });
  return { runAgent, requests, searched, saved };
}

test('temporal runner accepts a structured answer only after both evidence points validate', async () => {
  const structuredEvidence = [
    webClaim({ citation: 1, value: '2.1%', period: '2020 annual', source: baselineSource }),
    webClaim({ citation: 2, value: '3.0%', period: '2025 annual', source: latestSource }),
  ];
  let extractionInput;
  const fixture = createRunner({
    responses: [
      { id: 'baseline-search', output: [functionCall('baseline', 'official CPI inflation 2020 annual')] },
      { id: 'latest-search', output: [functionCall('latest', 'latest CPI inflation 2025 annual')] },
      { id: 'search-complete', output: [], output_text: 'Unstructured draft must not be used.' },
    ],
    extractor: async (input) => {
      extractionInput = input;
      return {
        answer: 'CPI inflation was 2.1% in 2020 [1] and 3.0% in 2025 [2].',
        uncertainty: null,
        evidence: structuredEvidence,
      };
    },
  });

  const result = await fixture.runAgent({
    ...userContext,
    conversationId: 'conversation-evidence-1',
    message: 'Compare CPI inflation in 2020 with the latest available figure.',
  });

  assert.deepEqual(fixture.searched, [
    'official CPI inflation 2020 annual',
    'latest CPI inflation 2025 annual',
  ]);
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.requests.every((request) => request.tools.length === 1 && request.tools[0].name === 'web_search'), true);
  assert.match(result.answer, /2.1% in 2020 \[1\] and 3.0% in 2025 \[2\]/);
  assert.equal(extractionInput.targets.length, 2);
  assert.equal(extractionInput.sources.length, 2);
  assert.equal(fixture.saved[1].metadata.temporalEvidence.verified, true);
  assert.equal(fixture.saved[1].metadata.temporalEvidence.pair.first.sourceCitation, 1);
  assert.equal(fixture.saved[1].metadata.temporalEvidence.pair.second.sourceCitation, 2);
});

test('temporal runner refuses a like-for-like answer when extracted units differ', async () => {
  const mismatchedLatest = {
    ...latestSource,
    content: 'Latest 2025 annual CPI inflation for all urban consumers in the United States was 115.2 index points annual average.',
  };
  const latestClaim = webClaim({
    citation: 2,
    value: '115.2',
    period: '2025 annual',
    unit: 'index points',
    source: mismatchedLatest,
  });
  const fixture = createRunner({
    responses: [
      { id: 'baseline-search', output: [functionCall('baseline', 'official CPI inflation 2020 annual')] },
      { id: 'latest-search', output: [functionCall('latest', 'latest CPI inflation 2025 annual')] },
      { id: 'search-complete', output: [], output_text: 'Unverified draft: inflation changed by 20%.' },
      { id: 'guarded-final', output: [], output_text: 'The sources use different units, so I cannot verify a like-for-like change [1] [2].' },
    ],
    latest: mismatchedLatest,
    extractor: async () => ({
      answer: 'Inflation changed by 20% [1] [2].',
      uncertainty: null,
      evidence: [
        webClaim({ citation: 1, value: '2.1%', period: '2020 annual', source: baselineSource }),
        latestClaim,
      ],
    }),
  });

  const result = await fixture.runAgent({
    ...userContext,
    conversationId: 'conversation-evidence-2',
    message: 'Compare CPI inflation in 2020 with the latest available figure.',
  });

  assert.equal(fixture.requests.length, 4);
  assert.equal(fixture.requests[3].tool_choice, 'none');
  assert.match(fixture.requests[3].input[0].content, /not_like_for_like:unit/);
  assert.match(result.answer, /different units/);
  assert.equal(fixture.saved[1].metadata.temporalEvidence.verified, false);
});

test('temporal runner fails closed when structured extraction is unavailable', async () => {
  const fixture = createRunner({
    responses: [
      { id: 'baseline-search', output: [functionCall('baseline', 'official CPI inflation 2020 annual')] },
      { id: 'latest-search', output: [functionCall('latest', 'latest CPI inflation 2025 annual')] },
      { id: 'search-complete', output: [], output_text: 'Unverified draft: inflation changed by 20%.' },
      { id: 'guarded-final', output: [], output_text: 'I could not validate the observation values and scope [1] [2].' },
    ],
    extractor: async () => { throw new Error('provider details must not reach the user'); },
  });
  const originalError = console.error;
  console.error = () => {};

  try {
    const result = await fixture.runAgent({
      ...userContext,
      conversationId: 'conversation-evidence-3',
      message: 'Compare CPI inflation in 2020 with the latest available figure.',
    });

    assert.equal(fixture.requests.length, 4);
    assert.equal(fixture.requests[3].tool_choice, 'none');
    assert.match(fixture.requests[3].input[0].content, /structured_evidence_extraction_unavailable/);
    assert.match(result.answer, /could not validate the observation values/);
    assert.doesNotMatch(result.answer, /provider details/);
    assert.equal(fixture.saved[1].metadata.temporalEvidence.verified, false);
  } finally {
    console.error = originalError;
  }
});
