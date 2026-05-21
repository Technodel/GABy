# SUNy / GABy — Complete Agent Project Guide

> **Version:** 1.0.0  
> **Project:** `D:\Projects\GABy`  
> **Deployed:** `https://suny.technodel.tech` (VPS `72.62.235.63:2222`)  
> **GitHub:** `https://github.com/Technodel/GABy.git`  
> **SUNy =** Smart Unstoppable Navigator

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File Tree & Module Map](#2-file-tree--module-map)
3. [Backend Engine](#3-backend-engine)
4. [Frontend (Renderer)](#4-frontend-renderer)
5. [System Prompt Construction](#5-system-prompt-construction)
6. [Tools & Bridges](#6-tools--bridges)
7. [Database & Schema](#7-database--schema)
8. [Agent Loop & AI Pipeline](#8-agent-loop--ai-pipeline)
9. [Build & Deploy Pipeline](#9-build--deploy-pipeline)
10. [Git Workflow & Hygiene](#10-git-workflow--hygiene)
11. [Security Model](#11-security-model)
12. [Provider System & API Keys](#12-provider-system--api-keys)
13. [Billing & Usage Tracking](#13-billing--usage-tracking)
14. [Configuration System](#14-configuration-system)
15. [Laws, Rules & Behavioral Patterns](#15-laws-rules--behavioral-patterns)
16. [Troubleshooting & Common Fixes](#16-troubleshooting--common-fixes)
17. [Skill System](#17-skill-system)
18. [SDK Package (gaby-sdk)](#18-sdk-package-gaby-sdk)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    User's Browser                     │
│  React SPA (Vite) → WebSocket(chat) ←→ API REST     │
└──────────────────┬──────────────────────────────────┘
                   │ wss://suny.technodel.tech/ws
                   │ https://suny.technodel.tech/api/*
                   ▼
┌─────────────────────────────────────────────────────┐
│              Express Server (Node.js)                │
│              Port 3500 (internal)                    │
│              nginx reverse-proxy at :443             │
│                                                      │
│  ┌─────────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Auth System  │  │  Agent   │  │  Tool Registry  │  │
│  │ (JWT+cookie) │  │  Loop    │  │  (Power Tools)  │  │
│  └─────────────┘  └──────────┘  └────────────────┘  │
│                                                      │
│  ┌─────────────┐  ┌──────────┐  ┌────────────────┐  │
│  │   DB Layer   │  │  Bridge  │  │  Hook System   │  │
│  │ (SQLite/WAL) │  │  Manager │  │  (Events)      │  │
│  └─────────────┘  └──────────┘  └────────────────┘  │
└──────────────────┬──────────────────────────────────┘
                   │ wss://suny-server/bridge
                   ▼
┌─────────────────────────────────────────────────────┐
│          User's Local Machine (via Bridge)           │
│                                                      │
│  ┌─────────────────────────────────────────────────┐ │
│  │  SUNy Bridge Agent (Node.js WebSocket client)   │ │
│  │  - Reads/writes files on local filesystem       │ │
│  │  - Executes shell commands                      │ │
│  │  - Runs dev servers                             │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Bridge Architecture:** Server NEVER touches user's filesystem directly. All file ops go through the bridge WebSocket → sandboxed agent on user's machine.
- **SQLite with WAL** for persistence. No external DB needed.
- **Vercel AI SDK** (`ai` v5) for LLM calls with native tool calling (no XML parsing).
- **Multi-provider:** Anthropic, OpenAI, DeepSeek, Groq, OpenRouter, Gemini, Ollama, HuggingFace.
- **PM2 process** named `suny` runs the server.

---

## 2. File Tree & Module Map

### 2.1 Server Modules (`src/server/` — 93 `.ts` files)

#### Core Server
| File | Purpose |
|------|---------|
| `index.ts` | Express server entry. Routes, WebSocket upgrade, system prompt construction (1600+ lines). |
| `agent.ts` | Multi-provider LLM caller. Model factory, key management, vision model detection. |
| `agent-loop.ts` | AI agent orchestration using `streamText()`. Message building, tool execution, history trim. |
| `db.ts` | SQLite connection + 16 schema migrations. Lazy init with `getDb()`. |

#### Route Modules
| File | Mount Point | Purpose |
|------|-------------|---------|
| `auth.ts` | — | JWT auth: login, register, logout, refresh, `requireAuth`, `requireAdmin` middleware |
| `admin-routes.ts` | `/admin/api` | Admin CRUD: users, API keys, pricing, settings, flags, contact info, usage stats |
| `user-routes.ts` | `/api` | User CRUD: projects, settings, wallet, experience, usage logs |
| `mcp-routes.ts` | `/api` | MCP server management endpoints |
| `mcp-marketplace.ts` | `/api` | Community MCP server marketplace (install/uninstall) |
| `bridge-routes.ts` | — | Bridge WebSocket upgrade handling |
| `bridge-onboarding.ts` | `/api/bridge` | Bridge setup code generation/redeem |
| `session-replay.ts` | `/api/sessions` | Session replay for debugging |
| `scheduler-routes.ts` | `/api` | Scheduled agents CRUD |
| `hypothesis-routes.ts` | `/api` | Hypothesis engine endpoints |
| `checkpoint-routes.ts` | `/api` | Git checkpoint timeline API |

#### Tools Engine
| File | Purpose |
|------|---------|
| `power-tools.ts` | Core file/shell tool definitions: read, edit, write, delete, list_dir, mkdir, bash, glob, grep, path_exists. All execute via bridge. |
| `web-search.ts` | Web search tool (Google/Bing API) |
| `url-fetch.ts` | URL content fetch tool |
| `user-memory.ts` | Persistent memory: `remember`/`recall` tools |
| `file-discovery.ts` | Project scanning tools: `find_files`, `glob`, `read_file_tree` |
| `symbol-reader.ts` | Code symbol/type lookup tool |
| `subtask-delegator.ts` | Delegate sub-tasks to sub-agents |
| `prompt-registry.ts` | Save/load prompt templates |
| `error-corrector.ts` | Self-heal tool for error recovery |

#### AI Intelligence
| File | Purpose |
|------|---------|
| `agent.ts` | Model factory, provider key management, caching config, edit format |
| `agent-loop.ts` | Main agent loop: streamText, tool execution, lint/test retry |
| `context-manager.ts` | History trimming (token budget management) |
| `context-summarizer.ts` | Summarize old context to save tokens |
| `hypothesis-engine.ts` | Multi-strategy hypothesis execution (test_first, refactor, from_scratch) |
| `training-scorer.ts` | Score agent turns for RL training data |
| `training-loader.ts` | Load training examples into system prompt |
| `confidence-scorer.ts` | Self-assess confidence on outcomes |
| `skill-loader.ts` | Load skill definitions from `skills/*/SKILL.md` |
| `behavioral-rules.ts` | Learn/fix behavioral rules from mistakes |
| `cross-project-learning.ts` | Share learnings across projects |
| `interaction-memory.ts` | Store interaction patterns |
| `loop-detector.ts` | Detect agent stuck-in-loop patterns |
| `failure-memory.ts` | Remember past failures to avoid repeats |

#### Security
| File | Purpose |
|------|---------|
| `injection-guard.ts` | Scan user messages for prompt injection patterns |
| `sanitizer.ts` | Sanitize outgoing WebSocket data (strip model names, tokens, paths) |
| `security-guard.ts` | Security policy enforcement |
| `change-guardian.ts` | Detect config/environment drift |
| `project-lock.ts` | Acquire/release project locks to prevent concurrent edits |
| `billing.ts` | Token-based billing, deduct, sufficient balance check |

#### Monitoring & Metrics
| File | Purpose |
|------|---------|
| `metrics.ts` | Agent turn metrics (tokens, cost, success/fail) |
| `prometheus-metrics.ts` | Prometheus endpoint for Grafana |
| `operation-audit.ts` | Operation logging for audit trail |
| `performance-optimization.ts` | Performance tracking |
| `benchmark.ts` | Benchmark runs |
| `session-benchmark.ts` | Per-session benchmarks |

#### Memory & Persistence
| File | Purpose |
|------|---------|
| `user-memory.ts` | Persistent key-value memory per user |
| `blueprint-memory.ts` | Pattern detection → persistent rules |
| `vectors.ts` | Vector storage |
| `hnsw-lite.ts` | Lightweight HNSW index for similarity search |
| `code-index.ts` | Code indexing for semantic search |
| `project-map.ts` | Project structure map |
| `project-digest.ts` | Generate/format project digest for system prompt |
| `project-rules.ts` | Load project-specific rules (`.clinerules`, `AGENT.md`) |
| `repo-map.ts` | Build repo map (file tree + purpose descriptions) |

#### Service Modules
| File | Purpose |
|------|---------|
| `git-manager.ts` | Auto-commit after each agent turn. Checkpoint creation. |
| `mcp-manager.ts` | Dynamic MCP server connection management |
| `browser-automation.ts` | Headless browser control (via bridge + puppeteer/playwright, fetch fallback) |
| `scheduled-agents.ts` | Cron-based scheduled agent runs |
| `task-worker.ts` | Background task worker |
| `task-queue.ts` | Task queuing system |
| `task-graph.ts` | Task dependency graph |
| `checkpoint-manager.ts` | DB-backed checkpoint registry |
| `prompt-variants.ts` | Persona/tone/strategy variant management |
| `feature-flags.ts` | Feature flag CRUD |
| `narrator.ts` | Narration message helper |
| `personality.ts` | PickRandom, did-you-know timer |
| `hook-system.ts` | Event-driven hook system |
| `user-queue.ts` | Per-user message queuing |
| `user-client-manager.ts` | WebSocket connection management for browser tabs |
| `edit-format-parser.ts` | Parse AI edit formats (diff, whole, architect, tool-call) |
| `lint-runner.ts` | Run linters via bridge |
| `test-runner.ts` | Run tests, find failing tests, build fix prompts |
| `test-generator.ts` | Generate tests automatically |
| `stage-manager.ts` | Task stage management (intent_parse, plan, execution, verify, finalize) |
| `verifier.ts` | Verification utilities |
| `verification-obsession.ts` | Code review + post-merge validation |
| `reviewer.ts` | Code review automation |
| `design-intent.ts` | Design intent tracking |
| `presence-engineering.ts` | Presence system for context continuity |
| `goal-tracker.ts` | Track goals with evidence collection |
| `agent.ts` | Agent config types and helpers |
| `billing.ts` | Usage billing |
| `learning-prioritizer.ts` | Prioritize what to learn next |
| `execution-tracer.ts` | Trace execution paths for debugging |
| `edit-format-parser.ts` | Parse and apply AI edit formats |
| `injection-guard.ts` | Prompt injection detection |
| `change-guardian.ts` | Environment drift detection |
| `cross-project-learning.ts` | Cross-project learning |

### 2.2 Frontend (`src/renderer/src/`)

| File | Purpose |
|------|---------|
| `App.tsx` | Root: router, auth state, settings modal |
| `main.tsx` | React entry |
| `types.ts` | Shared frontend types |
| `pages/Login.tsx` | Login/signup page with pricing + contact display |
| `pages/Chat.tsx` | Main chat interface with file tree, mode selector, bridge status |
| `pages/AdminPanel.tsx` | Admin dashboard |
| `pages/AdminUsers.tsx` | User management |
| `pages/AdminApiKeys.tsx` | API key management |
| `pages/AdminPricing.tsx` | Pricing mode editor |
| `pages/AdminSettings.tsx` | App settings |
| `pages/AdminUsageStats.tsx` | Usage statistics |
| `pages/AdminFeatureFlags.tsx` | Feature flag toggles |
| `pages/AdminContactInfo.tsx` | Contact info editor |
| `pages/BridgeSetup.tsx` | Bridge installation instructions |
| `pages/UserSettings.tsx` | User preferences |
| `pages/PricingPlans.tsx` | Public pricing display |
| `pages/WhatIsSUNy.tsx` | About SUNy |
| `pages/About.tsx` | About page |
| `pages/ContactUs.tsx` | Contact form |
| `pages/Updates.tsx` | Changelog/updates |
| `pages/CheckpointTimeline.tsx` | Git checkpoint timeline |
| `components/TopBar.tsx` | Navigation bar |
| `components/SunyAvatar.tsx` | SUNy avatar component |
| `components/SidebarContent.tsx` | Sidebar with file tree |
| `components/ChatMessages.tsx` | Message list |
| `components/ChatInput.tsx` | Message input |
| `components/FileTreeNode.tsx` | File tree node |
| `components/ModeSelector.tsx` | Mode picker |
| `components/ModelPicker.tsx` | Model selector |
| `components/NarratedMessage.tsx` | Narration bubble |
| `components/BridgeStatusBadge.tsx` | Bridge connection status |
| `components/BridgeInstallInstructions.tsx` | Bridge setup guide |
| `components/BalanceBadge.tsx` | Wallet balance display |
| `components/MemoryManager.tsx` | Memory viewer |
| `components/ReportBadgeButton.tsx` | Report button |
| `components/modals/ChatModals.tsx` | Various chat modals |
| `hooks/useWebSocket.ts` | WebSocket connection hook |
| `hooks/useSoundEffects.ts` | Sound effects hook |
| `styles/globals.css` | Global CSS with CSS variables |

### 2.3 Skills (`skills/` — 23 SKILL.md files)

```
skills/
├── using-agent-skills/
├── spec-driven-development/
├── incremental-implementation/
├── debugging-and-error-recovery/
├── code-review-and-quality/
├── doubt-driven-development/
├── deprecation-and-migration/
├── documentation-and-adrs/
├── frontend-ui-engineering/
├── git-workflow-and-versioning/
├── api-and-interface-design/
├── browser-testing-with-devtools/
├── ci-cd-and-automation/
├── code-simplification/
├── context-engineering/
├── idea-refine/
├── interview-me/
├── performance-optimization/
├── planning-and-task-breakdown/
├── security-and-hardening/
├── shipping-and-launch/
├── source-driven-development/
└── test-driven-development/
```

Each SKILL.md has YAML frontmatter + markdown sections. Loaded by `skill-loader.ts`.

### 2.4 SDK (`packages/gaby-sdk/`)

```
packages/gaby-sdk/src/
├── index.ts       # Public API exports
├── extension.ts   # Extension interface
├── tool.ts        # Tool interface
├── memory.ts      # Memory interface
├── auth.ts        # Auth interface
└── billing.ts     # Billing interface
```

---

## 3. Backend Engine

### 3.1 Express Server (`index.ts`)

**Entry:** `src/server/index.ts` — 2129 lines.

**Startup sequence:**
```
load dotenv
create express app + http server
create WebSocketServer (noServer mode)
register middleware (cors, json, cookie-parser, rate-limiters)
register health endpoint (/api/health)
register auth routes
register admin API (/admin/api)
register user API (/api)
register MCP routes
register bridge routes
register scheduler/hypothesis/checkpoint routes
register marketplace routes
register session replay routes
serve bridge static files
serve renderer static files (production SPA)
SPA catch-all (* → index.html)
upgrade handler (pathname-based routing to bridge vs browser WS)
listen on PORT (default 3500)
```

**Middleware stack:** cors → json body parser → cookie parser → rate limiters → auth (requireAuth/requireAdmin) → route handlers

**Rate limits:**
| Endpoint | Window | Dev Limit | Prod Limit |
|----------|--------|-----------|------------|
| Login | 15 min | 100 | 30 |
| Register | 60 min | 50 | 10 |
| General API | 15 min | 200 | 60 |
| WebSocket | 60 sec | 20 | 20 |

### 3.2 WebSocket Architecture

Two WebSocket paths:
| Path | Purpose | Handler |
|------|---------|---------|
| `/ws` | Browser chat client | `handleUserClientUpgrade` → `userClientManager` |
| `/bridge` | Bridge agent (local machine) | `handleBridgeUpgrade` → `bridgeManager` |

**User Client WebSocket flow:**
```
connect with token (query param or cookie)
→ validate token → extract userId
→ register in userClientManager (latest-wins)
→ receive 'connected' event
→ user sends chat:message → server processes → streams responses
→ can send chat:cancel → aborts current processing
```

### 3.3 Message Processing Pipeline (WebSocket handler)

```
ws.on('message'):
1. Parse JSON
2. Check WS rate limit (20/60s)
3. Handle 'chat:cancel' → abort
4. Validate 'chat:message' type
5. Injection guard scan (blockOnHigh)
6. Interruption behavior check (interrupt vs queue)
7. Credit/budget check
8. Session token cap check
9. Build system prompt (1600+ lines)
10. Run agent loop (streamText)
11. Auto-commit changed files
12. Record metrics
13. Send results back
```

### 3.4 System Prompt Construction (`index.ts` lines 535+)

Built as `systemLines[]` array. Sections assembled in order:

| Section | Content |
|---------|---------|
| Identity Anchor | "You are SUNy — Smart Unstoppable Navigator." 7 identity traits (relentless, meticulous, honest, protective, warm, curious, disciplined) |
| Character Voice Bible | Tone rules, grammar, pet phrases, forbidden language. ~200 lines |
| Capabilities | Bridge-connected or offline? |
| Bridge Explanation | What bridge is and what it enables |
| MCP Explanation | Dynamic MCP tool extension |
| Laws | 6 non-negotiable laws (context-first, no-guess, one-change, verify, streaming, exhaust-tools) |
| Execution Stages | 5 stages: intent_parse → plan → execution → verify → finalize |
| Mode Flags | normal, strict-edit, exploratory-read, refactor-safe, debug-only |
| Error Taxonomy | 10 error classes (A-J) with routing strategies |
| Write-Verify Rule | After every write → read back → confirm |
| Completion Criteria | 4 conditions (edits confirmed, lint passes, tests pass, server OK) |
| Smart Test Rule | Auto-create tests after feature implementation |
| Communication Rules | Narration style, forbidden technical terminology |
| Information Firewall | Never reveal model names, provider names, token counts, stack traces |
| General Topics | How to handle non-coding questions |
| AiderDesk DNA | Core behavioral patterns |
| AiderDesk Laws | Detailed rules from system instructions |
| Workflow | 13-step task execution workflow |
| Problem Resolution Playbook | Multi-service debugging: 5 phases |
| Internal Monologue | Private thinking layer structure |
| Training/Tuning | Loaded from training examples |
| Skills | Active skill system prompts |
| Project Rules | `.clinerules` or `AGENT.md` per project |
| Behavioral Rules | Learned patterns from past errors |
| Project Digest | Current project structure overview |
| Blueprint Memory | Detected patterns + generated rules |
| Repo Map | File → purpose descriptions |
| Design Intents | Active design decisions |
| Verification Obsession | Recent code review results |
| Cross-Project Learning | Insights from other projects |
| Goal Context | Active task goals |
| Presence | Context continuity injections |
| Did You Know | Random tips |
| Lock / Digest Info | Current project lock + cache status |
| Current Stage Injected | Which execution stage we're in |

Total system prompt: ~1600+ lines, heavily cached with Anthropic's prompt caching.

---

## 4. Frontend (Renderer)

### 4.1 Tech Stack
- **Framework:** React 18+ with TypeScript
- **Build:** Vite
- **Routing:** react-router-dom v6
- **Auth:** JWT tokens in cookies (httpOnly), WebSocket token in query param
- **Real-time:** WebSocket for streaming chat responses
- **Styling:** CSS variables in `globals.css`, inline styles in components

### 4.2 Key CSS Variables (`styles/globals.css`)
```css
--bg: #1a1a2e;           /* Main background (dark) */
--bg-secondary: #16213e; /* Card/surface background */
--accent: #e94560;       /* Primary accent (red/coral) */
--accent-hover: #ff6b81;
--accent-secondary: #0f3460;
--text: #e0e0e0;         /* Primary text */
--text-secondary: #a0a0b0;
--border: #2a2a4a;
--success: #4caf50;
--warning: #ff9800;
--error: #f44336;
```

Light mode: `body.light-mode` flips these with `.light-mode` overrides.

### 4.3 Auth Flow
```
Login.tsx:
1. User submits credentials
2. POST /api/login → receives JWT in httpOnly cookie
3. App.tsx checks GET /api/me → sets auth state
4. WebSocket connects with ?token=<jwt>
5. Logout: POST /api/logout + cookie clear
```

### 4.4 Admin Login
```
Separate endpoint: POST /admin/login
Separate cookie: admin_token
Check: GET /admin/me
Default admin: username "galaxy", password "301088"
```

---

## 5. System Prompt Construction

### 5.1 Location
`src/server/index.ts` lines 535–1641 (approximately).

### 5.2 Key Architecture
System prompt is NOT a static file. It is dynamically assembled per-request using data from:
- The user's database row (display name, settings)
- The project configuration (path, persona, rules)
- Bridge online/offline status
- Active feature flags
- Training examples (loaded from DB)
- Active skills (loaded from skill-loader)
- Repo map (cached per project, rebuilt on file changes)
- Blueprint memory (detected patterns)
- Verification obsession findings
- Goal tracker state
- Presence engineering state
- Cross-project learning insights

### 5.3 Important System Prompt Edits

When editing the system prompt, you must understand:
1. It's inside `src/server/index.ts` in the `ws.on('message')` handler
2. It's built as an array of strings joined with `'\n'`
3. Each section is wrapped in XML tags (`<role>`, `<laws>`, etc.)
4. Some sections are conditionally included (bridge offline vs online)
5. Changing agent behavior has wide effects — test thoroughly

### 5.4 Prompt Caching (Anthropic-specific)
```typescript
// In agent-loop.ts, buildAnthropicCachedMessages():
// 1. System prompt marked as cacheable message
// 2. Last assistant message in history also cached
// 3. Uses providerOptions: { cacheControl: { type: 'ephemeral' } }
```

---

## 6. Tools & Bridges

### 6.1 Bridge Architecture

The Bridge is a WebSocket connection from the user's local machine to the SUNy server.

**Bridge connection lifecycle:**
1. User downloads/installs bridge agent (Node.js script or binary)
2. Bridge generates setup code (or user enters one)
3. Bridge connects to `wss://suny.technodel.tech/bridge`
4. Server registers in `bridgeManager` (keyed by userId)
5. All file/shell tool calls are forwarded to bridge
6. Bridge executes on user's machine, returns result
7. Bridge auto-reconnects on disconnect

**Bridge manager (`bridge-manager.ts`)**:
- `activeBridges: Map<userId, BridgeConnection>`
- `pendingRequests: Map<requestId, PendingRequest>`
- 30-second default timeout for bridge requests
- Auto-rejects pending on bridge disconnect

### 6.2 Power Tools (`power-tools.ts`)

All 10 tools defined here, each executing through bridge:

| Tool | Description | Bridge Command |
|------|-------------|----------------|
| `file_read` | Read file content, optional line numbers + range | `exec:read_file` |
| `file_edit` | Search/replace edit (server-side after bridge read) | `exec:read_file` + `exec:write_file` |
| `file_write` | Write/create/append file | `exec:write_file` |
| `file_delete` | Delete file or empty dir | `exec:delete_file` |
| `list_dir` | List directory contents | `exec:list_dir` |
| `mkdir` | Create directory | `exec:mkdir` |
| `path_exists` | Check if path exists | `exec:path_exists` |
| `bash` | Execute shell command | `exec:shell` |
| `glob` | Find files by pattern | `exec:shell` (node glob) |
| `grep` | Search file contents | `exec:shell` (node script) |

**File locking:** `file_edit` uses `withFileLock()` to prevent race conditions on concurrent edits to same file.

**Escape sanitization:** `sanitizeEscapes()` cleans up escaped newlines/backslashes from model output.

### 6.3 Agent Tools (loaded alongside power tools in agent-loop)

All tools combined in `agent-loop.ts`:
```
powerTools (10) + webSearch + urlFetch + memoryTools + 
symbolReader + subtaskDelegator + promptRegistry + 
fileDiscovery + selfHeal + mcpTools (dynamic)
```

### 6.4 Web Search Tool (`web-search.ts`)
- Google/Bing search API
- Returns formatted search results

### 6.5 URL Fetch Tool (`url-fetch.ts`)
- Fetch URL content
- Returns as markdown or raw text

### 6.6 File Discovery (`file-discovery.ts`)
- `find_files`: recursive file search by name pattern
- `glob`: pattern-based file matching
- `read_file_tree`: directory structure dump

### 6.7 Subtask Delegator (`subtask-delegator.ts`)
- Delegate sub-tasks to sub-agents
- Poll for completion
- Merge results

---

## 7. Database & Schema

### 7.1 Connection
```typescript
// src/server/db.ts
const DB_PATH = process.env.SUNY_DB_PATH || './data/suny.db';
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');  // 64 MB
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
```

### 7.2 Migration System
16 numbered migrations in `db.ts`. Each has: `version`, `name`, `up(db)`.

Schema version stored in `app_settings` table (key `schema_version`).

### 7.3 Core Tables

**`users`:** id, username, password_hash, role, wallet_balance, wallet_auto_spend, display_name, selected_mode, max_tokens_per_session, created_at

**`api_keys`:** id, mode, provider, key_value, model_id_override, priority, is_active, created_at

**`pricing_modes`:** id, mode, display_name, description, input_token_base_cost, output_token_base_cost, model_id

**`projects`:** id, user_id, name, description, local_path, persona, created_at

**`sessions`:** id, user_id, session_id, mode, status, token_count, cost, created_at

**`usage_log`:** id, user_id, session_id, project_id, mode, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost, created_at

**`agent_turn_metrics`:** id, user_id, session_id, project_id, mode, tool_calls, input_tokens, output_tokens, cost_usd, success, error_category, duration_ms, ts

**`feature_flags`:** key TEXT PK, value TEXT, label, description, updated_at

**`operation_log`:** id, user_id, project_id, session_id, operation, tool_name, status, detail, duration_ms, timestamp

**`app_settings`:** key TEXT PK, value TEXT

**`user_memory`:** id, user_id, key, value, created_at, updated_at

**`bridge_setup_codes`:** id, user_id, code, status, server_url, created_at, redeemed_at

**`project_locks`:** id, project_id, user_id, session_id, locked_at, expires_at

**`checkpoints`:** id, user_id, project_id, git_hash, message, created_at

**`interaction_patterns`:** id, user_id, project_id, pattern, category, confidence, observed_count

**`skills`:** id, user_id, skill_name, active, data, created_at

**`design_intents`:** id, user_id, project_id, intent, rationale, status, created_at

Plus tables for: hypotheses, scheduled_agents, prompts, training_data, goals, presence, blueprints, mcp_servers, and more.

### 7.4 Default Admin User
```
username: galaxy
password: 301088
role: admin (Migration 4)
```

---

## 8. Agent Loop & AI Pipeline

### 8.1 Core Loop (`agent-loop.ts`)

Uses Vercel AI SDK `streamText()` with native tool calling:

```typescript
const result = streamText({
  model: getModelForMode(mode),
  messages: buildMessages(history, systemPrompt),
  tools: allTools,
  maxSteps: MAX_STEPS, // default 24
  onStepFinish: async ({ text, toolCalls, toolResults }) => {
    // Log, record metrics, check for loops
  },
});
```

**Key characteristics:**
- No XML parsing — tools are native SDK tools
- Auto-executes tools and feeds results back
- `maxSteps` controls iterations (default 24)
- Each step = AI response (text + optional tool calls)
- Tools are executed by SDK, results auto-fed for next step
- LoopDetector checks for repeated patterns

### 8.2 Message Building (`buildMessages()`)

```typescript
function buildMessages(history, systemPrompt):
  // Normal history → CoreMessage[]
  // For Anthropic: inject cache_control breakpoints
  // For others: pass system separately
```

### 8.3 Auto Mode Classification (`classifyAutoMode()`)

Classifies user message into `free | fast | smart | pro` based on:
- Coding intent keywords (fix, error, implement, refactor, etc.)
- Creation/build signals (make a game, create an app)
- Reasoning depth needed (analyze, architect, compare)
- Message length
- System introspection

### 8.4 Lint/Test Retry Loop

```typescript
// After main loop, if files changed:
// 1. Run lint (max 3 retries)
// 2. Run tests (max 5 retries)
// 3. Each retry: feed errors back to AI for fixing
// 4. If lint/test still fail after retries, report and continue
```

### 8.5 Git Auto-Commit

After each agent turn:
```typescript
gitAutoCommit(userId, projectPath, changedFiles, userMessage):
  // 1. Check if git repo
  // 2. Stage changed files
  // 3. Commit with derived message
  // 4. Create checkpoint in DB
```

### 8.6 History Trimming (`context-manager.ts`)

Prevents token budget overflow:
- Trim oldest turns first
- Summarize if needed
- Keep system prompt, most recent exchanges

---

## 9. Build & Deploy Pipeline

### 9.1 Build

```bash
# Full build (server + renderer)
npm run build

# Server only (transpile 93 TS files to dist/)
node scripts/build.js

# Renderer only
cd src/renderer
npm run build
npx vite build
```

**Build script (`scripts/build.js`):**
- Uses TypeScript `transpileModule()` (NOT `tsc`) — avoids OOM from complex AI SDK generics
- Compiles CommonJS output to `dist/server/`
- Excludes test files (`*.test.ts`, `*.spec.ts`)
- Generates `.js.map` sourcemaps

### 9.2 Deploy to VPS

```bash
# SSH to VPS
ssh root@72.62.235.63 -p 2222

# Navigate to deployment
cd /var/www/suny/current-new-2   # or /var/www/suny/repo

# Pull latest
git pull origin main

# Build
node scripts/build.js
cd src/renderer && npx vite build && cd ../..

# Restart PM2
pm2 restart suny

# Or with env update:
pm2 restart suny --update-env

# Verify
curl http://localhost:3500/api/health
# → {"status":"ok","uptime":...,"db":"connected","timestamp":...,"version":"3.0"}
```

### 9.3 VPS Health Check

```bash
# Application health
curl http://localhost:3500/api/health

# PM2 status
pm2 list
pm2 status suny
pm2 logs suny --lines 50

# Port check
ss -tlnp | grep 3500

# Nginx config
cat /etc/nginx/sites-enabled/suny.technodel.tech
```

### 9.4 PM2 Process Management

```bash
pm2 start dist/server/index.js --name suny
pm2 restart suny
pm2 stop suny
pm2 delete suny
pm2 logs suny
pm2 monit
pm2 save  # save process list for auto-restart
```

---

## 10. Git Workflow & Hygiene

### 10.1 Remotes
```
origin  https://github.com/Technodel/GABy.git (fetch)
origin  https://github.com/Technodel/GABy.git (push)
```

### 10.2 `.gitignore` Patterns
```
node_modules/
dist/
data/
*.env
.env
*.db
*.db-shm
*.db-wal
logs/
*.log
.DS_Store
Thumbs.db
src/renderer/dist/
bridge/dist/
bridge/node_modules/
temp_*
tmp_*
_temp_*
_*.cjs
_*.mjs
_*.ps1
_vps_*
_ws_*
_count_*
_dbcheck*
_dump_*
server_out.txt
server_err.txt
*.pyc
__pycache__/
*.tgz
*.bat
/vps_*
/check_*
/_index_*
/run-*
/start-*
```

### 10.3 Commit Workflow
```bash
# Local
git add <files>
git commit -m "description"
git push origin main

# Then deploy on VPS:
ssh root@72.62.235.63 -p 2222
cd /var/www/suny/current-new-2
git pull origin main
<build and restart>
```

### 10.4 Git Auto-Commit Behavior
- After every agent turn that modifies files
- Non-fatal: git failures logged but never surfaced to user
- Commit message derived from user's request
- Creates checkpoint entry in `checkpoints` DB table

---

## 11. Security Model

### 11.1 Authentication
- JWT tokens stored in httpOnly cookies (`suny_token`, `admin_token`)
- Token refresh via `/api/token/refresh`
- Password hashing with bcryptjs
- Two separate auth paths: user (`/api/*`) and admin (`/admin/*`)

### 11.2 Injection Guard (`injection-guard.ts`)
- Scans every user message for prompt injection patterns
- Configurable: `sanitize` (strip patterns) or `blockOnHigh` (reject high-severity)
- Logs detections but continues processing for low-severity matches
- Patterns stored in `injection_patterns` DB table

### 11.3 Sanitizer (`sanitizer.ts`)
- Strips model names, provider names, token counts from outgoing WebSocket data
- Two levels: `buildUserEvent()` (full sanitization) and `buildChatEvent()` (keys only)
- Prevents technical internals from leaking to UI

### 11.4 Information Firewall (in system prompt)
- Agents forbidden from revealing model/provider names
- Agents forbidden from showing raw paths, commands, error codes, token counts
- Friendly error translations for all error types

### 11.5 Rate Limiting
- Login: 30/15min (100 dev)
- Register: 10/60min (50 dev)
- General API: 60/15min (200 dev)
- WebSocket: 20/60s per user

---

## 12. Provider System & API Keys

### 12.1 Supported Providers

| Provider | SDK | Features |
|----------|-----|----------|
| Anthropic | `@ai-sdk/anthropic` | Prompt caching, vision |
| OpenAI | `@ai-sdk/openai` | Vision |
| DeepSeek | `@ai-sdk/deepseek` | — |
| Groq | `@ai-sdk/groq` | Vision (some models) |
| OpenRouter | `@ai-sdk/openai-compatible` | Vision (free models) |
| Gemini | `@ai-sdk/openai-compatible` | Vision |
| Ollama | `@ai-sdk/openai-compatible` | Local models |
| HuggingFace | `@ai-sdk/openai-compatible` | Free Inference API |

### 12.2 Key Management (`agent.ts`)
- Keys stored in `api_keys` table
- Each key has: `mode` (free/fast/smart/pro), `provider`, `key_value`, `model_id_override`, `priority`, `is_active`
- Fallback chain: keys sorted by priority within each mode
- Vision models: separate detection via `getVisionCapableModels()` scanning all active keys

### 12.3 Model Factory (`getModelsForMode()`)
```typescript
function getModelsForMode(mode: string): LanguageModel[] {
  // 1. Get keys for mode, sorted by priority
  // 2. For each key, create provider instance
  // 3. Return array (agent loop tries fallback)
}
```

### 12.4 Vision Model Detection
```typescript
const VISION_MODEL_MAP = {
  Groq: ['llama-3.2-11b-vision-preview', ...],
  OpenRouter: ['meta-llama/llama-3.2-11b-vision-instruct:free', ...],
  OpenAI: ['gpt-4o-mini', 'gpt-4o'],
  Anthropic: ['claude-3-haiku-20240307', 'claude-3-5-sonnet-20241022'],
  Gemini: ['gemini-2.0-flash-lite', 'gemini-2.0-flash'],
  HuggingFace: ['meta-llama/Llama-3.2-11B-Vision-Instruct'],
};
```

---

## 13. Billing & Usage Tracking

### 13.1 Token Budget System
- Each user has `wallet_balance` (in dollars)
- `wallet_auto_spend` flag enables auto-deduct
- Daily token limit from `app_settings.daily_token_limit`
- Session token cap from `users.max_tokens_per_session`
- Free tier (`free` mode) uses daily limit only

### 13.2 Usage Deduction
- `deductUsage(userId, tokens, mode)` in `billing.ts`
- Calculates cost from `pricing_modes` table
- Records in `usage_log` table

### 13.3 Balance Check
```typescript
hasSufficientBalance(userId): boolean
// Checks wallet_balance > 0 or daily limit available
```

---

## 14. Configuration System

### 14.1 Environment Variables
```
SUNY_PORT / GABY_PORT         → Server port (default 3500)
SUNY_DB_PATH                  → SQLite path (default ./data/suny.db)
SUNY_ALLOWED_ORIGIN / GABY_ALLOWED_ORIGIN → CORS origin
NODE_ENV                      → 'production' or dev (affects rate limits, CORS)
```

### 14.2 App Settings (DB table)
Key-value store for runtime configuration:
- `schema_version` — migration tracker
- `prompt_caching_enabled` — true/false
- `edit_format` — tool-call | diff | whole | architect
- `daily_token_limit` — integer
- `theme_*` — theme settings
- `user_*` — per-user settings

### 14.3 Feature Flags (DB table)
- Keys like `checkpoint_timeline`, `hypothesis_engine`, `scheduled_agents`
- Values: `on` / `off`
- Managed via Admin UI → `AdminFeatureFlags.tsx`

---

## 15. Laws, Rules & Behavioral Patterns

### 15.1 Six Non-Negotiable Laws (in system prompt)
1. **CONTEXT-FIRST:** Never modify code without reading ALL relevant files first
2. **NO-GUESS:** If uncertain, use tools. Never guess.
3. **ONE CHANGE PER ATTEMPT:** Modify exactly ONE logic block per attempt when debugging extraction
4. **VERIFY AT EVERY BOUNDARY:** Count items, sample rows, compare to expected
5. **STREAMING FOR SCALE:** Prefer streaming/iterator for 100KB+ inputs
6. **EXHAUST TOOLS FIRST:** Never ask user before exhausting all tools

### 15.2 Error Taxonomy (10 classes)
| Class | Type | Strategy |
|-------|------|----------|
| A | missing_import | Check imports + package.json, install |
| B | type_error | Fix annotation or value |
| C | syntax_error | Find and fix syntax |
| D | missing_file | Create or fix reference |
| E | port_conflict | Kill process or use different port |
| F | dependency_error | Check versions, reinstall |
| G | permission_error | No elevated perms, use alternative |
| H | logic_error | Re-read files, rethink approach |
| I | timeout | Simpler approach or smaller batch |
| J | unknown | Read relevant files first |

### 15.3 Fresh Eyes Rule
> If same error occurs 3+ times with same approach → STOP, identify ROOT CAUSE, take completely different approach.

### 15.4 Write-Verify Rule
> After EVERY write/edit → immediately read back → confirm key changes → only then move on.

### 15.5 Completion Criteria (all must be true)
1. All planned edits confirmed present (read-back verified)
2. Lint/type-check passes
3. Tests pass
4. Required server validation passes

---

## 16. Troubleshooting & Common Fixes

### 16.1 Agent Issues
| Symptom | Cause | Fix |
|---------|-------|-----|
| Agent says "scanning" but no tools called | Voice bible examples teach narration-only | Check SCAN/ANALYZE MANDATE section in system prompt |
| Agent stuck in loop | LoopDetector not catching pattern | Check LoopDetector thresholds in agent-loop.ts |
| Empty final reply | Model timeout or empty content | `EMPTY_FINAL_REPLY_FALLBACKS` array in index.ts |
| Model refuses to use tools | System prompt tool section missing | Check `<capabilities>` section is correct |
| Agent hallucinates file content | Model guessing instead of reading | Reinforce `<laws>` context-first rule |

### 16.2 Build/Deploy Issues
| Symptom | Cause | Fix |
|---------|-------|-----|
| `tsc` OOM | Complex AI SDK generics | Using `transpileModule()` in build script instead |
| Build succeeds but server fails | Missing module in dist | Check `scripts/build.js` includes all files |
| PM2 keeps restarting | Syntax error or missing dependency | `pm2 logs suny` to check error |
| Port 3500 in use | Another process | `kill $(lsof -t -i:3500)` or change port |

### 16.3 Bridge Issues
| Symptom | Cause | Fix |
|---------|-------|-----|
| Bridge not connecting | Missing token or wrong URL | Check bridge setup guide in BridgeSetup page |
| File operations fail | Bridge disconnected | Auto-reconnect logic in bridge-manager |
| Bridge timeout | Large files or slow commands | Increase timeout in tool definition |

### 16.4 Frontend Issues
| Symptom | Cause | Fix |
|---------|-------|-----|
| Logo too large/cropped | `objectFit` + `borderRadius` combo | Adjust width/height, use `cover` vs `contain` |
| WebSocket connection fails | Missing token | Check `useWebSocket.ts` query param construction |
| Chat messages not rendering | Stream format mismatch | Check `sanitizer.ts` event format |

### 16.5 Database Issues
| Symptom | Cause | Fix |
|---------|-------|-----|
| SQLITE_BUSY | Concurrent writes | Already mitigated with `busy_timeout=5000` |
| Missing columns | Migration not run | Check `schema_version` in app_settings |
| Migration failed | Duplicate migration | Check migration version number, add ALTER IF NOT EXISTS |

---

## 17. Skill System

### 17.1 Architecture
- 23 skills in `skills/*/SKILL.md` format
- Each SKILL.md has YAML frontmatter + markdown sections
- Loaded by `skill-loader.ts` → `classifyTask()` → `getActiveSkills()`

### 17.2 Skill Format
```yaml
---
name: skill-name
version: 1.0
author: addyosmani
description: Brief description
tags: [tag1, tag2]
---
## Overview
...
## Core Principles
...
## Workflow
...
## Examples
...
```

### 17.3 Activation
Skills are activated based on task classification. The system selects relevant skills and injects their content into the system prompt.

---

## 18. SDK Package (gaby-sdk)

### 18.1 Location
`packages/gaby-sdk/`

### 18.2 Structure
```typescript
// index.ts — Public exports
export { Tool, ToolResult, ToolContext } from './tool';
export { Extension, ExtensionMetadata } from './extension';
export { MemoryStore, MemoryEntry } from './memory';
export { AuthProvider, AuthSession } from './auth';
export { BillingProvider, UsageRecord } from './billing';
```

### 18.3 Purpose
Published npm package for extending SUNy:
- **Tool:** Define custom tools
- **Extension:** Build full extensions with lifecycle hooks
- **Memory:** Custom memory backends
- **Auth:** Custom auth providers
- **Billing:** Custom billing integrations

---

## Quick Reference

### Key Commands
```bash
# Development
npm run dev                    # Server + renderer concurrently
npm run dev:server             # Server only (ts-node-dev)
npm run dev:renderer           # Renderer only (Vite)

# Build
npm run build                  # Full build
node scripts/build.js          # Server only
cd src/renderer && npx vite build  # Renderer only

# Test
npm test                       # Vitest
npm run test:watch             # Watch mode

# Install all
npm run install:all            # Server + renderer + bridge

# Type check
npx tsc --noEmit               # TypeScript check
```

### Key Files for Quick Edits
| Task | File |
|------|------|
| Change agent behavior | `src/server/index.ts` (system prompt) |
| Add/modify tool | `src/server/power-tools.ts` |
| Add API route | `src/server/index.ts` (route registration) + new route file |
| Modify agent loop | `src/server/agent-loop.ts` |
| Add DB migration | `src/server/db.ts` (SCHEMA_MIGRATIONS array) |
| Add frontend page | `src/renderer/src/pages/` + `App.tsx` route |
| Add SSH/deploy command | Ask user to edit `.gitignore` + add script |
| Modify build | `scripts/build.js` |
| Add/edit provider | `src/server/agent.ts` |
| Change auth | `src/server/auth.ts` |
| Modify bridge | `src/server/bridge-manager.ts` |

### Critical Architecture Rules
1. **Server never touches user's filesystem** — always through bridge
2. **All tool execution through bridge** — never child_process on server
3. **System prompt is dynamically built** — not a static file
4. **WebSocket is primary transport** — REST for CRUD, WS for streaming
5. **SQLite with WAL** — no external database dependencies
6. **Vercel AI SDK** for native tool calling — no XML parsing
7. **Sanitization on ALL outgoing data** — no model names, no tokens, no paths

---

*This guide is maintained for AI agents working on the SUNy/GABy project.  
Last updated: May 2026*
