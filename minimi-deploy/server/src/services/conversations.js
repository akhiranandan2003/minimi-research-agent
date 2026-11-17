import crypto from 'node:crypto';

const CONVERSATION_COLUMNS = 'id, title, created_at, updated_at';

function requireContext(supabase, userId) {
  if (!supabase || !userId) throw new Error('Authenticated database context is required.');
}

export async function listConversations(supabase, userId, limit = 50) {
  requireContext(supabase, userId);
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 50)));
  const { data, error } = await supabase
    .from('conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(safeLimit);

  if (error) throw new Error('Could not list conversations: ' + error.message);
  return data || [];
}

export async function getConversation(supabase, userId, conversationId) {
  requireContext(supabase, userId);
  const { data, error } = await supabase
    .from('conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('user_id', userId)
    .eq('id', conversationId)
    .maybeSingle();

  if (error) throw new Error('Could not retrieve conversation: ' + error.message);
  return data || null;
}

export async function createConversation(supabase, userId) {
  requireContext(supabase, userId);
  const row = { id: crypto.randomUUID(), user_id: userId, title: 'New chat' };
  const { data, error } = await supabase
    .from('conversations')
    .insert(row)
    .select(CONVERSATION_COLUMNS)
    .single();

  if (error) throw new Error('Could not create conversation: ' + error.message);
  return data;
}

export async function touchConversation(supabase, userId, conversationId, firstMessage = '') {
  const current = await getConversation(supabase, userId, conversationId);
  if (!current) return false;

  const normalizedMessage = String(firstMessage || '').trim().replace(/\s+/g, ' ');
  const title = current.title === 'New chat' && normalizedMessage
    ? normalizedMessage.slice(0, 80)
    : current.title;

  const { error } = await supabase
    .from('conversations')
    .update({ title, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', conversationId);

  if (error) throw new Error('Could not update conversation activity: ' + error.message);
  return true;
}
