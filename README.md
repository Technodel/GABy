# SUNy — Smart Unstoppable Navigator

SUNy is an AI coding sidekick that doesn't just suggest — it executes. Give it a goal in plain English, and it reads your project, plans the work, writes the code, runs the tests, and keeps going until the goal is done.

---

## Quick Start

### Prerequisites

- **Node.js 20+** and **npm**
- One or more LLM API keys (Groq, OpenRouter, DeepSeek, etc.)
- A domain with SSL if deploying publicly (optional)

### Setup

```bash
# 1. Extract and install
# Extract the provided SUNy folder
cd suny
npm install
cd src/renderer && npm install && cd ../..

# 2. Configure environment
cp .env.example .env
# Edit .env — set at minimum:
#   SUNY_ADMIN_PASSWORD=<your-admin-password>
#   SUNY_SECRET_JWT=<random-32-char-string>
#   SUNY_GROQ_KEY=<your-groq-api-key>

# 3. Run development
npm run dev
```

Open `http://localhost:5173` in your browser. Login with admin / your password.

### Production Build

```bash
npm run build
npm start
```

Or deploy with Docker:

```bash
docker compose build --no-cache
docker compose up -d
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for full VPS/nginx/SSL deployment guide.

---

## Architecture

```
suny/
├── src/
│   ├── server/          # Backend — Express + SQLite + AI agent loop
│   │   ├── index.ts     # Express server entry point
│   │   ├── agent-loop.ts# Vercel AI SDK streaming agent loop
│   │   ├── agent.ts     # Model selection, mode config
│   │   ├── db.ts        # SQLite setup with schema migrations
│   │   ├── billing.ts   # Credit-based usage billing
│   │   ├── verifier.ts  # Write verification + completion criteria
│   │   ├── narrator.ts  # Plain-English progress narration
│   │   ├── goal-tracker.ts  # Persistent multi-horizon goal stack
│   │   ├── failure-memory.ts# Error pattern storage for smarter retries
│   │   ├── power-tools.ts   # File edit/search/command tools
│   │   ├── bridge-manager.ts# IDE bridge integration (VS Code plugin)
│   │   └── ... (70+ modules)
│   └── renderer/        # Frontend — React + Vite + TypeScript
│       └── src/
│           ├── pages/
│           │   ├── Chat.tsx      # Main chat interface
│           │   ├── About.tsx     # About & features (EN/AR)
│           │   ├── WhatIsSUNy.tsx# Detailed feature showcase
│           │   ├── Login.tsx     # Login page
│           │   ├── AdminPanel.tsx# Admin dashboard
│           │   └── ...
│           └── components/       # Reusable UI components
├── docs/                # Documentation
├── DEPLOYMENT.md        # VPS deployment instructions
├── nginx.conf           # nginx proxy config with SSL + WebSocket
├── docker-compose.yml   # Docker compose setup
└── Dockerfile           # Container build
```

---

## Core Concepts

### 🔄 The Agent Loop

SUNy uses Vercel AI SDK's `streamText` with native tool calling. The flow:

1. **Analyze** — reads your project, understands architecture
2. **Plan** — creates a step-by-step plan
3. **Execute** — writes files, runs commands, checks outputs
4. **Verify** — runs lint, tests, type-checking automatically
5. **Retry** — if something fails, tries a different approach
6. **Complete** — delivers proof of completion

No XML parsing, no hallucinated tool calls. The AI SDK handles the loop natively.

### 🧠 SUNy Code Conscience

A persistent design memory and intent-aware change guardian:

- **Design Memory** — remembers every design decision across sessions
- **Change Guardian** — snapshots TypeScript signatures before changes, detects semantic drift
- **Compounds over time** — the more you use it, the smarter it gets

### 🎯 Goal Tracking

Persistent goal stack that survives across sessions. SUNy remembers what it was working on and picks up exactly where it left off — not from chat history, but from the goal's measured state with success criteria and evidence collection.

### 🔋 Modes

| Mode | Cost | Use Case |
|------|------|----------|
| ⚡ Free | Almost free | Quick tasks, simple questions |
| 🚀 Fast Smart | Low | Coding, debugging, everyday tasks |
| 🧠 Smart Pro | Moderate | Complex analysis, deep reasoning |

### 🔐 Billing

Credit-based with transparent pricing. Admins set balances, users see their remaining credits at all times. No surprise charges.



## Key Features

| Feature | Description |
|---------|-------------|
| **Self-Healing** | Detects build/lint/test errors and retries with different strategies |
| **Verification-First** | Every output validated with linting, tests, and targeted correction loops |
| **Failure Memory** | Stores error patterns and what fixes worked — avoids repeating failed strategies |
| **Confidence Scoring** | Self-reports uncertainty, escalates to stronger models automatically |
| **Parallel Hypothesis Testing** | Spawns multiple mini-agents with different strategies, picks the best result |
| **Task Dependency Graph** | DAG-based task decomposition — understands what must be done first |
| **Live Progress Narration** | Streams real-time progress updates to the UI |
| **Cross-Session Learning** | High-confidence patterns carry over between sessions |
| **Project Mapping** | Reads and indexes your entire project before making changes |
| **Semantic Code Index** | Builds a searchable index of code structure |
| **Checkpoint Rollback** | Creates restore points so you can revert to any earlier version |
| **Proof Panel** | Every run ends with evidence: changed files, checks executed, outcomes |
| **Multi-Agent Review** | Spawns reviewer agents for complex changes |
| **Test Generation** | Automatically generates tests for new code |
| **Session Replay** | Full audit trail with replay capability |
| **Operation Audit** | Every action logged for transparency |
| **MCP Support** | Model Context Protocol — extensible tool ecosystem |

---

## Environment Variables

See [.env.example](.env.example) for a full list. Required:

| Variable | Description |
|----------|-------------|
| `SUNY_ADMIN_PASSWORD` | Admin login password |
| `SUNY_SECRET_JWT` | JWT signing secret (min 32 chars) |
| `SUNY_ALLOWED_ORIGIN` | CORS origin (your domain) |
| `SUNY_GROQ_KEY` | Groq API key (free mode) |
| `SUNY_OPENROUTER_KEY` | OpenRouter key (fallback) |

---

## Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) — VPS setup with Docker, nginx, SSL
- [THE_ENGINE.md](THE_ENGINE.md) — System prompt architecture for self-correcting agents
- [AGENT_METHODOLOGY.md](AGENT_METHODOLOGY.md) — Agent behavior and workflow methodology
- [nginx.conf](nginx.conf) — SSL/WebSocket proxy configuration

---

## License

Private — Technodel.Tech
