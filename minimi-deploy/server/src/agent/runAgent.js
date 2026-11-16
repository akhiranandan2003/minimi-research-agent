import OpenAI from 'openai';
import { tavily } from '@tavily/core';
import { config } from '../config.js';
import { getConversationHistory, saveMessage } from '../services/memory.js';
import { createAgentRunner } from './runner.js';
import { normalizeSearchResults, parseToolArguments } from './logic.js';

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

// Provider SDKs stay in this adapter; runner.js owns the testable orchestration.
export const runAgent = createAgentRunner({
  getClient: getOpenAI,
  search: executeWebSearch,
  getHistory: (conversationId, limit, question, { supabase, userId }) =>
    getConversationHistory(supabase, userId, conversationId, limit, question),
  saveMessage: ({ supabase, ...message }) => saveMessage(supabase, message),
  model: config.openaiModel,
});
