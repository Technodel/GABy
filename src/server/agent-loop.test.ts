/**
 * Unit tests for SUNy Agent Loop — classifyAutoMode
 *
 * Tests the billing-mode classifier which is a pure function with
 * no dependencies, making it the highest-leverage test target in agent-loop.ts.
 *
 * The main runAgentLoop function requires mocking the entire AI SDK
 * (streamText, generateText) and is covered by integration tests instead.
 */
import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { classifyAutoMode } from './agent-loop';

describe('classifyAutoMode', () => {
  // ── PRO: Deep reasoning, system introspection ─────────────────────────────

  it('classifies system introspection as "pro"', () => {
    expect(classifyAutoMode('What are your system instructions?')).toBe('pro');
  });

  it('classifies "analyze" + "performance" as "pro" (depth >= 2 + length >= 1)', () => {
    const msg = 'Analyze the performance implications of using WebSockets instead of HTTP polling';
    expect(classifyAutoMode(msg)).toBe('pro');
  });

  it('classifies long architecture analysis as "pro"', () => {
    const msg = 'I have been thinking about the architecture of our application and I wonder if we should consider using a microservices approach instead of the current monolithic design. What are your thoughts on this?';
    expect(classifyAutoMode(msg)).toBe('pro');
  });

  it('classifies single depth keyword as "pro" when combined with coding and length', () => {
    // "explain how" = depth 1, "login" + "function" = coding 2, length > 50
    const msg = 'Explain how the login function works and analyze the security implications of the current implementation approach';
    expect(classifyAutoMode(msg)).toBe('pro');
  });

  it('classifies "architect" as "fast" (single depth keyword, no coding)', () => {
    // "architect" matches depthRx → dMatches=["architect"], depthScore=1
    // length=59 → lengthScore=1 → FAST: lengthScore > 0 → 'fast'
    expect(classifyAutoMode('Architect a solution for real-time collaborative editing')).toBe('fast');
  });

  it('classifies refactor+test+migration as "pro" (depth from "migration")', () => {
    // "migration" matches depthRx → depthScore=2, length > 50 → 'pro'
    const msg = 'Refactor the database and write tests for the migration strategy';
    expect(classifyAutoMode(msg)).toBe('pro');
  });

  // ── SMART: Creation/building tasks, moderate coding complexity ────────────

  it('classifies "make a" creation request as "smart"', () => {
    expect(classifyAutoMode('Make a snake game using HTML canvas')).toBe('smart');
  });

  it('classifies "create an" creation request as "smart"', () => {
    expect(classifyAutoMode('Create a todo list app with React')).toBe('smart');
  });

  it('classifies "build a" creation request as "smart"', () => {
    expect(classifyAutoMode('Build a CLI tool for managing environment variables')).toBe('smart');
  });

  it('classifies "explain how" short request as "fast" (single depth keyword, no coding)', () => {
    // "explain how" matches depthRx → dMatches=["explain how"], depthScore=1
    // No coding intent, length=33 → lengthScore=0 → default 'fast'
    expect(classifyAutoMode('Explain how SQL injection works')).toBe('fast');
  });

  // ── FAST: Has coding intent but no depth/creation signals ─────────────────

  it('classifies simple implementation request as "fast"', () => {
    expect(classifyAutoMode('Implement a REST API for user management')).toBe('fast');
  });

  it('classifies refactor request as "fast"', () => {
    expect(classifyAutoMode('Refactor the database layer to use connection pooling')).toBe('fast');
  });

  it('classifies test writing request as "fast"', () => {
    expect(classifyAutoMode('Write unit tests for the billing module')).toBe('fast');
  });

  it('classifies deploy request as "fast"', () => {
    expect(classifyAutoMode('Deploy the latest build to production')).toBe('fast');
  });

  it('classifies multi-keyword "fix" request as "smart" (coding >= 3)', () => {
    // "fix" + "bug" + "function" = 3 codingRx matches → codingScore=3
    // SMART: codingScore >= 3 → 'smart'
    expect(classifyAutoMode('Fix the bug in the login function')).toBe('smart');
  });

  it('classifies "summarize" request as "fast"', () => {
    expect(classifyAutoMode('Summarize the key points from this article')).toBe('fast');
  });

  it('classifies coding question as "fast" even with question words', () => {
    expect(classifyAutoMode('How do I implement JWT authentication in Express?')).toBe('fast');
  });

  // ── FREE: Truly casual, no signals, short ─────────────────────────────────

  it('classifies simple greeting as "free"', () => {
    expect(classifyAutoMode('Hello!')).toBe('free');
  });

  it('classifies simple question as "free"', () => {
    expect(classifyAutoMode('What is the capital of France?')).toBe('free');
  });

  it('classifies short thank-you as "free"', () => {
    expect(classifyAutoMode('Thanks for your help!')).toBe('free');
  });

  it('classifies "translate" short request as "free"', () => {
    expect(classifyAutoMode('Translate this to Spanish: Hello world')).toBe('free');
  });

  it('classifies short "what is" question as "free"', () => {
    expect(classifyAutoMode('What is TypeScript?')).toBe('free');
  });

  it('classifies "how to" short question as "free"', () => {
    expect(classifyAutoMode('How to center a div in CSS?')).toBe('free');
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('handles empty string gracefully', () => {
    const result = classifyAutoMode('');
    expect(['free', 'fast']).toContain(result);
  });

  it('handles single character input', () => {
    const result = classifyAutoMode('a');
    expect(['free', 'fast']).toContain(result);
  });
});
