/**
 * suny-chat-widget.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Public-facing chat endpoint for the Technodel SUNy widget.
 * No auth required — rate-limited per IP (20 msgs/hour).
 * LLM waterfall: DeepSeek → Groq → OpenRouter
 * Technodel tech-expert persona injected by default.
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from './db';

const router = Router();

// ── Rate limit: 20 messages per IP per hour ────────────────────────────────
const widgetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many messages. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0])?.trim() || req.ip || 'unknown';
    }
    return req.ip || 'unknown';
  },
});

// ── Default Technodel system prompt ────────────────────────────────────────
const DEFAULT_SYSTEM_PROMPT = `You are SUNy, the expert AI tech assistant for Technodel — Lebanon's #1 tech store at technodel.net.

You are a world-class expert in:
- PC building: component compatibility, budget/mid-range/high-end builds, bottlenecks, upgrade paths
- Graphics cards (GPUs): benchmarks, VRAM requirements, gaming vs workstation, AMD vs NVIDIA, current-gen comparisons
- Power supplies (PSUs): wattage calculation, 80+ efficiency ratings (Bronze/Gold/Platinum), brand reliability (Corsair, EVGA, Seasonic, be quiet!), modular vs non-modular
- CPUs: Intel vs AMD, core/thread counts, thermal design, socket compatibility
- RAM: DDR4 vs DDR5, speeds, dual-channel, XMP/EXPO profiles
- Storage: NVMe vs SATA SSD, HDD, M.2 slots, PCIe gen 4 vs 5
- Cooling: air vs AIO liquid coolers, TDP ratings, case airflow
- Networking: routers, switches, Wi-Fi 6/6E/7, fiber, Ethernet, mesh systems, VPN hardware
- Monitors: resolution, refresh rate, panel types (IPS/VA/TN/OLED), G-Sync/FreeSync
- Laptops: gaming vs business vs ultrabooks, GPU MX vs dedicated, thermal throttling
- Lebanon's computer market: pricing in USD (Lebanese market), import availability, local supplier context

You help Technodel customers find the right products. Be friendly, concise, and technically precise.
When recommending products, mention that Technodel carries a wide range — direct them to technodel.net.
Never fabricate specific prices — say "check technodel.net for current pricing in Lebanon".
Answer in the same language the user writes in (Arabic or English).
Keep responses under 300 words unless the user asks for details.

CRITICAL INSTRUCTION: If the user asks a question or gives a task that is NOT about tech, NOT about PC building, and NOT related to website products, you MUST politely decline.
You must tell them something like: "I am SUNy, a fully autonomous AI agent. I can do many tasks and answer any question, but here I am focused on tech. To get in touch or learn more about my full capabilities, visit {SUNY_PAGE_URL}"
(Replace {SUNY_PAGE_URL} with the actual URL provided in the context, or suny.technodel.tech if none is provided.)`;

// ── Fetch widget config from DB ────────────────────────────────────────────
function getWidgetConfig() {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM suny_widget_config WHERE id = 1').get() as {
      bot_name: string;
      logo_url: string;
      system_prompt: string;
      enabled: number;
      deepseek_key: string | null;
      groq_key: string | null;
      openrouter_key: string | null;
      serper_key: string | null;
      suny_page_url: string;
    } | undefined;
    return row || null;
  } catch {
    return null;
  }
}

// ── Call DeepSeek ──────────────────────────────────────────────────────────
async function callDeepSeek(apiKey: string, systemPrompt: string, messages: { role: string; content: string }[]) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: 600,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`DeepSeek ${response.status}`);
  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return { reply: data.choices[0]?.message?.content?.trim() || '', model: 'deepseek-chat' };
}

// ── Call Groq ──────────────────────────────────────────────────────────────
async function callGroq(apiKey: string, systemPrompt: string, messages: { role: string; content: string }[]) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: 600,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Groq ${response.status}`);
  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return { reply: data.choices[0]?.message?.content?.trim() || '', model: 'groq/llama-3.3-70b' };
}

// ── Call OpenRouter ────────────────────────────────────────────────────────
async function callOpenRouter(apiKey: string, systemPrompt: string, messages: { role: string; content: string }[]) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://technodel.net',
      'X-Title': 'SUNy - Technodel Tech Assistant',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat-v3-0324:free',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: 600,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return { reply: data.choices[0]?.message?.content?.trim() || '', model: 'openrouter/deepseek-chat' };
}

// ── Main chat endpoint ─────────────────────────────────────────────────────
router.post('/suny-chat', widgetLimiter, async (req: Request, res: Response) => {
  try {
    const { messages, context } = req.body as {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      context?: { page?: string; product?: string; category?: string };
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'messages array is required' });
      return;
    }

    // Validate & sanitize
    const sanitized = messages
      .slice(-10) // last 10 messages only
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

    if (sanitized.length === 0 || sanitized[sanitized.length - 1].role !== 'user') {
      res.status(400).json({ error: 'Last message must be from user' });
      return;
    }

    // Get config from DB (or defaults)
    const config = getWidgetConfig();
    let systemPrompt = config?.system_prompt || DEFAULT_SYSTEM_PROMPT;

    // Inject page context if provided
    if (context?.product) {
      systemPrompt += `\n\n[Current page context: The user is viewing the product "${context.product}" on Technodel. Reference it naturally if relevant.]`;
    } else if (context?.category) {
      systemPrompt += `\n\n[Current page context: The user is browsing the "${context.category}" category on Technodel.]`;
    }
    
    // Inject SUNy URL
    const sunyUrl = config?.suny_page_url || 'https://suny.technodel.tech';
    systemPrompt = systemPrompt.replace(/\{SUNY_PAGE_URL\}/g, sunyUrl);

    // Get API keys: prefer DB config, fallback to env
    const deepseekKey = config?.deepseek_key || process.env.DEEPSEEK_API_KEY;
    const groqKey = config?.groq_key || process.env.GROQ_API_KEY;
    const openrouterKey = config?.openrouter_key || process.env.OPENROUTER_API_KEY;

    // LLM waterfall
    const errors: string[] = [];

    if (deepseekKey) {
      try {
        const result = await callDeepSeek(deepseekKey, systemPrompt, sanitized);
        if (result.reply) {
          res.json({ reply: result.reply, model: result.model });
          return;
        }
      } catch (e) {
        errors.push(`DeepSeek: ${(e as Error).message}`);
        console.warn('[suny-widget] DeepSeek failed:', (e as Error).message);
      }
    }

    if (groqKey) {
      try {
        const result = await callGroq(groqKey, systemPrompt, sanitized);
        if (result.reply) {
          res.json({ reply: result.reply, model: result.model });
          return;
        }
      } catch (e) {
        errors.push(`Groq: ${(e as Error).message}`);
        console.warn('[suny-widget] Groq failed:', (e as Error).message);
      }
    }

    if (openrouterKey) {
      try {
        const result = await callOpenRouter(openrouterKey, systemPrompt, sanitized);
        if (result.reply) {
          res.json({ reply: result.reply, model: result.model });
          return;
        }
      } catch (e) {
        errors.push(`OpenRouter: ${(e as Error).message}`);
        console.warn('[suny-widget] OpenRouter failed:', (e as Error).message);
      }
    }

    // All providers failed
    console.error('[suny-widget] All providers failed:', errors);
    res.status(503).json({
      error: 'AI service temporarily unavailable. Please try again.',
      reply: "I'm having trouble connecting right now. Please try again in a moment, or contact Technodel directly at technodel.net! 🤖",
    });
  } catch (err) {
    console.error('[suny-widget] Unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Widget config endpoint (public GET — returns safe config) ──────────────
router.get('/suny-widget-config', (_req: Request, res: Response) => {
  try {
    const config = getWidgetConfig();
    if (!config) {
      res.json({
        bot_name: 'SUNy',
        logo_url: '/SLOGO.png',
        enabled: true,
        suny_page_url: 'https://suny.technodel.tech'
      });
      return;
    }
    // Return only public-safe fields (no API keys)
    res.json({
      bot_name: config.bot_name || 'SUNy',
      logo_url: config.logo_url || '/SLOGO.png',
      enabled: config.enabled !== 0,
      suny_page_url: config.suny_page_url || 'https://suny.technodel.tech'
    });
  } catch {
    res.json({ bot_name: 'SUNy', logo_url: '/SLOGO.png', enabled: true, suny_page_url: 'https://suny.technodel.tech' });
  }
});

export default router;
