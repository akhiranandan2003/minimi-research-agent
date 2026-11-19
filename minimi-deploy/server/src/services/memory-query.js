import { buildHistorySearchQuery } from '../agent/logic.js';

const HISTORY_COLUMNS = 'id, role, content, created_at, metadata';

function stableMessageKey(record) {
  return record.id ?? String(record.created_at || '') + ':' + String(record.role || '') + ':' + String(record.content || '');
}

function compareMessageIds(left, right) {
  const leftId = String(left.id ?? '');
  const rightId = String(right.id ?? '');

  // PostgreSQL bigint values may arrive as strings and exceed Number.MAX_SAFE_INTEGER.
  // Compare decimal IDs with BigInt so equal-timestamp rows retain true DB order.
  if (/^\\d+$/.test(leftId) && /^\\d+$/.test(rightId)) {
    const leftBigInt = BigInt(leftId);
    const rightBigInt = BigInt(rightId);
    return leftBigInt < rightBigInt ? -1 : leftBigInt > rightBigInt ? 1 : 0;
  }

  return leftId.localeCompare(rightId);
}

function chronological(records) {
  return [...records].sort((left, right) => {
    const leftTime = Date.parse(left.created_at || '');
    const rightTime = Date.parse(right.created_at || '');
    const safeLeftTime = Number.isFinite(leftTime) ? leftTime : 0;
    const safeRightTime = Number.isFinite(rightTime) ? rightTime : 0;
    return (safeLeftTime - safeRightTime) || compareMessageIds(left, right);
  });
}

// Both the owner and conversation filters are applied to every database read.
export async function queryConversationHistory(supabase, userId, conversationId, limit = 40, question = '') {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 40)));
  const recentResult = await supabase
    .from('messages')
    .select(HISTORY_COLUMNS)
    .eq('user_id', userId)
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
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .textSearch('content', searchQuery, { type: 'websearch', config: 'english' })
      .order('created_at', { ascending: false })
      .limit(30);

    if (relevantResult.error) {
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
