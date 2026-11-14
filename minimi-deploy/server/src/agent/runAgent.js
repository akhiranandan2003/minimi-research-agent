import OpenAI from 'openai';
import { tavily } from '@tavily/core';
import { config } from '../config.js';
import { getConversationHistory, saveMessage, toModelHistory } from '../services/memory.js';
import {
  WEB_SEARCH_TOOL,
  buildInstructions,
  chooseToolMode,
  isAllowedToolCall,
  isHistoricalQuestion,
  isTemporalComparisonQuestion,
  mergeSearchCallResults,
  normalizeSearchResults,
  parseToolArguments,
  validateCitationReferences,
} from './logic.js';

let openai;
let searchClient;

function getOpenAI() {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is missing. Add it to your server environment.');
  if (!openai) openai = new OpenAI({ apiKey: config.openaiApiKey, timeout: 45000, maxRetries: 1 });
  return openai;
}

function getSearchClient() {
  if (!config.tavilyApiKey) throw new Error('TAVILY_API_KEY is missing. Add it to your server environment.');
  if (!searchClient) searchClient = tavily({ apiKey: config.tavilyApiKey });
  return searchClient;
}

async function executeWebSearch(rawArguments) {
  const { query } = parseToolArguments(rawArguments);
  const result = await getSearchClient().search(query, { maxResults: 6, searchDepth: 'basic' });
  return normalizeSearchResults(result);
}

function getWebSearchCalls(response) {
  return (response.output || []).filter(isAllowedToolCall);
}

async function createFinalAnswer(client, response, instructions) {
  if (!getWebSearchCalls(response).length) return response;
  return client.responses.create({
    model: config.openaiModel,
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

export async function runAgent({ conversationId, message }) {
  const historyRecords = await getConversationHistory(conversationId, 40, message);
  const priorHistory = toModelHistory(historyRecords);
  const historical = isHistoricalQuestion(message);
  const temporal = isTemporalComparisonQuestion(message);
  const instructions = buildInstructions({ historical, temporal });
  const sourceState = { sources: [] };
  const client = getOpenAI();

  await saveMessage({ conversationId, role: 'user', content: message });

  let response = await client.responses.create({
    model: config.openaiModel,
    instructions,
    input: [...priorHistory, { role: 'user', content: message }],
    tools: [WEB_SEARCH_TOOL],
    tool_choice: chooseToolMode({ historical, temporal }),
  });

  for (let step = 0; step < 2; step += 1) {
    const calls = getWebSearchCalls(response);
    if (!calls.length) break;

    const searchRuns = await Promise.all(calls.map(async (call) => {
      try {
        return { call, sources: await executeWebSearch(call.arguments) };
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
      model: config.openaiModel,
      instructions,
      previous_response_id: response.id,
      input: outputs,
      tools: [WEB_SEARCH_TOOL],
      tool_choice: 'auto',
    });
  }

  response = await createFinalAnswer(client, response, instructions);
  const draftAnswer = response.output_text?.trim() || 'I could not generate a response. Please try again.';
  const answer = validateCitationReferences(draftAnswer, sourceState.sources);

  await saveMessage({
    conversationId,
    role: 'assistant',
    content: answer,
    metadata: { sources: sourceState.sources, historical, temporal },
  });
  return { answer, sources: sourceState.sources };
}