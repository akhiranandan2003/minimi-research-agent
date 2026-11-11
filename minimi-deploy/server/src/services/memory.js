import { getSupabase } from './supabase.js';
import { queryConversationHistory } from './memory-query.js';

export { toModelHistory } from './memory-query.js';

// Keep the database records as the source of truth. Never fabricate missing history.
export async function getConversationHistory(conversationId, limit = 40) {
  return queryConversationHistory(getSupabase(), conversationId, limit);
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
