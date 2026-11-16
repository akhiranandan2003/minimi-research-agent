import { queryConversationHistory } from './memory-query.js';

export { toModelHistory } from './memory-query.js';

// Database rows are the only source of conversational memory.
export async function getConversationHistory(supabase, userId, conversationId, limit = 40, question = '') {
  return queryConversationHistory(supabase, userId, conversationId, limit, question);
}

export async function saveMessage(supabase, { userId, conversationId, role, content, metadata = {} }) {
  if (!supabase || !userId) throw new Error('Authenticated database context is required to save a message.');
  const { error } = await supabase.from('messages').insert({
    user_id: userId,
    conversation_id: conversationId,
    role,
    content,
    metadata,
  });
  if (error) throw new Error(`Could not save ${role} message: ${error.message}`);
}
