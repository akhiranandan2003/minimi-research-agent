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

async function createFinalAnswer(client, response, instructions, model, {
  temporal = false,
  successfulTemporalSearchCount = 0,
  evidenceBackedTemporalPeriods = [],
  requiredTemporalPeriods = [],
} = {}) {
  const hasPendingSearchCalls = getWebSearchCalls(response).length > 0;
  const coveredPeriods = new Set(evidenceBackedTemporalPeriods);
  const missingPeriods = requiredTemporalPeriods.filter((period) => !coveredPeriods.has(period.id));
  const temporalEvidenceIncomplete = temporal
    && (successfulTemporalSearchCount < 2 || missingPeriods.length > 0);
  if (!hasPendingSearchCalls && !temporalEvidenceIncomplete) return response;

  const finalInstruction = temporalEvidenceIncomplete
    ? `Answer now using only the conversation and search evidence already provided. Exactly ${successfulTemporalSearchCount} distinct web-search queries returned usable sources. Source text mentions these requested periods: ${requiredTemporalPeriods.filter((period) => coveredPeriods.has(period.id)).map((period) => period.label).join(', ') || 'none'}. Missing source-text period mentions: ${missingPeriods.map((period) => period.label).join(', ') || 'none'}. A period mention is only a retrieval check, not proof of the observation date or comparability. Do not present a verified like-for-like comparison or calculate a change/percentage unless the actual observation periods, metric, unit, geography, population, and scope are verified from the sources. Explicitly state the evidence gap and distinguish any user-provided historical value from independently verified facts.`
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
export function createAgentRunner({ getClient, search, getHistory, saveMessage, model }) {
  for (const [name, value] of Object.entries({ getClient, search, getHistory, saveMessage })) {
    if (typeof value !== 'function') throw new TypeError(`createAgentRunner requires ${name}().`);
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new TypeError('createAgentRunner requires a model name.');
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
        `TEMPORAL SEARCH REQUIREMENT: obtain usable source text for each requested period: ${temporalTargets.map((period) => period.label).join(' and ')}. Execute at least two distinct successful web_search queries. A query mentioning a period does not count: the period must appear in a returned source title or content. A single search call can provisionally cover at most one target. Never treat a source publication date as its data observation date. Use relevant stored conversation context to preserve the same metric and scope. If any period is not mentioned in source text after the search rounds, disclose the comparison is incomplete and do not calculate a trend.`,
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
          content: `Only ${successfulTemporalSearchQueries.size} distinct web-search query or queries have returned usable sources. Source text has not yet substantiated required period(s): ${missingTemporalPeriods.map((period) => period.label).join(', ') || 'a second distinct evidence query'}. Search one missing period now. Use the original question and stored conversation to preserve the same metric, unit, geography, population, and scope. Each query must clearly target one period. Do not repeat these attempted queries: ${previousQueries}. Return a web_search call, not a prose answer.`,
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

    response = await createFinalAnswer(client, response, instructions, model, {
      temporal,
      successfulTemporalSearchCount: successfulTemporalSearchQueries.size,
      evidenceBackedTemporalPeriods: [...evidenceBackedTemporalPeriods],
      requiredTemporalPeriods: temporalTargets,
    });
    const draftAnswer = response.output_text?.trim() || 'I could not generate a response. Please try again.';
    const answer = validateCitationReferences(draftAnswer, sourceState.sources);

    await saveMessage({
      ...dbContext,
      conversationId,
      role: 'assistant',
      content: answer,
      metadata: { sources: sourceState.sources, historical, temporal },
    });
    return { answer, sources: sourceState.sources };
  };
}
