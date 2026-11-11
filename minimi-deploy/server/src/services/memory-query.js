// Isolated query helper makes the database retrieval contract testable without a live Supabase project.
export async function queryConversationHistory(supabase, conversationId, limit = 40) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, created_at, metadata')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not retrieve conversation history: ${error.message}`);
  return (data || []).reverse();
}

export function toModelHistory(records = []) {
  return [...records]
    .reverse()
    .filter((record) => record && ['user', 'assistant'].includes(record.role) && typeof record.content === 'string')
    .map((record) => ({ role: record.role, content: record.content }));
}
