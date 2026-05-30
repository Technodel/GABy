import { Link } from 'react-router-dom';

// Theme-aware glow color
const GLOW_COLORS: Record<string, string> = {
  matrix: '41,255,122',
  suny:   '255,184,51',
  pro:    '36,93,255',
};
function getGlowColor(): string {
  try {
    const theme = localStorage.getItem('suny_ui_theme') || 'matrix';
    return GLOW_COLORS[theme] || GLOW_COLORS.matrix;
  } catch { return GLOW_COLORS.matrix; }
}
const glowRgb = getGlowColor();

const howItWorks = [
  { step: '01', title: 'You describe the goal', desc: 'Plain English. No commands, no file paths, no setup. Just tell SUNy what needs to happen.' },
  { step: '02', title: 'SUNy maps the project', desc: 'It reads the repo, understands the architecture, identifies affected files, and builds a plan.' },
  { step: '03', title: 'SUNy executes & verifies', desc: 'Writes code, runs lint, runs tests, checks outputs, retries on failures -- all automatically.' },
  { step: '04', title: 'You receive proof', desc: 'A Proof Panel shows every change, every check, every fix, and a rollback point for safety.' },
];

const useCases = [
  { label: 'Add a feature', eg: '"Add dark mode toggle to settings page"' },
  { label: 'Fix a bug', eg: '"Fix the 500 error on checkout when cart is empty"' },
  { label: 'Refactor code', eg: '"Convert all callbacks to async/await in auth module"' },
  { label: 'Write tests', eg: '"Add unit tests for the billing service"' },
  { label: 'Set up a project', eg: '"Init a React + TypeScript app with Tailwind"' },
  { label: 'Review & clean', eg: '"Find and remove unused imports across the project"' },
];

const visibleWins = [
  { title: 'One-Click Ship Mode', text: 'You describe the goal once. SUNy handles planning, edits, checks, and delivery in one guided flow.' },
  { title: '🧠 Code Conscience Alerts', text: 'SUNy notifies you whenever a change drifts from stated intent — before it reaches your codebase. Design memory is always active.' },
  { title: '🎯 Persistent Goal Tracking', text: 'Active goals survive across sessions with success criteria and evidence collection. SUNy picks up exactly where it left off.' },
  { title: 'Time-Stamped Chat + Reports', text: 'Every chat turn is timestamped to the second, and every SUNy answer can open a compact report with time spent, tokens, cost, and a human-time estimate.' },
  { title: '🧊 Freeze Brain Locks', text: 'Pin a project to a saved memory snapshot so SUNy keeps using the same blueprint and behavioral rules until you unfreeze it.' },
  { title: '📈 Confidence Dashboard', text: 'SUNy self-reports uncertainty on every turn. Low confidence automatically escalates to a stronger model. You always know how sure it is.' },
  { title: 'Proof Panel', text: 'Every run ends with evidence: changed files, checks executed, outcomes, and fixes applied.' },
  { title: 'Live Execution Timeline', text: 'You can watch each stage happen in real time: plan, edit, test, fix, done.' },
  { title: 'Checkpoint Rollback', text: 'Each turn creates a restore point so you can return to any earlier working version instantly.' },
  { title: 'Project-Specific Rules & Persona', text: 'Customize SUNy per project. You can define specific coding rules, behavioral guidelines, and distinct personas so SUNy perfectly adapts to each codebase\'s unique culture.' },
  { title: '🎭 Prompt Variants', text: 'Switch AI personas, tones, and strategies on the fly. Senior Engineer, Patient Teacher, Test-First, or create your own custom variant.' },
  { title: '🌐 Browser Automation', text: 'SUNy navigates web pages, takes screenshots, fills forms, and extracts live data. Perfect for testing and site verification.' },
  { title: '⏰ Scheduled Agents', text: 'Set it and forget it. Schedule SUNy to run daily code reviews, weekly dependency audits, or hourly health checks automatically.' },
  { title: '📱 Local File Access', text: 'Securely access your local files directly in the browser. Select your project folder and SUNy can read, write, and edit files with your permission.' },
  { title: '🏪 MCP Marketplace', text: 'Discover and install community MCP servers in one click. Databases, search, Docker, Slack, GitHub — all at your fingertips.' },
  { title: '🔗 Client Link (PRO)', text: 'Generate a secure, shareable URL for non-technical clients. They describe the change in plain language — you review, approve, and SUNy executes. Perfect for freelancers and agencies.' },
];

const coreWins = [
  { title: 'Adaptive Intelligence Routing', text: 'SUNy routes easy work to low-latency paths and complex tasks to deeper reasoning paths for better throughput and quality.' },
  { title: 'Verification-First Engine', text: 'SUNy validates output with linting, tests, and targeted correction loops before finalizing answers.' },
  { title: '🎯 Multi-Horizon Goal Stack', text: 'Persistent goal tracking with success criteria, evidence collection, attempt counting, and auto-completion when all criteria are met. Survives restarts.' },
  { title: '🔀 Parallel Hypothesis Engine', text: 'For complex problems, SUNy spawns 2-3 mini-agents with different strategies (direct edit, refactor first, test first) and selects the best result.' },
  { title: '📊 Task Dependency Graph', text: 'DAG-based task decomposition — SUNy understands what must be done before what, works leaves first, and rolls up to the root goal.' },
  { title: '🔮 SUNy Code Conscience — Design Memory', text: 'SUNy remembers every design decision across sessions. Blueprint entries persist intent, architecture choices, and outcomes so every turn compounds knowledge.' },
  { title: '🛡️ SUNy Code Conscience — Change Guardian', text: 'An intent-aware guardian that snapshots TypeScript signatures before changes and detects semantic drift automatically — catching unintended contract breaks before they ship.' },
  { title: '🧊 Freeze Brain Snapshot Mode', text: 'When a project is frozen, the agent loop reuses the pinned snapshot’s behavioral rules and blueprint instead of live memory, keeping project reasoning stable.' },
  { title: 'Repository Memory Graph', text: 'SUNy keeps long-lived project memory about structure, style, and decisions to reduce re-discovery and drift.' },
  { title: 'Surgical Edit Discipline', text: 'Changes are applied with minimal, precise diffs to reduce regressions and preserve stable behavior.' },
  { title: '📦 @suny/sdk Plugin System', text: 'A full TypeScript SDK for building extensions. Custom tools, memory adapters, auth providers, and billing plugins with clean interfaces.' },
  { title: '📸 Rich Checkpoint Manager', text: 'Every change creates a DB-backed checkpoint with tags, file counts, and metadata. Full timeline UI with one-click rollback that works across projects.' },
  { title: '🔄 Integrated Scheduler Engine', text: 'Built-in cron scheduler that runs agent tasks at specified intervals. Hourly, daily, weekly, or custom cron expressions with run logs and failure tracking.' },
  { title: '⚡ Token Saving Engine', text: 'A multi-layered cost optimization engine that uses Prompt Caching, Tool Schema Pruning, and Context Compression to reduce token usage by up to 60% per task.' },
];

export default function WhatIsSUNy() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text-primary)' }}>
      <style>{`
        @keyframes whatisReveal {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .whatis-reveal { opacity: 0; animation: whatisReveal 420ms ease forwards; }
        .whatis-r1 { animation-delay: 70ms; }
        .whatis-r2 { animation-delay: 140ms; }
        .whatis-r3 { animation-delay: 210ms; }

        @media (max-width: 760px) {
          .whatis-shell { padding: 24px 14px 42px !important; }
          .whatis-hero-title { font-size: 30px !important; }
          .whatis-hero-copy { font-size: 14px !important; }
          .whatis-nav { gap: 8px !important; }
          .whatis-nav a { flex: 1; justify-content: center; text-align: center; }
        }
      `}</style>
      <div className="whatis-shell" style={{ maxWidth: 1080, margin: '0 auto', padding: '34px 24px 54px' }}>

        <div className="whatis-nav whatis-reveal whatis-r1" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
          <Link to="/login" className="btn btn-secondary" style={{ textDecoration: 'none' }}>Back to Login</Link>
          <Link to="/about" className="btn btn-secondary" style={{ textDecoration: 'none' }}>About Page</Link>
        </div>

        <section className="whatis-reveal whatis-r1" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '28px 26px', marginBottom: 28, background: `linear-gradient(180deg, rgba(${glowRgb},0.10) 0%, rgba(${glowRgb},0.02) 60%, transparent 100%)` }}>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--accent)', marginBottom: 10 }}>What is SUNy?</div>
          <h1 className="whatis-hero-title" style={{ fontSize: 36, lineHeight: 1.15, marginBottom: 14 }}>SUNy is not just AI chat. It is an execution engine for real project work.</h1>
          <p className="whatis-hero-copy" style={{ fontSize: 16, color: 'var(--text-secondary)', lineHeight: 1.75, maxWidth: 880 }}>
            Most AI products stop at suggestions. SUNy goes further: it reads context, performs the work, verifies outcomes, and gives proof. The goal is simple: reduce the time from idea to working result while keeping quality high.
          </p>
        </section>

        <section className="whatis-reveal whatis-r2" style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 22, marginBottom: 6 }}>How SUNy Works</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 18, maxWidth: 620 }}>Four steps from goal to verified result -- no commands, no manual steps.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {howItWorks.map(s => (
              <div key={s.step} className="card" style={{ borderTop: '2px solid var(--accent)' }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--accent)', letterSpacing: '0.12em', marginBottom: 8 }}>{s.step}</div>
                <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{s.title}</h3>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.65, margin: 0 }}>{s.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="whatis-reveal whatis-r2" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 22, marginBottom: 12 }}>Visible Features Users Feel Immediately</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 14 }}>These are the capabilities your users can see and trust from the first session.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
            {visibleWins.map((item) => (
              <div key={item.title} className="card" style={{ minHeight: 160 }}>
                <h3 style={{ fontSize: 16, marginBottom: 8 }}>{item.title}</h3>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>{item.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="whatis-reveal whatis-r3" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 22, marginBottom: 12 }}>Core Features That Build the Moat</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: 14 }}>These are backend and orchestration improvements that create speed, reasoning depth, and accuracy advantages.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
            {coreWins.map((item) => (
              <div key={item.title} className="card" style={{ minHeight: 170 }}>
                <h3 style={{ fontSize: 16, marginBottom: 8 }}>{item.title}</h3>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>{item.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="card whatis-reveal whatis-r3" style={{ marginBottom: 14 }}>
          <h2 style={{ fontSize: 20, marginBottom: 12 }}>SUNy Promise</h2>
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            SUNy is designed to behave like a reliable engineering operator: understand first, act precisely, verify always, and keep a clean recovery path when changes are risky. With <strong>SUNy Code Conscience</strong>, every decision is remembered, every drift is caught, and your project gets smarter with every session.
          </p>
        </section>

        <section className="card whatis-reveal whatis-r3">
          <h2 style={{ fontSize: 20, marginBottom: 12 }}>Who Is It For?</h2>
          <p style={{ color: 'var(--text-secondary)', lineHeight: 1.8, marginBottom: 16 }}>
            Teams and founders who need actual outcomes, not just explanations. SUNy is for people who want to ship faster, with better confidence, while staying in control of cost and quality.
          </p>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Common tasks people give SUNy:</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginBottom: 16 }}>
            {useCases.map(u => (
              <div key={u.label} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{u.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>{u.eg}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
            <Link to="/login" className="btn btn-primary" style={{ textDecoration: 'none' }}>Start with SUNy</Link>
            <Link to="/contact" className="btn btn-secondary" style={{ textDecoration: 'none' }}>Contact Team</Link>
          </div>

          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: `rgba(${glowRgb},0.04)`, color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.65 }}>
            Prefer predictable spend? SUNy uses credit-based execution, so lightweight fixes stay low-cost and bigger deliverables scale with real work only.
          </div>
        </section>

      </div>
    </div>
  );
}
