import { getSupabase } from './supabase.js';
import { queryConversationHistory } from './memory-query.js';

export { toModelHistory } from './memory-query.js';

// Database rows are the only source of conversational memory.
export async function getConversationHistory(conversationId, limit = 40, question = '') {
  return queryConversationHistory(getSupabase(), conversationId, limit, question);
}

export async function saveMessage({ conversationId, role, content, metadata = {} }) {
  const { error } = await getSupabase().from('messages').insert({
    conversation_id: conversationId,
    role,
    content,
    metadata,
  });
  if (error) throw new Error(`Could not save ${role} message: ${error.message}`);
}
