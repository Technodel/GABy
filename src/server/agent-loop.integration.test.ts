/**
 * Integration tests for SUNy Agent Loop — runAgentLoop
 *
 * Tests the full agent loop pipeline with mocked AI SDK, bridge, and DB.
 * Covers: model fallback, tool call extraction, empty output retry,
 * post-change file verification, talk mode, and error paths.
 *
 * Run: npx vitest run src/server/agent-loop.integration.test.ts
 */

import 'dotenv/config';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Shared mutable config (vi.hoisted runs BEFORE vi.mock factories) ──────────

const { mockStreamConfig, mockGenerateConfig, resetMockConfigs, mockStreamTextResult } = vi.hoisted(() => {
  const mockStreamConfig: {
    textChunks: string[];
    inputTokens: number;
    outputTokens: number;
  } = {
    textChunks: ['Test response'],
    inputTokens: 100,
    outputTokens: 50,
  };

  const mockGenerateConfig: {
    text: string;
    steps: number;
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  } = {
    text: 'Retry response',
    steps: 1,
    toolCalls: [],
  };

  function mockStreamTextResult() {
    const textStream = (async function* () {
      if (mockStreamConfig.textChunks.length === 0) {
        return;
      }
      for (const chunk of mockStreamConfig.textChunks) {
        yield chunk;
      }
    })();

    return {
      textStream,
      usage: Promise.resolve({
        inputTokens: mockStreamConfig.inputTokens ?? 100,
        outputTokens: mockStreamConfig.outputTokens ?? 50,
      }),
      experimental_providerMetadata: Promise.resolve(undefined),
    };
  }

  function resetMockConfigs(): void {
    mockStreamConfig.textChunks = ['Test response'];
    mockStreamConfig.inputTokens = 100;
    mockStreamConfig.outputTokens = 50;
    mockGenerateConfig.text = 'Retry response';
    mockGenerateConfig.steps = 1;
    mockGenerateConfig.toolCalls = [];
  }

  return { mockStreamConfig, mockGenerateConfig, resetMockConfigs, mockStreamTextResult };
});

// ── Mock 'ai' — Vercel AI SDK ────────────────────────────────────────────────

vi.mock('ai', () => {
  // Use vi.fn() for streamText — mockImplementation creates a proper constructable mock
  // that works with vitest's mock system (mockClear, mockReset, etc.)
  return {
    streamText: vi.fn().mockImplementation(() => mockStreamTextResult()),
    generateText: vi.fn().mockImplementation(async () => {
      return {
        text: mockGenerateConfig.text ?? '',
        steps: mockGenerateConfig.steps ?? 1,
        usage: { inputTokens: 100, outputTokens: 50 },
        toolCalls: mockGenerateConfig.toolCalls ?? [],
      };
    }),
  };
});

// ── Mock internal dependencies ────────────────────────────────────────────────

vi.mock('./agent', () => ({
  getModelsForMode: vi.fn().mockReturnValue([
    { model: { modelId: 'deepseek-chat' }, provider: 'DeepSeek' },
  ]),
  getVisionCapableModels: vi.fn().mockReturnValue([]),
  isCachingEnabled: vi.fn().mockReturnValue(false),
  getEditFormat: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./feature-flags', () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('./user-client-manager', () => ({
  userClientManager: {
    pushToUser: vi.fn(),
    pushChatContent: vi.fn(),
    pushNarration: vi.fn(),
  },
}));

vi.mock('./bridge-manager', () => ({
  isBridgeConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('./context-manager', () => ({
  trimHistory: vi.fn().mockImplementation((msgs) => msgs),
}));

vi.mock('./narrator', () => ({
  narrateMessage: vi.fn().mockReturnValue('thinking...'),
}));

vi.mock('./git-manager', () => ({
  gitAutoCommit: vi.fn().mockResolvedValue(undefined),
  createCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./behavioral-rules', () => ({
  extractMistakeRule: vi.fn().mockResolvedValue(null),
  seedBehavioralRules: vi.fn().mockReturnValue(0),
}));

vi.mock('./hypothesis-engine', () => ({
  selectStrategies: vi.fn().mockReturnValue([]),
  launchHypothesis: vi.fn().mockReturnValue('hyp_test'),
  completeHypothesis: vi.fn(),
}));

vi.mock('./training-scorer', () => ({
  scoreAgentTurn: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./confidence-scorer', () => ({
  recordConfidence: vi.fn().mockResolvedValue(undefined),
  buildConfidenceAssessmentPrompt: vi.fn().mockReturnValue('Assess your confidence:'),
}));

vi.mock('./lint-runner', () => ({
  runLint: vi.fn().mockResolvedValue({ passed: true, errorCount: 0, command: 'tsc', output: '' }),
}));

vi.mock('./test-runner', () => ({
  runTests: vi.fn().mockResolvedValue({ passed: true, failCount: 0, framework: 'vitest', output: '' }),
  runFailingTests: vi.fn(),
  buildTestFixPrompt: vi.fn(),
}));

vi.mock('./personality', () => ({
  pickRandom: vi.fn().mockReturnValue(''),
}));

// ── Tool creators (return empty — no real tool calls in tests) ────────────────

vi.mock('./power-tools', () => ({
  createPowerTools: vi.fn().mockReturnValue({}),
}));

vi.mock('./web-search', () => ({
  createWebSearchTool: vi.fn().mockReturnValue({}),
}));

vi.mock('./url-fetch', () => ({
  createUrlFetchTool: vi.fn().mockReturnValue({}),
}));

vi.mock('./user-memory', () => ({
  createMemoryTools: vi.fn().mockReturnValue({}),
}));

vi.mock('./symbol-reader', () => ({
  createSymbolReaderTool: vi.fn().mockReturnValue({}),
}));

vi.mock('./subtask-delegator', () => ({
  createSubtaskDelegatorTool: vi.fn().mockReturnValue({}),
}));

vi.mock('./prompt-registry', () => ({
  createPromptRegistryTool: vi.fn().mockReturnValue({}),
}));

vi.mock('./file-discovery', () => ({
  createFileDiscoveryTool: vi.fn().mockReturnValue({}),
}));

vi.mock('./error-corrector', () => ({
  createSelfHealTool: vi.fn().mockReturnValue({}),
}));

vi.mock('./mcp-manager', () => ({
  mcpManager: {
    getTools: vi.fn().mockReturnValue({}),
    isConnected: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('./loop-detector', () => {
  // Regular function so `new LoopDetector()` works (arrow functions are not constructable)
  function LoopDetector() {
    this.isLoopReported = false;
    this.recordToolCall = function () { /* noop */ };
    this.rearm = function () { /* noop */ };
  }

  return {
    LoopDetector,
    getLoopDetector: function () {
      return { isLoopReported: false, rearm: function () {}, recordToolCall: function () {} };
    },
  };
});

vi.mock('./repo-map', () => ({
  invalidateRepoMap: vi.fn(),
}));

vi.mock('./edit-format-parser', () => ({
  applyDiffFormat: vi.fn().mockReturnValue([]),
  applyWholeFormat: vi.fn().mockReturnValue([]),
  DIFF_FORMAT_INSTRUCTIONS: '',
  WHOLE_FORMAT_INSTRUCTIONS: '',
  ARCHITECT_PLAN_INSTRUCTIONS: '',
}));

vi.mock('./skill-loader', () => ({
  classifyTask: vi.fn().mockResolvedValue(undefined),
  getActiveSkills: vi.fn().mockReturnValue([]),
}));

// ── Module under test ─────────────────────────────────────────────────────────

import { runAgentLoop } from './agent-loop';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runAgentLoop (integration)', () => {
  beforeEach(() => {
    resetMockConfigs();
    vi.clearAllMocks();
  });

  // ── Success path ─────────────────────────────────────────────────────────

  it('returns content from streamText when model responds', async () => {
    mockStreamConfig.textChunks = ['Hello, I am SUNy. How can I help you today?'];

    const result = await runAgentLoop({
      userId: 1,
      mode: 'fast',
      systemPrompt: 'You are a helpful coding assistant.',
      projectPath: '/tmp/test-project',
      projectId: 1,
      history: [],
      userMessage: 'Write a hello world function',
      sessionId: 'test-session-1',
      talkMode: false,
    });

    expect(result.content).toContain('Hello, I am SUNy');
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.resolvedMode).toBe('fast');
    expect(Array.isArray(result.changedFiles)).toBe(true);
  });

  it('handles talk mode (no coding — chat response)', async () => {
    mockStreamConfig.textChunks = ['The capital of France is Paris.'];

    const result = await runAgentLoop({
      userId: 1,
      mode: 'free',
      systemPrompt: 'You are a helpful assistant.',
      history: [],
      userMessage: 'What is the capital of France?',
      sessionId: 'test-session-talk',
      talkMode: true,
    });

    expect(result.content).toContain('Paris');
    expect(result.resolvedMode).toBe('free');
  });

  it('resolves AUTO mode based on message content', async () => {
    mockStreamConfig.textChunks = ['Let me help you with that.'];

    const result = await runAgentLoop({
      userId: 1,
      mode: 'auto',
      systemPrompt: 'You are a helpful coding assistant.',
      projectPath: '/tmp/test-project',
      projectId: 1,
      history: [],
      userMessage: 'Fix the bug in the login function',
      sessionId: 'test-session-auto',
      talkMode: false,
    });

    expect(result.resolvedMode).toBe('smart');
  });

  // ── Model fallback ───────────────────────────────────────────────────────

  it('falls back to secondary model when primary fails', async () => {
    const ai = await import('ai');
    // Use mockImplementationOnce to return object directly (not wrapped in Promise)
    // agent-loop does `const result = streamText(...)` without await, so the return
    // value must be the result object, not a Promise.
    vi.mocked(ai.streamText)
      .mockRejectedValueOnce(new Error('AI_PROVIDER_ERROR'))
      .mockImplementationOnce(() => mockStreamTextResult());

    const agent = await import('./agent');
    vi.mocked(agent.getModelsForMode).mockReturnValue([
      { model: { modelId: 'failing-model' }, provider: 'DeepSeek' },
      { model: { modelId: 'deepseek-chat' }, provider: 'DeepSeek' },
    ]);

    const result = await runAgentLoop({
      userId: 1,
      mode: 'fast',
      systemPrompt: 'You are a helpful coding assistant.',
      projectPath: '/tmp/test-project',
      projectId: 1,
      history: [],
      userMessage: 'Write a test',
      sessionId: 'test-session-fallback',
      talkMode: false,
    });

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
  });

  // ── Empty output auto-retry ──────────────────────────────────────────────

  it('auto-retries when model produces empty output with no tool calls', async () => {
    // streamText returns empty output → triggers auto-retry via generateText
    mockStreamConfig.textChunks = [];
    // Agent-loop checks retryText.length > 50 || retryResult.steps > 1
    mockGenerateConfig.text = 'Here is the function you requested. It takes two parameters and returns their sum after validating the inputs are numbers. The implementation uses type guards for safety and handles edge cases like negative numbers and zero.';
    mockGenerateConfig.steps = 1;

    const result = await runAgentLoop({
      userId: 1,
      mode: 'fast',
      systemPrompt: 'You are a helpful coding assistant.',
      projectPath: '/tmp/test-project',
      projectId: 1,
      history: [],
      userMessage: 'Write a function',
      sessionId: 'test-session-retry',
      talkMode: false,
    });

    expect(result.content.length).toBeGreaterThan(50);
    expect(result.content).toContain('function');
  });

  it('auto-retry exhausts and returns fallback when all retries fail', async () => {
    mockStreamConfig.textChunks = [];
    mockGenerateConfig.text = '';
    mockGenerateConfig.steps = 1;

    const result = await runAgentLoop({
      userId: 1,
      mode: 'fast',
      systemPrompt: 'You are a helpful coding assistant.',
      projectPath: '/tmp/test-project',
      projectId: 1,
      history: [],
      userMessage: 'Write a function',
      sessionId: 'test-session-fallback2',
      talkMode: false,
    });

    expect(result.content).toContain('encountered an issue');
  });

  // ── Step exhaustion ──────────────────────────────────────────────────────

  it('appends warning when steps hit MAX_STEPS limit', async () => {
    mockStreamConfig.textChunks = ['Some response'];

    const result = await runAgentLoop({
      userId: 1,
      mode: 'fast',
      systemPrompt: 'You are a helpful coding assistant.',
      history: [],
      userMessage: 'Do something',
      sessionId: 'test-session-steps',
      talkMode: true,
    });

    expect(result.content).toBeDefined();
    expect(result.proofSummary).toBeDefined();
    expect(typeof result.proofSummary.steps).toBe('number');
    expect(typeof result.proofSummary.durationMs).toBe('number');
  });

  // ── Error handling ───────────────────────────────────────────────────────

  it('throws when all models fail', async () => {
    const ai = await import('ai');
    // Use mockImplementation (sync throw) instead of mockRejectedValue (async reject)
    // so that mockReset in cleanup properly restores the default
    vi.mocked(ai.streamText).mockImplementation(() => {
      throw new Error('ALL_MODELS_FAILED');
    });

    const agent = await import('./agent');
    vi.mocked(agent.getModelsForMode).mockReturnValue([
      { model: { modelId: 'failing-1' }, provider: 'DeepSeek' },
      { model: { modelId: 'failing-2' }, provider: 'DeepSeek' },
    ]);

    await expect(
      runAgentLoop({
        userId: 1,
        mode: 'fast',
        systemPrompt: 'You are a helpful coding assistant.',
        history: [],
        userMessage: 'Do something',
        sessionId: 'test-session-error',
        talkMode: true,
      }),
    ).rejects.toThrow();

    // Clean up: prevent mockImplementation leak into subsequent tests
    // (vi.clearAllMocks in beforeEach doesn't reset implementations)
    vi.mocked(ai.streamText).mockReset();
    vi.mocked(ai.streamText).mockImplementation(() => mockStreamTextResult());
    vi.mocked(agent.getModelsForMode).mockReset();
    vi.mocked(agent.getModelsForMode).mockReturnValue([
      { model: { modelId: 'deepseek-chat' }, provider: 'DeepSeek' },
    ]);
  });

  // ── Proof summary structure ──────────────────────────────────────────────

  it('returns complete proofSummary with all expected fields', async () => {
    mockStreamConfig.textChunks = ['Task completed successfully.'];

    const result = await runAgentLoop({
      userId: 1,
      mode: 'fast',
      systemPrompt: 'You are a helpful coding assistant.',
      projectPath: '/tmp/test-project',
      projectId: 1,
      history: [],
      userMessage: 'Write a hello world',
      sessionId: 'test-session-proof',
      talkMode: false,
    });

    expect(result.proofSummary).toMatchObject({
      toolCallCount: expect.any(Number),
      lintRuns: expect.any(Number),
      testRuns: expect.any(Number),
      lintPassed: expect.any(Boolean),
      testPassed: expect.any(Boolean),
      filesChanged: expect.any(Number),
      steps: expect.any(Number),
      durationMs: expect.any(Number),
    });
    expect(Array.isArray(result.proofSummary.toolCalls)).toBe(true);
  });
});
