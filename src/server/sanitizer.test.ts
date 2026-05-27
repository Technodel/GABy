import { describe, it, expect } from 'vitest';
import {
  sanitizeForUser,
  sanitizeForChatContent,
  friendlyError,
  buildUserEvent,
  buildChatEvent,
} from './sanitizer';

// â”€â”€â”€ sanitizeForUser (full sanitization: keys + string patterns) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('sanitizeForUser', () => {
  it('should strip blocked keys from objects', () => {
    const result = sanitizeForUser({ message: 'hello', model: 'gpt-4', inputTokens: 150 });
    expect(result).toEqual({ message: 'hello' });
  });

  it('should replace model names in strings', () => {
    const result = sanitizeForUser('Using claude to generate response');
    expect(result).toBe('Using [SUNy] to generate response');
  });

  it('should replace provider names in strings', () => {
    const result = sanitizeForUser('Called openai api');
    expect(result).toBe('Called [SUNy] api');
  });

  it('should sanitize nested objects recursively', () => {
    const result = sanitizeForUser({
      status: 'ok',
      details: { provider: 'anthropic', model: 'claude-3-haiku', cost: 0.005 },
    });
    // provider and model are blocked keys; cost is NOT blocked (only rawCost, chargedCost, etc.)
    expect(result).toEqual({ status: 'ok', details: { cost: 0.005 } });
  });

  it('should sanitize arrays recursively', () => {
    const result = sanitizeForUser([
      { message: 'Hello', model: 'gpt-4' },
      { message: 'World', provider: 'openai' },
    ]);
    expect(result).toEqual([{ message: 'Hello' }, { message: 'World' }]);
  });

  it('should pass through primitives unchanged', () => {
    expect(sanitizeForUser(42)).toBe(42);
    expect(sanitizeForUser('plain string')).toBe('plain string');
    expect(sanitizeForUser(null)).toBe(null);
    expect(sanitizeForUser(undefined)).toBe(undefined);
    expect(sanitizeForUser(true)).toBe(true);
  });

  it('should replace token-related patterns in strings', () => {
    const result = sanitizeForUser('Cost: $0.003 / 1K tokens');
    expect(result).toBe('Cost: $0.003 / 1K [SUNy]');
  });

  it('should replace "LLM" and "large language model"', () => {
    expect(sanitizeForUser('LLM response')).toBe('[SUNy] response');
    expect(sanitizeForUser('large language model output')).toBe('[SUNy] output');
  });
});

// â”€â”€â”€ sanitizeForChatContent (key-only sanitization) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('sanitizeForChatContent', () => {
  it('should strip blocked keys but keep string values intact', () => {
    const result = sanitizeForChatContent({
      content: 'I am using Claude to help you',
      model: 'claude-3-sonnet',
    });
    expect(result).toEqual({ content: 'I am using Claude to help you' });
  });

  it('should pass through strings unchanged', () => {
    const result = sanitizeForChatContent('Using GPT-4 for this response');
    expect(result).toBe('Using GPT-4 for this response');
  });


});

// â”€â”€â”€ friendlyError â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('friendlyError', () => {
  it('should handle API key errors', () => {
    expect(friendlyError(new Error('invalid_api_key'))).toContain('trouble connecting');
  });

  it('should handle 401 errors', () => {
    expect(friendlyError(new Error('401 Unauthorized'))).toContain('trouble connecting');
  });

  it('should handle rate limit errors', () => {
    expect(friendlyError(new Error('rate_limit exceeded'))).toContain('quick breather');
  });

  it('should handle 429 errors', () => {
    expect(friendlyError(new Error('429 Too Many Requests'))).toContain('quick breather');
  });

  it('should handle balance errors', () => {
    expect(friendlyError(new Error('insufficient balance'))).toContain('out of credits');
  });

  it('should handle timeout errors', () => {
    expect(friendlyError(new Error('Request timed out'))).toContain('longer than usual');
  });

  it('should handle network errors', () => {
    expect(friendlyError(new Error('ECONNREFUSED'))).toContain('network');
  });

  it('should handle unknown errors gracefully', () => {
    expect(friendlyError(new Error('Something weird happened'))).toContain('unexpected');
  });

  it('should handle non-Error inputs', () => {
    expect(friendlyError('just a string')).toContain('unexpected');
    expect(friendlyError(null)).toContain('unexpected');
  });
});

// â”€â”€â”€ buildUserEvent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('buildUserEvent', () => {
  it('should produce valid JSON with sanitized payload', () => {
    const json = buildUserEvent('test:event', { message: 'hello', model: 'gpt-4' });
    const parsed = JSON.parse(json);
    expect(parsed.event).toBe('test:event');
    expect(parsed.message).toBe('hello');
    expect(parsed.model).toBeUndefined();
  });

  it('should sanitize string values in payload', () => {
    const json = buildUserEvent('status:update', { message: 'Using claude' });
    const parsed = JSON.parse(json);
    expect(parsed.message).toBe('Using [SUNy]');
  });
});

// â”€â”€â”€ buildChatEvent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('buildChatEvent', () => {
  it('should produce valid JSON with key-only sanitization', () => {
    const json = buildChatEvent('suny:stream_chunk', {
      content: 'Using Claude to help',
      model: 'claude-3-haiku',
    });
    const parsed = JSON.parse(json);
    expect(parsed.event).toBe('suny:stream_chunk');
    expect(parsed.content).toBe('Using Claude to help');
    expect(parsed.model).toBeUndefined(); // key stripped
  });
});
