import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { config, missingServerConfig } from './config.js';
import { runAgent } from './agent/runAgent.js';
import { getConversationHistory } from './services/memory.js';
import {
  createConversation,
  getConversation,
  listConversations,
  touchConversation,
} from './services/conversations.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createUserRateLimiter } from './middleware/rate-limit.js';

const uuidSchema = z.string().uuid();
const chatSchema = z.object({
  conversationId: uuidSchema,
  message: z.string().trim().min(1).max(6000),
});

/**
 * Build the HTTP API without opening a listening socket.
 * Dependencies can be replaced in tests while production uses the real services.
 */
export function createApp({
  authenticate = createAuthMiddleware(),
  rateLimitChat = createUserRateLimiter({ windowMs: 60_000, maxRequests: 20 }),
  runAgent: runAgentImpl = runAgent,
  getConversationHistory: getConversationHistoryImpl = getConversationHistory,
  createConversation: createConversationImpl = createConversation,
  getConversation: getConversationImpl = getConversation,
  listConversations: listConversationsImpl = listConversations,
  touchConversation: touchConversationImpl = touchConversation,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.clientOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS.'));
    },
  }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/ping', (_req, res) => res.json({ status: 'ok' }));

  app.get('/api/health', (_req, res) => {
    const missing = missingServerConfig();
    res.status(missing.length ? 503 : 200).json({
      status: missing.length ? 'needs_configuration' : 'ok',
      missing,
    });
  });

  app.get('/api/conversations', authenticate, async (req, res) => {
    try {
      const conversations = await listConversationsImpl(req.supabase, req.user.id, 50);
      return res.json({ conversations });
    } catch (error) {
      console.error('[conversations:list]', error);
      return res.status(500).json({ error: 'Could not load conversations.' });
    }
  });

  app.post('/api/conversations', authenticate, async (req, res) => {
    try {
      const conversation = await createConversationImpl(req.supabase, req.user.id);
      return res.status(201).json({ conversation });
    } catch (error) {
      console.error('[conversations:create]', error);
      return res.status(500).json({ error: 'Could not create a conversation.' });
    }
  });

  app.get('/api/conversations/:conversationId/messages', authenticate, async (req, res) => {
    if (!uuidSchema.safeParse(req.params.conversationId).success) {
      return res.status(400).json({ error: 'Invalid conversation ID.' });
    }
    try {
      const conversation = await getConversationImpl(req.supabase, req.user.id, req.params.conversationId);
      if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
      const messages = await getConversationHistoryImpl(
        req.supabase,
        req.user.id,
        req.params.conversationId,
        100,
      );
      return res.json({ messages: messages.map((item) => ({
        role: item.role,
        content: item.content,
        createdAt: item.created_at,
        sources: item.metadata?.sources || [],
      })) });
    } catch (error) {
      console.error('[history]', error);
      return res.status(500).json({ error: 'Could not load conversation history.' });
    }
  });

  app.post('/api/chat', authenticate, rateLimitChat, async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Provide a valid conversationId and a message between 1 and 6000 characters.' });
    }

    try {
      const owned = await touchConversationImpl(
        req.supabase,
        req.user.id,
        parsed.data.conversationId,
        parsed.data.message,
      );
      if (!owned) return res.status(404).json({ error: 'Conversation not found.' });

      const result = await runAgentImpl({
        ...parsed.data,
        userId: req.user.id,
        supabase: req.supabase,
      });
      return res.json(result);
    } catch (error) {
      console.error('[chat]', error);
      const message = error?.message || 'Unexpected server error.';
      const status = /missing|not configured/i.test(message) ? 503 : 500;
      return res.status(status).json({
        error: status === 503 ? message : 'The assistant could not complete that request. Please try again.',
      });
    }
  });

  app.use((error, _req, res, _next) => {
    console.error('[express]', error);
    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
    return res.status(500).json({ error: 'Unexpected server error.' });
  });

  return app;
}
