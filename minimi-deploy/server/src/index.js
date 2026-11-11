import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { config, missingServerConfig } from './config.js';
import { runAgent } from './agent/runAgent.js';
import { getConversationHistory } from './services/memory.js';

const app = express();
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.clientOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS.'));
  },
}));
app.use(express.json({ limit: '32kb' }));

const uuidSchema = z.string().uuid();
const chatSchema = z.object({
  conversationId: uuidSchema,
  message: z.string().trim().min(1).max(6000),
});

app.get('/api/health', (_req, res) => {
  const missing = missingServerConfig();
  res.status(missing.length ? 503 : 200).json({
    status: missing.length ? 'needs_configuration' : 'ok',
    missing,
  });
});

app.post('/api/conversations', (_req, res) => {
  // The UUID is an unguessable conversation handle, not a substitute for user authentication.
  res.status(201).json({ conversationId: crypto.randomUUID() });
});

app.get('/api/conversations/:conversationId/messages', async (req, res) => {
  if (!uuidSchema.safeParse(req.params.conversationId).success) {
    return res.status(400).json({ error: 'Invalid conversation ID.' });
  }
  try {
    const messages = await getConversationHistory(req.params.conversationId, 100);
    return res.json({ messages: messages.map((item) => ({
      role: item.role, content: item.content, createdAt: item.created_at, sources: item.metadata?.sources || [],
    })) });
  } catch (error) {
    console.error('[history]', error);
    return res.status(500).json({ error: 'Could not load conversation history.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Provide a valid conversationId and a message between 1 and 6000 characters.' });
  }

  try {
    const result = await runAgent(parsed.data);
    return res.json(result);
  } catch (error) {
    console.error('[chat]', error);
    const message = error?.message || 'Unexpected server error.';
    const status = /missing|not configured/i.test(message) ? 503 : 500;
    return res.status(status).json({ error: message });
  }
});

app.use((error, _req, res, _next) => {
  console.error('[express]', error);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(config.port, () => {
  console.log(`Minimi API listening on http://localhost:${config.port}`);
});
