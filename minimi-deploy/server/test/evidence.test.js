import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTemporalAnswerExtractor,
  TEMPORAL_ANSWER_FORMAT,
  validateTemporalAnswerNumbers,
  validateTemporalEvidence,
} from '../src/agent/evidence.js';
import { extractTemporalTargets } from '../src/agent/logic.js';

const referenceDate = new Date('2026-11-24T00:00:00Z');
const targets = extractTemporalTargets('Compare CPI inflation in 2020 with the latest available figure.');

const baselineSource = {
  citation: 1,
  title: '2020 annual CPI inflation for all urban consumers in the United States',
  url: 'https://stats.example/cpi-2020',
  publishedDate: '2021-01-12',
  content: '2020 annual CPI inflation for all urban consumers in the United States was 2.1% annual average.',
};

const latestSource = {
  citation: 2,
  title: 'Latest 2025 annual CPI inflation for all urban consumers in the United States',
  url: 'https://stats.example/cpi-latest',
  publishedDate: '2026-10-15',
  content: 'Latest 2025 annual CPI inflation for all urban consumers in the United States was 3.0% annual average.',
};

function claim(source, { value, period, citation, unit = '%', evidenceType = 'web', quote } = {}) {
  return {
    evidence_type: evidenceType,
    metric: 'CPI inflation',
    value: value || (citation === 1 ? '2.1%' : '3.0%'),
    unit,
    observation_period: period || (citation === 1 ? '2020 annual' : '2025 annual'),
    geography: 'United States',
    population: 'all urban consumers',
    scope: 'annual average',
    source_citation: evidenceType === 'conversation' ? null : citation,
    evidence_quote: quote || source.content,
  };
}

test('structured evidence verifies grounded values and matching comparison dimensions', () => {
  const result = validateTemporalEvidence([
    claim(baselineSource, { citation: 1 }),
    claim(latestSource, { citation: 2 }),
  ], [baselineSource, latestSource], targets, referenceDate);

  assert.equal(result.verified, true, JSON.stringify({ targets, result }));
  assert.deepEqual(result.reasons, []);
  assert.equal(result.pair.first.periodId, 'year:2020');
  assert.equal(result.pair.second.periodId, 'latest');
  assert.equal(result.pair.first.numericValue, 2.1);
  assert.equal(result.pair.second.numericValue, 3);
  assert.equal(result.pair.first.sourceCitation, 1);
  assert.equal(result.pair.second.sourceCitation, 2);
});

test('answer numbers are limited to extracted values, observation years, and derived changes', () => {
  const result = validateTemporalEvidence([
    claim(baselineSource, { citation: 1 }),
    claim(latestSource, { citation: 2 }),
  ], [baselineSource, latestSource], targets, referenceDate);

  assert.equal(validateTemporalAnswerNumbers(
    'CPI inflation moved from 2.1% in 2020 [1] to 3.0% in 2025 [2], an increase of 0.9 percentage points (42.86% relative).',
    result.pair,
  ), true);
  assert.equal(validateTemporalAnswerNumbers(
    'CPI inflation increased by 20% between 2020 and 2025 [1] [2].',
    result.pair,
  ), false);
  assert.equal(validateTemporalAnswerNumbers(
    'CPI inflation decreased by 0.9 percentage points between 2020 and 2025 [1] [2].',
    result.pair,
  ), false);
  assert.equal(validateTemporalAnswerNumbers(
    'CPI inflation increased by 42.86 percentage points between 2020 and 2025 [1] [2].',
    result.pair,
  ), false);
  assert.equal(validateTemporalAnswerNumbers(
    'CPI inflation increased by 42.86 percentage-points between 2020 and 2025 [1] [2].',
    result.pair,
  ), false);
  assert.equal(validateTemporalAnswerNumbers(
    'CPI inflation increased by 0.9 percentage-point between 2020 and 2025 [1] [2].',
    result.pair,
  ), true);
  assert.equal(validateTemporalAnswerNumbers(
    'CPI inflation increased by 0.9% between 2020 and 2025 [1] [2].',
    result.pair,
  ), false);
});

test('different units fail closed even when both periods and values are grounded', () => {
  const differentUnitSource = {
    ...latestSource,
    content: 'Latest 2025 annual CPI inflation for all urban consumers in the United States was 115.2 index points annual average.',
  };
  const result = validateTemporalEvidence([
    claim(baselineSource, { citation: 1 }),
    claim(differentUnitSource, {
      citation: 2,
      value: '115.2',
      unit: 'index points',
      period: '2025 annual',
      quote: differentUnitSource.content,
    }),
  ], [baselineSource, differentUnitSource], targets, referenceDate);

  assert.equal(result.verified, false);
  assert.deepEqual(result.reasons, ['not_like_for_like:unit']);
  assert.equal(result.pair, null);
});

test('percent and percentage-point units are distinct during evidence extraction', () => {
  const baselinePointsSource = {
    ...baselineSource,
    content: '2020 annual CPI inflation for all urban consumers in the United States was 2.1 percentage-point annual average.',
  };
  const latestPointsSource = {
    ...latestSource,
    content: 'Latest 2025 annual CPI inflation for all urban consumers in the United States was 3.0 pp annual average.',
  };

  const mislabeledPercent = validateTemporalEvidence([
    claim(baselinePointsSource, {
      citation: 1,
      unit: '%',
      quote: baselinePointsSource.content,
    }),
    claim(latestPointsSource, {
      citation: 2,
      unit: '%',
      period: '2025 annual',
      quote: latestPointsSource.content,
    }),
  ], [baselinePointsSource, latestPointsSource], targets, referenceDate);

  assert.equal(mislabeledPercent.verified, false);
  assert.ok(mislabeledPercent.reasons.includes('missing_grounded_evidence:year:2020'));

  const correctlyLabeledPoints = validateTemporalEvidence([
    claim(baselinePointsSource, {
      citation: 1,
      unit: 'percentage points',
      quote: baselinePointsSource.content,
    }),
    claim(latestPointsSource, {
      citation: 2,
      unit: 'percentage points',
      period: '2025 annual',
      quote: latestPointsSource.content,
    }),
  ], [baselinePointsSource, latestPointsSource], targets, referenceDate);

  assert.equal(correctlyLabeledPoints.verified, true);
  assert.equal(correctlyLabeledPoints.pair.first.unit, 'percentage points');
});

test('unit evidence must be attached to the exact claimed numeric value', () => {
  const mixedUnitSource = {
    ...baselineSource,
    content: '2020 annual CPI inflation for all urban consumers in the United States was 2.1 percentage points, while a separate reference rate was 3.0% annual average.',
  };

  const mislabeledPercent = validateTemporalEvidence([
    claim(mixedUnitSource, {
      citation: 1,
      value: '2.1',
      unit: '%',
      quote: mixedUnitSource.content,
    }),
    claim(latestSource, { citation: 2 }),
  ], [mixedUnitSource, latestSource], targets, referenceDate);

  assert.equal(mislabeledPercent.verified, false);
  assert.ok(mislabeledPercent.reasons.includes('missing_grounded_evidence:year:2020'));

  const correctlyLabeledPoints = validateTemporalEvidence([
    claim(mixedUnitSource, {
      citation: 1,
      value: '2.1',
      unit: 'percentage points',
      quote: mixedUnitSource.content,
    }),
    claim(latestSource, { citation: 2 }),
  ], [mixedUnitSource, latestSource], targets, referenceDate);

  assert.equal(correctlyLabeledPoints.claims.length, 2);
  assert.deepEqual(correctlyLabeledPoints.reasons, ['not_like_for_like:unit']);
});

test('final-answer unit checks do not borrow a nearby number unit', () => {
  const result = validateTemporalEvidence([
    claim(baselineSource, { citation: 1 }),
    claim(latestSource, { citation: 2 }),
  ], [baselineSource, latestSource], targets, referenceDate);

  assert.equal(result.verified, true);
  assert.equal(validateTemporalAnswerNumbers(
    'CPI inflation was 2.1 percentage points in 2020 [1] and 3.0% in 2025 [2].',
    result.pair,
  ), false);
  assert.equal(validateTemporalAnswerNumbers(
    'CPI inflation was 2.1% in 2020 [1] and 3.0% in 2025 [2], a 0.9 percentage-point increase.',
    result.pair,
  ), true);
});

test('fabricated evidence quotes and values are rejected', () => {
  const fabricated = claim(baselineSource, {
    citation: 1,
    value: '9.9%',
    quote: '2020 annual CPI inflation for all urban consumers in the United States was 9.9% annual average.',
  });
  const result = validateTemporalEvidence([
    fabricated,
    claim(latestSource, { citation: 2 }),
  ], [baselineSource, latestSource], targets, referenceDate);

  assert.equal(result.verified, false);
  assert.ok(result.reasons.includes('missing_grounded_evidence:year:2020'));
  assert.equal(result.claims.length, 1);
});

test('a stale publication cannot substantiate the latest observation period', () => {
  const staleSource = { ...latestSource, publishedDate: '2022-10-15' };
  const result = validateTemporalEvidence([
    claim(baselineSource, { citation: 1 }),
    claim(staleSource, { citation: 2 }),
  ], [baselineSource, staleSource], targets, referenceDate);

  assert.equal(result.verified, false);
  assert.ok(result.reasons.includes('missing_grounded_evidence:latest'));
});

test('an exact stored user message can provide a historical baseline distinct from web evidence', () => {
  const history = [{
    role: 'user',
    content: 'My CPI inflation for all urban consumers in the United States was 2.1% in 2020 annual average.',
  }];
  const conversationClaim = {
    evidence_type: 'conversation',
    metric: 'CPI inflation',
    value: '2.1%',
    unit: '%',
    observation_period: '2020 annual',
    geography: 'United States',
    population: 'all urban consumers',
    scope: 'annual average',
    source_citation: null,
    evidence_quote: history[0].content,
  };
  const result = validateTemporalEvidence([
    conversationClaim,
    claim(latestSource, { citation: 2 }),
  ], [latestSource], targets, referenceDate, history);

  assert.equal(result.verified, true, JSON.stringify({ targets, result }));
  assert.equal(result.pair.first.evidenceType, 'conversation');
  assert.equal(result.pair.first.conversationRole, 'user');
  assert.equal(result.pair.first.sourceCitation, null);
  assert.equal(result.pair.second.evidenceType, 'web');
  assert.equal(result.pair.second.sourceCitation, 2);
});

test('structured extractor uses strict JSON schema and exposes no external tools', async () => {
  const payload = {
    answer: 'The comparison is incomplete.',
    uncertainty: 'Population is not stated.',
    evidence: [],
  };
  const requests = [];
  const extractor = createTemporalAnswerExtractor({
    getClient: () => ({
      responses: {
        async create(request) {
          requests.push(request);
          return { status: 'completed', output_text: JSON.stringify(payload) };
        },
      },
    }),
    model: 'test-model',
  });

  const result = await extractor({
    message: 'Compare CPI inflation in 2020 with the latest available figure.',
    targets,
    sources: [baselineSource],
    history: [{ role: 'user', content: 'Earlier note' }],
  });

  assert.deepEqual(result, payload);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].text.format.type, 'json_schema');
  assert.equal(requests[0].text.format.strict, true);
  assert.deepEqual(requests[0].text.format, TEMPORAL_ANSWER_FORMAT);
  assert.equal(requests[0].tools, undefined);
  assert.equal(requests[0].store, false);
  const input = JSON.parse(requests[0].input[0].content);
  assert.equal(input.web_sources[0].citation, 1);
  assert.equal(input.stored_conversation_messages[0].content, 'Earlier note');
});

test('extractor rejects incomplete or non-JSON model responses', async () => {
  const extractor = createTemporalAnswerExtractor({
    getClient: () => ({
      responses: {
        async create() {
          return { status: 'incomplete', output_text: '' };
        },
      },
    }),
    model: 'test-model',
  });

  await assert.rejects(
    extractor({ message: 'Compare values', targets, sources: [], history: [] }),
    /did not complete/,
  );
});
