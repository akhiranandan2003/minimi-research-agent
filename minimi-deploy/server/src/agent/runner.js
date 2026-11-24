import {
  WEB_SEARCH_TOOL,
  buildInstructions,
  chooseToolMode,
  extractTemporalTargets,
  matchTemporalEvidence,
  isAllowedToolCall,
  isHistoricalQuestion,
  isTemporalComparisonQuestion,
  mergeSearchCallResults,
  parseToolArguments,
  validateCitationReferences,
} from './logic.js';
import { validateTemporalAnswerNumbers, validateTemporalEvidence } from './evidence.js';

function getWebSearchCalls(response) {
  return (response.output || []).filter(isAllowedToolCall);
}

function normalizedQuery(call) {
  try {
    return parseToolArguments(call.arguments).query.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
}

function requiredEvidenceCitations(evidenceCheck) {
  if (!evidenceCheck?.pair) return [];
  return [evidenceCheck.pair.first, evidenceCheck.pair.second]
    .filter((claim) => claim.evidenceType === 'web')
    .map((claim) => claim.sourceCitation);
}

function persistedEvidencePair(pair) {
  if (!pair) return null;
  const fields = [
    'evidenceType', 'conversationRole', 'metric', 'value', 'unit',
    'observationPeriod', 'geography', 'population', 'scope', 'sourceCitation', 'periodLabel',
  ];
  const pick = (claim) => Object.fromEntries(fields.map((field) => [field, claim[field]]));
  return { first: pick(pair.first), second: pick(pair.second) };
}

async function createFinalAnswer(client, response, instructions, model, {
  temporal = false,
  successfulTemporalSearchCount = 0,
  evidenceBackedTemporalPeriods = [],
  requiredTemporalPeriods = [],
  structuredEvidenceRequired = false,
  evidenceCheck = null,
} = {}) {
  const hasPendingSearchCalls = getWebSearchCalls(response).length > 0;
  const coveredPeriods = new Set(evidenceBackedTemporalPeriods);
  const missingPeriods = requiredTemporalPeriods.filter((period) => !coveredPeriods.has(period.id));
  const structuredEvidenceIncomplete = structuredEvidenceRequired && evidenceCheck?.verified !== true;
  const temporalEvidenceIncomplete = temporal
    && (successfulTemporalSearchCount < 2 || missingPeriods.length > 0 || structuredEvidenceIncomplete);
  if (!hasPendingSearchCalls && !temporalEvidenceIncomplete) return response;

  const evidenceStatus = evidenceCheck
    ? JSON.stringify({
      verified: evidenceCheck.verified,
      reasons: evidenceCheck.reasons,
      acceptedClaims: (evidenceCheck.claims || []).map((claim) => ({
        evidenceType: claim.evidenceType,
        metric: claim.metric,
        value: claim.value,
        unit: claim.unit,
        observationPeriod: claim.observationPeriod,
        geography: claim.geography,
        population: claim.population,
        scope: claim.scope,
        sourceCitation: claim.sourceCitation,
        periodId: claim.periodId,
      })),
    })
    : 'not available';

  const finalInstruction = temporalEvidenceIncomplete
    ? 'Answer now using only the conversation and search evidence already provided. Exactly '
      + successfulTemporalSearchCount
      + ' distinct web-search queries returned usable sources. Source text mentions these requested periods: '
      + (requiredTemporalPeriods.filter((period) => coveredPeriods.has(period.id)).map((period) => period.label).join(', ') || 'none')
      + '. Missing source-text period mentions: '
      + (missingPeriods.map((period) => period.label).join(', ') || 'none')
      + '. Structured evidence validation: ' + evidenceStatus
      + '. Do not present a verified like-for-like comparison or calculate a change/percentage unless both observations have grounded values and the same metric, unit, geography, population, and scope. Explicitly state the evidence gap and distinguish any user-provided historical value from independently verified facts.'
    : 'Answer now using only the conversation and search evidence already provided. Do not request another tool call. Clearly state any evidence gaps.';

  return client.responses.create({
    model,
    instructions,
    previous_response_id: response.id,
    input: [{ role: 'user', content: finalInstruction }],
    tools: [WEB_SEARCH_TOOL],
    tool_choice: 'none',
  });
}

/**
 * Provider adapters are injected so the orchestration can be tested without
 * credentials. Every turn must carry an authenticated, user-scoped DB client.
 */
export function createAgentRunner({
  getClient,
  search,
  getHistory,
  saveMessage,
  model,
  extractTemporalAnswer = null,
}) {
  for (const [name, value] of Object.entries({ getClient, search, getHistory, saveMessage })) {
    if (typeof value !== 'function') throw new TypeError('createAgentRunner requires ' + name + '().');
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new TypeError('createAgentRunner requires a model name.');
  }
  if (extractTemporalAnswer !== null && typeof extractTemporalAnswer !== 'function') {
    throw new TypeError('extractTemporalAnswer must be a function when provided.');
  }

  return async function runAgent({ conversationId, message, userId, supabase }) {
    if (!userId || !supabase) throw new Error('Authenticated user context is required.');
    const dbContext = { userId, supabase };
    const historyRecords = await getHistory(conversationId, 40, message, dbContext);
    const priorHistory = historyRecords
      .filter((record) => record && ['user', 'assistant'].includes(record.role) && typeof record.content === 'string')
      .map((record) => ({ role: record.role, content: record.content }));
    const historical = isHistoricalQuestion(message);
    const temporal = isTemporalComparisonQuestion(message);
    const temporalTargets = temporal ? extractTemporalTargets(message) : [];
    const temporalReferenceDate = new Date();
    const toolMode = chooseToolMode({ historical, temporal });
    const instructions = [
      buildInstructions({ historical, temporal }),
      ...(temporal ? [
        'TEMPORAL SEARCH REQUIREMENT: obtain usable source text for each requested period: '
          + temporalTargets.map((period) => period.label).join(' and ')
          + '. Execute at least two distinct successful web_search queries. Make each query target one requested side explicitly by including its year or words such as historical/baseline versus latest/current; the query helps disambiguate results but is not evidence. The requested period must still appear in a returned source title or content. A single search call can provisionally cover at most one target. Never treat a source publication date as its data observation date. Use relevant stored conversation context to preserve the same metric and scope. If any period is not mentioned in source text after the search rounds, disclose the comparison is incomplete and do not calculate a trend.',
      ] : []),
    ].join('\n');
    const sourceState = { sources: [] };
    const successfulTemporalSearchQueries = new Set();
    const evidenceBackedTemporalPeriods = new Set();
    const attemptedSearchQueries = new Set();
    const client = await getClient();

    await saveMessage({ ...dbContext, conversationId, role: 'user', content: message });

    let response = await client.responses.create({
      model,
      instructions,
      input: [...priorHistory, { role: 'user', content: message }],
      tools: [WEB_SEARCH_TOOL],
      // A temporal comparison must begin with a search, not an unsupported answer.
      tool_choice: temporal ? 'required' : toolMode,
    });

    // History-only questions are never allowed to invoke search, even if a
    // provider unexpectedly returns a function call despite tool_choice=none.
    const maxSearchRounds = temporal ? 3 : 2;
    for (let step = 0; toolMode !== 'none' && step < maxSearchRounds; step += 1) {
      const calls = getWebSearchCalls(response);
      if (!calls.length) break;

      const searchRuns = await Promise.all(calls.map(async (call) => {
        try {
          return { call, sources: await search(call.arguments) };
        } catch (error) {
          console.error('[web_search]', error);
          return { call, error };
        }
      }));

      for (const run of searchRuns) {
        const query = normalizedQuery(run.call);
        if (query) attemptedSearchQueries.add(query);
        if (query && !run.error && Array.isArray(run.sources) && run.sources.length > 0) {
          successfulTemporalSearchQueries.add(query);
          const coveredPeriod = temporal
            ? matchTemporalEvidence(run.sources, temporalTargets, temporalReferenceDate, query || '')
            : null;
          if (coveredPeriod) evidenceBackedTemporalPeriods.add(coveredPeriod);
        }
      }

      const mergedSearch = mergeSearchCallResults(searchRuns, sourceState.sources);
      sourceState.sources = mergedSearch.sources;
      const outputs = searchRuns.map((run, index) => ({
        type: 'function_call_output',
        call_id: run.call.call_id,
        output: JSON.stringify(mergedSearch.outputs[index]),
      }));

      const missingTemporalPeriods = temporalTargets.filter((period) => !evidenceBackedTemporalPeriods.has(period.id));
      const needsSecondTemporalSearch = temporal
        && (successfulTemporalSearchQueries.size < 2 || missingTemporalPeriods.length > 0)
        && step < maxSearchRounds - 1;
      const followUpInput = [...outputs];

      if (needsSecondTemporalSearch) {
        const previousQueries = [...attemptedSearchQueries].join(' | ') || 'none';
        followUpInput.push({
          role: 'user',
          content: 'Only ' + successfulTemporalSearchQueries.size
            + ' distinct web-search query or queries have returned usable sources. Source text has not yet substantiated required period(s): '
            + (missingTemporalPeriods.map((period) => period.label).join(', ') || 'a second distinct evidence query')
            + '. Search one missing period now. Use the original question and stored conversation to preserve the same metric, unit, geography, population, and scope. Each query must clearly target one period. Do not repeat these attempted queries: '
            + previousQueries + '. Return a web_search call, not a prose answer.',
        });
      }

      response = await client.responses.create({
        model,
        instructions,
        previous_response_id: response.id,
        input: followUpInput,
        tools: [WEB_SEARCH_TOOL],
        tool_choice: needsSecondTemporalSearch ? 'required' : 'auto',
      });
    }

    let answer = null;
    let evidenceCheck = null;

    if (temporal && extractTemporalAnswer) {
      try {
        const structured = await extractTemporalAnswer({
          message,
          targets: temporalTargets,
          sources: sourceState.sources,
          history: priorHistory,
        });
        evidenceCheck = validateTemporalEvidence(
          structured.evidence,
          sourceState.sources,
          temporalTargets,
          temporalReferenceDate,
          priorHistory,
        );

        if (evidenceCheck.verified) {
          if (typeof structured.answer !== 'string' || !structured.answer.trim()) {
            evidenceCheck = {
              ...evidenceCheck,
              verified: false,
              reasons: ['structured_answer_missing'],
            };
          } else {
            const safeAnswer = validateCitationReferences(structured.answer, sourceState.sources);
            const answerCitations = new Set(
              [...safeAnswer.matchAll(/\[(\d{1,2})\]/g)].map((match) => Number(match[1])),
            );
            const requiredCitations = requiredEvidenceCitations(evidenceCheck);
            const hasRequiredCitations = requiredCitations.every((citation) => answerCitations.has(citation));
            const numbersAreGrounded = validateTemporalAnswerNumbers(safeAnswer, evidenceCheck.pair);

            if (hasRequiredCitations && numbersAreGrounded && !safeAnswer.includes('[citation unavailable]')) {
              answer = safeAnswer;
            } else {
              const reason = !numbersAreGrounded
                ? 'answer_contains_ungrounded_number_or_direction'
                : safeAnswer.includes('[citation unavailable]')
                  ? 'answer_contains_invalid_citation'
                  : 'answer_missing_required_citations';
              evidenceCheck = {
                ...evidenceCheck,
                verified: false,
                reasons: [reason],
              };
            }
          }
        }
      } catch (error) {
        console.error('[temporal_evidence]', error);
        evidenceCheck = {
          verified: false,
          reasons: ['structured_evidence_extraction_unavailable'],
          claims: [],
          pair: null,
        };
      }
    }

    if (answer === null) {
      response = await createFinalAnswer(client, response, instructions, model, {
        temporal,
        successfulTemporalSearchCount: successfulTemporalSearchQueries.size,
        evidenceBackedTemporalPeriods: [...evidenceBackedTemporalPeriods],
        requiredTemporalPeriods: temporalTargets,
        structuredEvidenceRequired: Boolean(temporal && extractTemporalAnswer),
        evidenceCheck,
      });
      const draftAnswer = response.output_text?.trim() || 'I could not generate a response. Please try again.';
      answer = validateCitationReferences(draftAnswer, sourceState.sources);
    }

    await saveMessage({
      ...dbContext,
      conversationId,
      role: 'assistant',
      content: answer,
      metadata: {
        sources: sourceState.sources,
        historical,
        temporal,
        temporalEvidence: evidenceCheck ? {
          verified: evidenceCheck.verified,
          reasons: evidenceCheck.reasons,
          pair: persistedEvidencePair(evidenceCheck.pair),
        } : null,
      },
    });
    return { answer, sources: sourceState.sources };
  };
}
