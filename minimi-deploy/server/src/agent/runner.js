import {
  WEB_SEARCH_TOOL,
  buildInstructions,
  chooseToolMode,
  isAllowedToolCall,
  isHistoricalQuestion,
  isTemporalComparisonQuestion,
  mergeSearchCallResults,
  validateCitationReferences,
} from './logic.js';

function getWebSearchCalls(response) {
  return (response.output || []).filter(isAllowedToolCall);
}

async function createFinalAnswer(client, response, instructions, model) {
  if (!getWebSearchCalls(response).length) return response;
  return client.responses.create({
    model,
    instructions,
    previous_response_id: response.id,
    input: [{
      role: 'user',
      content: 'Answer now using only the conversation and search evidence already provided. Do not request another tool call. Clearly state any evidence gaps.',
    }],
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
    const toolMode = chooseToolMode({ historical, temporal });
    const instructions = buildInstructions({ historical, temporal });
    const sourceState = { sources: [] };
    const client = await getClient();

    await saveMessage({ ...dbContext, conversationId, role: 'user', content: message });

    let response = await client.responses.create({
      model,
      instructions,
      input: [...priorHistory, { role: 'user', content: message }],
      tools: [WEB_SEARCH_TOOL],
      tool_choice: toolMode,
    });

    // History-only questions are never allowed to invoke search, even if a
    // provider unexpectedly returns a function call despite tool_choice=none.
    for (let step = 0; toolMode !== 'none' && step < 2; step += 1) {
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

      const mergedSearch = mergeSearchCallResults(searchRuns, sourceState.sources);
      sourceState.sources = mergedSearch.sources;
      const outputs = searchRuns.map((run, index) => ({
        type: 'function_call_output',
        call_id: run.call.call_id,
        output: JSON.stringify(mergedSearch.outputs[index]),
      }));

      response = await client.responses.create({
        model,
        instructions,
        previous_response_id: response.id,
        input: outputs,
        tools: [WEB_SEARCH_TOOL],
        tool_choice: 'auto',
      });
    }

    response = await createFinalAnswer(client, response, instructions, model);
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
