/**
 * token-saving-engine.test.ts — Unit tests for the token-saving engine.
 *
 * Tests all 5 strategies:
 *   1. XML Comment/Boilerplate Compression
 *   2. Tool Schema Pruning
 *   3. Selective Tool-Call Compression
 *   4. Redundant File Content Dedup
 *   5. Multilingual Boilerplate Stripping
 *
 * Run: npx vitest run src/server/token-saving-engine.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  optimizeForTokens,
  logTokenSavingStats,
  resetFileCache,
  type TokenSavingEngineOpts,
} from './token-saving-engine';
import type { CoreMessage } from 'ai';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMsg(role: CoreMessage['role'], content: string | any[]): CoreMessage {
  return { role, content } as CoreMessage;
}

function makeUserMsg(content: string): CoreMessage {
  return makeMsg('user', content);
}

function makeAssistantMsg(content: string): CoreMessage {
  return makeMsg('assistant', content);
}

function makeToolCallMsg(toolName: string, args: Record<string, any>): CoreMessage {
  return makeMsg('assistant', [
    { type: 'tool-call', toolName, args, toolCallId: `call_${Date.now()}` },
  ] as any);
}

function makeToolResultMsg(content: string, toolName?: string): CoreMessage {
  return makeMsg('tool', [
    { type: 'tool-result', toolName: toolName || 'file_read', content, toolCallId: `call_${Date.now()}` },
  ] as any);
}

const defaultOpts: TokenSavingEngineOpts = {
  messages: [],
  systemPrompt: '',
  provider: 'Anthropic',
  allToolNames: [],
};

function run(opts: Partial<TokenSavingEngineOpts>) {
  return optimizeForTokens({ ...defaultOpts, ...opts });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Strategy 1: XML Comment/Boilerplate Compression', () => {
  it('compresses box-drawing comment blocks in system prompt', () => {
    const systemPrompt = [
      '╔════════════════════════════════╗',
      '║  SOME HEADER TEXT              ║',
      '╚════════════════════════════════╝',
      'Normal instruction line here.',
      '╔════════════════════════════════╗',
      '║  ANOTHER SECTION               ║',
      '╚════════════════════════════════╝',
      'More normal content.',
    ].join('\n');

    const result = run({ systemPrompt });
    expect(result.systemPrompt).toContain('─── SOME HEADER TEXT ───');
    expect(result.systemPrompt).toContain('─── ANOTHER SECTION ───');
    expect(result.systemPrompt).not.toContain('╔══════════════');
    expect(result.systemPrompt).toContain('Normal instruction line here.');
    expect(result.systemPrompt).toContain('More normal content.');
  });

  it('returns unchanged prompt when no box-drawing found', () => {
    const prompt = 'Just a plain prompt.\nNo box art here.\n';
    const result = run({ systemPrompt: prompt });
    expect(result.systemPrompt).toBe(prompt);
  });

  it('never crashes on malformed input', () => {
    const result = run({ systemPrompt: null as unknown as string });
    // The result should have stats but not crash
    expect(Array.isArray(result.stats)).toBe(true);
  });
});

describe('Strategy 2: Tool Schema Pruning', () => {
  it('prunes write/edit tools for question-type tasks', () => {
    const messages = [makeUserMsg('What is the capital of France?')];
    const allToolNames = ['file_write', 'file_edit', 'web_search', 'read_file', 'bash'];
    const result = run({ messages, allToolNames, taskType: 'question' });

    expect(result.prunedTools).toBeDefined();
    expect(result.prunedTools!.length).toBeGreaterThan(0);
    expect(result.prunedTools).toContain('file_write');
    expect(result.prunedTools).toContain('file_edit');
    expect(result.prunedTools).not.toContain('web_search');
  });

  it('returns undefined prunedTools when allToolNames is empty', () => {
    const result = run({ allToolNames: [] });
    expect(result.prunedTools).toBeUndefined();
  });

  it('returns undefined prunedTools when allToolNames is undefined', () => {
    const result = run({ allToolNames: undefined });
    expect(result.prunedTools).toBeUndefined();
  });

  it('prunes heavily for chat type', () => {
    const messages = [makeUserMsg('hi')];
    const allToolNames = ['web_search', 'file_read', 'file_write', 'bash', 'url_fetch', 'grep_search'];
    const result = run({ messages, allToolNames, taskType: undefined });

    // 'hi' should be classified as 'chat'
    expect(result.prunedTools).toBeDefined();
    expect(result.prunedTools!.length).toBeGreaterThan(2);
    expect(result.prunedTools).toContain('file_write');
    expect(result.prunedTools).toContain('bash');
  });
});

describe('Strategy 3: Selective Tool-Call Compression', () => {
  beforeEach(() => {
    // No cross-cache state needed for this test
  });

  it('does not compress when there are few user turns', () => {
    const messages: CoreMessage[] = [
      makeAssistantMsg('Hello, how can I help?'),
      makeUserMsg('Turn 1: do something'),
      makeToolCallMsg('file_read', { path: '/test.txt' }),
      makeToolResultMsg('file content here'),
      makeAssistantMsg('Done reading.'),
    ];
    const result = run({ messages });
    // The result messages should be the same length (not compressed since turns <= 3)
    expect(result.messages.length).toBe(messages.length);
  });

  it('compresses tool calls in old turns beyond the adaptive threshold', () => {
    // Create many user turns to trigger compression
    const messages: CoreMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeUserMsg(`Turn ${i}: read file ${i}.txt`));
      messages.push(makeToolCallMsg('file_read', { path: `/file${i}.txt` }));
      messages.push(makeToolResultMsg(`Content of file ${i}`));
      messages.push(makeAssistantMsg(`Done with turn ${i}.`));
    }

    const result = run({ messages });
    // Some old tool-call parts should be compressed (content stays array but tool-call becomes text)
    const hasCompressedTool = result.messages.some(
      m => m.role === 'assistant' && Array.isArray(m.content) && JSON.stringify(m.content).includes('[tool:'),
    );
    expect(hasCompressedTool).toBe(true);
  });

  it('keeps recent turns intact', () => {
    const messages: CoreMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeUserMsg(`Turn ${i}`));
      messages.push(makeToolCallMsg('bash', { command: `echo ${i}` }));
      messages.push(makeToolResultMsg(`result ${i}`));
      messages.push(makeAssistantMsg(`Done ${i}.`));
    }

    const result = run({ messages });
    // The last 3 user turns should still have original tool-call objects
    let userTurnsFound = 0;
    for (const msg of result.messages) {
      if (msg.role === 'user') userTurnsFound++;
      // The last 3 user turns' assistant messages should still have array content
      if (msg.role === 'assistant' && Array.isArray(msg.content) && userTurnsFound > 7) {
        // This is one of the last 3 turns — should have original tool-call parts
        const hasToolCall = msg.content.some((p: any) => p.type === 'tool-call');
        expect(hasToolCall).toBe(true);
      }
    }
  });
});

describe('Strategy 4: Redundant File Content Dedup', () => {
  beforeEach(() => {
    resetFileCache();
  });

  it('replaces duplicate file content with reference', () => {
    const largeContent = 'x'.repeat(600); // > 500 chars threshold
    const messages: CoreMessage[] = [
      makeUserMsg('Read file a.txt'),
      makeToolResultMsg(largeContent, 'file_read'),
      makeUserMsg('Read file b.txt'),
      // Same content as a.txt — should be deduped
      makeToolResultMsg(largeContent, 'file_read'),
    ];

    const result = run({ messages });
    // Find the second tool result
    let toolResultCount = 0;
    for (const msg of result.messages) {
      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        toolResultCount++;
        if (toolResultCount === 2) {
          const toolResult = msg.content.find((p: any) => p.type === 'tool-result');
          const content = (toolResult && toolResult.content) || '';
          expect(content).toContain('[Same content');
        }
      }
    }
  });

  it('does not dedupe small content (< 500 chars)', () => {
    const smallContent = 'small content';
    const messages: CoreMessage[] = [
      makeUserMsg('Read short file'),
      makeToolResultMsg(smallContent, 'file_read'),
      makeToolResultMsg(smallContent, 'file_read'),
    ];

    const result = run({ messages });
    // Both should still be intact (below threshold)
    let toolContentCount = 0;
    for (const msg of result.messages) {
      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        toolContentCount++;
      }
    }
    expect(toolContentCount).toBe(2);
  });

  it('cross-turn cache works across optimizeForTokens calls', () => {
    resetFileCache();
    const largeContent = 'y'.repeat(600);

    // First call
    run({
      messages: [makeToolResultMsg(largeContent, 'file_read'), makeUserMsg('done')],
    });

    // Second call with same content — should be deduped
    const result = run({
      messages: [makeToolResultMsg(largeContent, 'file_read'), makeUserMsg('again')],
    });

    const firstTool = result.messages.find(
      m => m.role === 'tool' && Array.isArray(m.content),
    );
    if (firstTool && Array.isArray(firstTool.content)) {
      const text = JSON.stringify(firstTool.content);
      expect(text).toContain('[Same content');
    }
  });
});

describe('Strategy 5: Multilingual Boilerplate Stripping', () => {
  it('strips English opening boilerplate', () => {
    const messages = [
      makeAssistantMsg('Sure! Here is the answer to your question about TypeScript.'),
      makeUserMsg('thanks'),
    ];
    const result = run({ messages });
    expect(result.messages[0].content).not.toContain('Sure!');
  });

  it('strips English closing boilerplate', () => {
    const messages = [
      makeAssistantMsg('The answer is 42. Let me know if you need anything else!'),
      makeUserMsg('ok'),
    ];
    const result = run({ messages });
    expect(result.messages[0].content).not.toContain('Let me know if you need anything else');
  });

  it('strips French boilerplate', () => {
    const messages = [
      makeAssistantMsg('Bien sûr! Voici la réponse à votre question.'),
      makeUserMsg('merci'),
    ];
    const result = run({ messages });
    expect(result.messages[0].content).not.toContain('Bien sûr');
  });

  it('strips Spanish boilerplate', () => {
    const messages = [
      makeAssistantMsg('Claro! Aquí tienes la respuesta. No dude en preguntar si necesita algo más.'),
      makeUserMsg('gracias'),
    ];
    const result = run({ messages });
    expect(result.messages[0].content).not.toContain('Claro');
    expect(result.messages[0].content).not.toContain('No dude en preguntar');
  });

  it('strips Arabic boilerplate', () => {
    const messages = [
      makeAssistantMsg('طبعا! هذا هو الجواب.'),
      makeUserMsg('شكرا'),
    ];
    const result = run({ messages });
    expect(result.messages[0].content).not.toContain('طبعا');
  });

  it('strips German boilerplate', () => {
    const messages = [
      makeAssistantMsg('Natürlich! Hier ist die Antwort. Zögern Sie nicht, zu fragen.'),
      makeUserMsg('danke'),
    ];
    const result = run({ messages });
    expect(result.messages[0].content).not.toContain('Natürlich');
    expect(result.messages[0].content).not.toContain('Zögern Sie nicht');
  });

  it('preserves meaningful content after stripping', () => {
    const messages = [
      makeAssistantMsg('Sure! Here is a detailed explanation: TypeScript is a typed superset of JavaScript.'),
    ];
    const result = run({ messages });
    const content = result.messages[0].content as string;
    expect(content).toContain('TypeScript');
    expect(content).toContain('typed superset');
  });
});

describe('Main Entry Point: optimizeForTokens', () => {
  it('returns original messages when engine fails gracefully', () => {
    const result = run({ provider: null as unknown as string });
    expect(result.messages).toBeDefined();
    expect(Array.isArray(result.stats)).toBe(true);
  });

  it('reports stats with saved tokens', () => {
    const systemPrompt = [
      '╔════════════════════════════════╗',
      '║  HEADER                        ║',
      '╚════════════════════════════════╝',
      'Normal content.',
    ].join('\n');
    const result = run({ systemPrompt });
    const xmlStats = result.stats.find(s => s.strategyName === 'XmlBoilerplateCompression');
    expect(xmlStats).toBeDefined();
    expect(xmlStats!.tokensSaved).toBeGreaterThan(0);
  });

  it('returns stats array even when no savings occur', () => {
    const result = run({});
    expect(Array.isArray(result.stats)).toBe(true);
  });
});

describe('logTokenSavingStats', () => {
  it('does not throw when called with empty stats', () => {
    expect(() => logTokenSavingStats([])).not.toThrow();
  });

  it('does not throw when called with empty stats', () => {
    expect(() => logTokenSavingStats([])).not.toThrow();
  });

  it('logs stats with positive savings', () => {
    const stats = [{ strategyName: 'Test', tokensBefore: 100, tokensAfter: 50, tokensSaved: 50 }];
    expect(() => logTokenSavingStats(stats)).not.toThrow();
  });
});

describe('Provider-aware token estimation', () => {
  it('handles Anthropic provider', () => {
    const messages = [makeUserMsg('x'.repeat(320))]; // ~100 tokens at 3.2 chars/token
    const result = run({ messages, provider: 'Anthropic' });
    expect(result.messages).toBeDefined();
  });

  it('handles OpenAI provider', () => {
    const messages = [makeUserMsg('x'.repeat(400))]; // ~100 tokens at 4.0 chars/token
    const result = run({ messages, provider: 'OpenAI' });
    expect(result.messages).toBeDefined();
  });

  it('handles unknown provider with default ratio', () => {
    const messages = [makeUserMsg('test')];
    const result = run({ messages, provider: 'UnknownProvider123' });
    expect(result.messages).toBeDefined();
  });
});

describe('Edge cases', () => {
  it('handles empty messages array', () => {
    const result = run({ messages: [] });
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBe(0);
  });

  it('handles empty system prompt', () => {
    const result = run({ systemPrompt: '' });
    expect(result.systemPrompt).toBe('');
  });

  it('handles mixed content messages', () => {
    const messages: CoreMessage[] = [
      makeUserMsg('Hello'),
      makeMsg('assistant', [
        { type: 'text', text: 'Here is some ' },
        { type: 'image', image: 'data:image/png;base64,abc123' },
        { type: 'text', text: ' content' },
      ] as any),
    ];
    const result = run({ messages });
    expect(result.messages.length).toBe(2);
  });

  it('preserves message order after optimization', () => {
    const messages: CoreMessage[] = [
      makeUserMsg('First'),
      makeAssistantMsg('First response.'),
      makeUserMsg('Second'),
      makeAssistantMsg('Second response.'),
      makeUserMsg('Third'),
    ];
    const result = run({ messages });
    // Check order is preserved
    for (let i = 0; i < messages.length; i++) {
      const origRole = messages[i].role;
      const resultRole = result.messages[i].role;
      expect(resultRole).toBe(origRole);
    }
  });
});

describe('Cross-turn cache management', () => {
  beforeEach(() => {
    resetFileCache();
  });

  it('resetFileCache clears all cached entries', () => {
    const largeContent = 'z'.repeat(600);
    run({ messages: [makeToolResultMsg(largeContent, 'file_read'), makeUserMsg('first')] });
    resetFileCache();

    // After reset, same content should NOT be deduped
    const result = run({ messages: [makeToolResultMsg(largeContent, 'file_read'), makeUserMsg('again')] });
    const toolMsg = result.messages.find(m => m.role === 'tool');
    if (toolMsg && typeof toolMsg.content !== 'string') {
      const text = JSON.stringify(toolMsg.content);
      expect(text).not.toContain('[Same content');
    }
  });
});
