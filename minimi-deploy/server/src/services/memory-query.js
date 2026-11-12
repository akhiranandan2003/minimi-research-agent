import { buildHistorySearchQuery } from '../agent/logic.js';

const HISTORY_COLUMNS = 'id, role, content, created_at, metadata';

function stableMessageKey(record) {
  return record.id ?? String(record.created_at || '') + ':' + String(record.role || '') + ':' + String(record.content || '');
}

function chronological(records) {
  return [...records].sort((left, right) => {
    const timeDifference = (Date.parse(left.created_at || '') || 0) - (Date.parse(right.created_at || '') || 0);
    if (timeDifference !== 0) return timeDifference;
    return Number(left.id || 0) - Number(right.id || 0);
  });
}

// Always constrain both reads to the requested conversation. The full-text pass
// retrieves older matching messages; the recent pass preserves nearby context.
export async function queryConversationHistory(supabase, conversationId, limit = 40, question = '') {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 40)));
  const recentResult = await supabase
    .from('messages')
    .select(HISTORY_COLUMNS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (recentResult.error) throw new Error('Could not retrieve conversation history: ' + recentResult.error.message);

  const combined = [...(recentResult.data || [])];
  const searchQuery = buildHistorySearchQuery(question);
  if (searchQuery) {
    const relevantResult = await supabase
      .from('messages')
      .select(HISTORY_COLUMNS)
      .eq('conversation_id', conversationId)
      .textSearch('content', searchQuery, { type: 'websearch', config: 'english' })
      .order('created_at', { ascending: false })
      .limit(30);

    if (relevantResult.error) {
      // Recent history remains useful if full-text retrieval is unavailable.
      console.warn('[memory] Full-text history lookup failed:', relevantResult.error.message);
    } else {
      combined.push(...(relevantResult.data || []));
    }
  }

  const unique = new Map();
  for (const record of combined) unique.set(stableMessageKey(record), record);
  return chronological([...unique.values()]).slice(-(safeLimit + (searchQuery ? 30 : 0)));
}

export function toModelHistory(records = []) {
  return chronological(records)
    .filter((record) => record && ['user', 'assistant'].includes(record.role) && typeof record.content === 'string')
    .map((record) => ({ role: record.role, content: record.content }));
}