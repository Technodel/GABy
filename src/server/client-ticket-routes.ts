import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth, AuthRequest } from './auth';
import { getDb } from './db';
import { userClientManager } from './user-client-manager';
import { generateText } from 'ai';
import { getModelsForMode } from './agent';

const router = Router();

function generateUid(): string {
  return crypto.randomBytes(16).toString('hex');
}

interface TicketRow {
  id: number;
  uid: string;
  user_id: number;
  project_id: number | null;
  project_name: string;
  company_name: string;
  goal: string;
  messages: string;
  status: string;
  summary: string;
  suggestions: string;
  created_at: string;
  closed_at: string | null;
}

// ── All auth-required routes ─────────────────────────────────────────────

router.use('/client-tickets', requireAuth);

// ── List tickets for authenticated user ──────────────────────────────────

router.get('/client-tickets', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const tickets = getDb().prepare(
    'SELECT * FROM client_tickets WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId) as TicketRow[];

  res.json({ tickets: tickets.map(t => ({ ...t, messages: JSON.parse(t.messages || '[]') })) });
});

// ── Create a new ticket (with AI-generated initial form) ─────────────────

router.post('/client-tickets', async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const { project_id, project_name, goal } = req.body;

  if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
    res.status(400).json({ error: 'Goal is required — tell SUNy what you need from your client.' });
    return;
  }

  const companyName = (req.body.company_name || '').trim();
  if (!companyName) {
    res.status(400).json({ error: 'Company name is required. Set it in Settings first.' });
    return;
  }

  const uid = generateUid();

  // Ask AI to generate an initial opening message for the client
  let openingMessage = '';
  try {
    const models = await getModelsForMode('fast');
    if (models.length > 0) {
      const result = await generateText({
        model: models[0].model,
        system: `You are a helpful project assistant. Generate a friendly, professional opening message 
for a client about a project. The message should:
- Introduce yourself as the AI assistant for ${companyName}
- Ask about the client's needs regarding the project goal
- Be conversational, warm, and engaging
- NOT mention costs, models, AI tools, or technical details
- Focus only on understanding what the client wants
Keep it under 150 words. Respond with the message text only, no JSON.`,
        prompt: `Company: ${companyName}\nProject: ${project_name || 'Unnamed'}\nGoal: ${goal}\n\nGenerate an opening message for the client.`,
      });
      openingMessage = result.text.trim();
    }
  } catch (e) {
    // Fallback message if AI generation fails
    openingMessage = `Hi there! 👋 I'm SUNy, the AI assistant for ${companyName}. I'm here to help with: "${goal}". Could you tell me more about what you're looking for? Any specific details or requirements you have in mind would be great!`;
  }

  const initialMessages = JSON.stringify([{
    role: 'assistant',
    content: openingMessage || `Hi there! I'm SUNy, working with ${companyName}. How can I help you with: "${goal}"?`,
    timestamp: new Date().toISOString(),
  }]);

  getDb().prepare(
    `INSERT INTO client_tickets (uid, user_id, project_id, project_name, company_name, goal, messages, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`
  ).run(uid, userId, project_id || null, project_name || '', companyName, goal.trim(), initialMessages);

  const ticket = getDb().prepare('SELECT * FROM client_tickets WHERE uid = ?').get(uid) as TicketRow;

  res.status(201).json({
    ticket: { ...ticket, messages: JSON.parse(ticket.messages || '[]') },
    link: `${req.protocol}://${req.get('host')}/client-link/${uid}`,
  });
});

// ── Get ticket details ───────────────────────────────────────────────────

router.get('/client-tickets/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const ticket = getDb().prepare(
    'SELECT * FROM client_tickets WHERE id = ? AND user_id = ?'
  ).get(req.params.id, userId) as TicketRow | undefined;

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }

  res.json({ ticket: { ...ticket, messages: JSON.parse(ticket.messages || '[]') } });
});

// ── Close ticket (with AI summary) ───────────────────────────────────────

router.post('/client-tickets/:id/close', async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const ticket = getDb().prepare(
    'SELECT * FROM client_tickets WHERE id = ? AND user_id = ?'
  ).get(req.params.id, userId) as TicketRow | undefined;

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }

  if (ticket.status !== 'open') {
    res.status(400).json({ error: 'Ticket is not open' });
    return;
  }

  const messages = JSON.parse(ticket.messages || '[]');

  // Generate summary and suggestions via AI
  let summary = '';
  let suggestions = '';
  try {
    const models = await getModelsForMode('fast');
    if (models.length > 0) {
      const conversationText = messages.map((m: { role: string; content: string }) =>
        `[${m.role}]: ${m.content}`
      ).join('\n');

      const summaryResult = await generateText({
        model: models[0].model,
        system: `Summarize the following client conversation. Extract:
1. A brief summary (2-3 sentences) of what the client needs
2. A list of actionable suggestions (bullet points) for the project owner to perform

Respond in JSON format: { "summary": "...", "suggestions": "... (bullet points)" }`,
        prompt: conversationText,
      });

      try {
        const parsed = JSON.parse(summaryResult.text);
        summary = parsed.summary || 'Client request completed.';
        suggestions = parsed.suggestions || 'No specific suggestions.';
      } catch {
        summary = summaryResult.text.slice(0, 300);
        suggestions = 'Review the conversation for details.';
      }
    }
  } catch {
    summary = 'Client conversation completed.';
    suggestions = 'Review the conversation for action items.';
  }

  getDb().prepare(
    `UPDATE client_tickets SET status = 'closed', summary = ?, suggestions = ?, closed_at = datetime('now') WHERE id = ?`
  ).run(summary, suggestions, ticket.id);

  const updated = getDb().prepare('SELECT * FROM client_tickets WHERE id = ?').get(ticket.id) as TicketRow;

  // Notify user via WebSocket
  userClientManager.pushChatContent(userId, 'client_ticket_closed', {
    ticketId: ticket.id,
    uid: ticket.uid,
    summary,
  });

  res.json({ ticket: { ...updated, messages: JSON.parse(updated.messages || '[]') } });
});

// ── Reopen ticket ────────────────────────────────────────────────────────

router.post('/client-tickets/:id/reopen', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const ticket = getDb().prepare(
    'SELECT * FROM client_tickets WHERE id = ? AND user_id = ?'
  ).get(req.params.id, userId) as TicketRow | undefined;

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }

  getDb().prepare(
    "UPDATE client_tickets SET status = 'open', closed_at = NULL WHERE id = ?"
  ).run(ticket.id);

  const updated = getDb().prepare('SELECT * FROM client_tickets WHERE id = ?').get(ticket.id) as TicketRow;
  res.json({ ticket: { ...updated, messages: JSON.parse(updated.messages || '[]') } });
});

// ── Delete ticket ────────────────────────────────────────────────────────

router.delete('/client-tickets/:id', (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.userId;

  const ticket = getDb().prepare(
    'SELECT * FROM client_tickets WHERE id = ? AND user_id = ?'
  ).get(req.params.id, userId) as TicketRow | undefined;

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }

  getDb().prepare('DELETE FROM client_tickets WHERE id = ?').run(ticket.id);
  res.json({ success: true });
});

// ── Public routes (no auth required) ─────────────────────────────────────

// Get public ticket info
router.get('/client-ticket/:uid', (req: Request, res: Response) => {
  const { uid } = req.params;
  const ticket = getDb().prepare(
    "SELECT uid, company_name, project_name, goal, messages, status, created_at FROM client_tickets WHERE uid = ? AND status = 'open'"
  ).get(uid) as Pick<TicketRow, 'uid' | 'company_name' | 'project_name' | 'goal' | 'messages' | 'status' | 'created_at'> | undefined;

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found or no longer active.' });
    return;
  }

  res.json({
    ticket: {
      ...ticket,
      messages: JSON.parse(ticket.messages || '[]'),
    },
  });
});

// Client sends a message (AI responds automatically)
router.post('/client-ticket/:uid/message', async (req: Request, res: Response) => {
  const { uid } = req.params;
  const { message } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  const ticket = getDb().prepare(
    "SELECT * FROM client_tickets WHERE uid = ? AND status = 'open'"
  ).get(uid) as TicketRow | undefined;

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found or no longer active.' });
    return;
  }

  const messages = JSON.parse(ticket.messages || '[]');

  // Add client message
  messages.push({
    role: 'user',
    content: message.trim(),
    timestamp: new Date().toISOString(),
  });

  // Generate AI response
  let aiResponse = '';
  try {
    const models = await getModelsForMode('fast');
    if (models.length > 0) {
      const conversationHistory = messages.map((m: { role: string; content: string }) =>
        `[${m.role}]: ${m.content}`
      ).join('\n');

      const result = await generateText({
        model: models[0].model,
        system: `You are SUNy, an AI assistant working on behalf of ${ticket.company_name}. 
You are talking to a client about a project. Rules:
- Be friendly, professional, and helpful
- Focus ONLY on understanding the client's needs for their project
- Ask clarifying questions to understand what they want
- NEVER mention costs, pricing, models, AI tools, or technical implementation details
- NEVER mention that you are an AI or language model
- Keep responses concise and conversational
- The project goal is: ${ticket.goal}
- Project name: ${ticket.project_name || 'Unnamed Project'}`,
        prompt: `Conversation so far:\n${conversationHistory}\n\n[user]: ${message.trim()}\n\nRespond as SUNy:`,
      });
      aiResponse = result.text.trim();
    } else {
      aiResponse = `Thanks for your message! Could you tell me more about what you're looking for regarding: "${ticket.goal}"?`;
    }
  } catch (e) {
    aiResponse = `Got it! Is there anything else you'd like to share about your needs for this project?`;
  }

  // Add AI response
  messages.push({
    role: 'assistant',
    content: aiResponse,
    timestamp: new Date().toISOString(),
  });

  // Save to DB
  getDb().prepare(
    'UPDATE client_tickets SET messages = ? WHERE uid = ?'
  ).run(JSON.stringify(messages), uid);

  // Notify the ticket owner about the new message
  userClientManager.pushChatContent(ticket.user_id, 'client_ticket_message', {
    ticketId: ticket.id,
    uid: ticket.uid,
    preview: message.trim().slice(0, 100),
  });

  res.json({
    success: true,
    message: aiResponse,
  });
});

// Client confirms the ticket
router.post('/client-ticket/:uid/confirm', async (req: Request, res: Response) => {
  const { uid } = req.params;

  const ticket = getDb().prepare(
    "SELECT * FROM client_tickets WHERE uid = ? AND status = 'open'"
  ).get(uid) as TicketRow | undefined;

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found or no longer active.' });
    return;
  }

  const messages = JSON.parse(ticket.messages || '[]');

  // Add confirmation message
  messages.push({
    role: 'user',
    content: 'I confirm that I have shared all the details about what I need. Please proceed.',
    timestamp: new Date().toISOString(),
  });

  // Generate closing message from AI
  let closingMessage = '';
  try {
    const models = await getModelsForMode('fast');
    if (models.length > 0) {
      const conversationText = messages.map((m: { role: string; content: string }) =>
        `[${m.role}]: ${m.content}`
      ).join('\n');

      const result = await generateText({
        model: models[0].model,
        system: `Generate a friendly closing message thanking the client for their time and confirming 
that their request has been noted. The project owner will review everything and follow up.
Do not mention costs, models, or technical details. Keep it warm and professional.`,
        prompt: conversationText,
      });
      closingMessage = result.text.trim();
    }
  } catch {
    closingMessage = `Thank you so much for sharing all the details! I've noted everything and ${ticket.company_name} will review your request and follow up with you. Have a great day! 😊`;
  }

  messages.push({
    role: 'assistant',
    content: closingMessage,
    timestamp: new Date().toISOString(),
  });

  // Auto-generate summary and close
  let summary = '';
  let suggestions = '';
  try {
    const models = await getModelsForMode('fast');
    if (models.length > 0) {
      const conversationText = messages.map((m: { role: string; content: string }) =>
        `[${m.role}]: ${m.content}`
      ).join('\n');

      const sumResult = await generateText({
        model: models[0].model,
        system: `Summarize this client conversation. Respond in JSON: 
{ "summary": "2-3 sentence summary of what the client needs", 
  "suggestions": "bullet points of actionable items for the project owner" }`,
        prompt: conversationText,
      });

      try {
        const parsed = JSON.parse(sumResult.text);
        summary = parsed.summary || 'Client request confirmed.';
        suggestions = parsed.suggestions || '';
      } catch {
        summary = 'Client confirmed their requirements.';
      }
    }
  } catch {
    summary = 'Client confirmed their request.';
  }

  getDb().prepare(
    `UPDATE client_tickets SET messages = ?, status = 'closed', summary = ?, suggestions = ?, closed_at = datetime('now') WHERE uid = ?`
  ).run(JSON.stringify(messages), summary, suggestions, uid);

  // Notify owner
  userClientManager.pushChatContent(ticket.user_id, 'client_ticket_closed', {
    ticketId: ticket.id,
    uid: ticket.uid,
    summary: summary || 'Client confirmed their request.',
  });

  res.json({
    success: true,
    message: closingMessage,
    summary,
    suggestions,
  });
});

export default router;
