import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

type Lang = 'en' | 'ar';

interface PlanFeatureFlag {
  key: string;
  plan: string;
  enabled: boolean;
  label: string;
  description: string;
}

export default function About() {
  const [lang, setLang] = useState<Lang>(() => {
    const browserLang = navigator.language.split('-')[0];
    return browserLang === 'ar' ? 'ar' : 'en';
  });

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: 32 }}>
      <style>{`
        @keyframes aboutReveal {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .about-reveal { opacity: 0; animation: aboutReveal 360ms ease forwards; }
        .about-r1 { animation-delay: 60ms; }
        .about-r2 { animation-delay: 130ms; }

        @media (max-width: 760px) {
          .about-shell { padding: 16px !important; }
          .about-topbar {
            flex-direction: column;
            align-items: stretch !important;
          }
          .about-topbar > a { justify-content: center; }
          .about-lang { justify-content: center; }
        }
      `}</style>
      <div className="about-shell" style={{ maxWidth: 800, margin: '0 auto' }}>
        <div className="about-topbar about-reveal about-r1" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, gap: 8 }}>
          <Link to="/login" className="btn btn-secondary" style={{ textDecoration: 'none', fontSize: 13 }}>Back to Login</Link>
          <div className="about-lang" style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={() => setLang('en')} style={{ background: lang === 'en' ? 'var(--accent)' : 'var(--surface)', color: lang === 'en' ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              English
            </button>
            <button className="btn btn-sm" onClick={() => setLang('ar')} style={{ background: lang === 'ar' ? 'var(--accent)' : 'var(--surface)', color: lang === 'ar' ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              العربية
            </button>
          </div>
        </div>
        <div className="about-reveal about-r2">
          {lang === 'en' ? <EnglishContent /> : <ArabicContent />}
        </div>
      </div>
    </div>
  );
}

function EnglishContent() {
  const [planFlags, setPlanFlags] = useState<PlanFeatureFlag[]>([]);

  useEffect(() => {
    fetch('/api/plan-features-public')
      .then(r => r.ok ? r.json() : {})
      .then(d => { if (d?.flags && Array.isArray(d.flags)) setPlanFlags(d.flags); else if (Array.isArray(d)) setPlanFlags(d); })
      .catch(() => {});
  }, []);

  const proOnlyKeys = new Set(
    planFlags
      .filter(f => f.plan === 'pro' && f.enabled)
      .filter(f => !planFlags.some(r => r.plan === 'regular' && r.key === f.key && r.enabled))
      .map(f => f.key)
  );
  const proOnlyFlags = planFlags.filter(f => f.plan === 'pro' && f.enabled && proOnlyKeys.has(f.key));

  const PRO_KEY_MAP: Record<string, string> = {
    pf_advanced_visual_portal: 'Visual Portal',
    pf_parallel_agent_swarm:   'Agent Swarm',
    pf_hypothesis_engine:      'Hypothesis',
    pf_scheduled_agents:       'Scheduled Agent',
    pf_client_portal:          'Client Ticket',
    pf_push_notifications:     'Push Notification',
    pf_cost_forecast:          'Cost Estimate',
    pf_budget_gate:            'Budget Gate',
  };

  function isProCard(title: string): boolean {
    return Object.entries(PRO_KEY_MAP).some(([key, kw]) => proOnlyKeys.has(key) && title.includes(kw));
  }


  return (
    <div className="page-enter">
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>Meet SUNy -- Your Personal Coding Sidekick</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 32, fontSize: 15, lineHeight: 1.7 }}>
        SUNy is the coding buddy you always wished you had -- one that never gets tired, never judges your questions, and does not stop until your project is done.
      </p>

      <div className="card" style={{ marginBottom: 24, borderColor: 'var(--accent)', background: 'rgba(108,99,255,0.04)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>Message timelines and task reports</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, margin: 0 }}>
          Every chat turn now shows the exact sent or received time to the second, and SUNy replies can open a compact report with task duration, tokens, cost, and a human-time estimate.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 24, borderColor: 'var(--accent)', borderWidth: 2, background: 'rgba(108,99,255,0.06)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>🧠 SUNy Code Conscience</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          SUNy is the first coding sidekick with a persistent design memory and an intent-aware change guardian built in. We call it the <strong>Code Conscience</strong> — and it works across sessions automatically.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {[
            { title: '🧬 Design Memory', desc: 'Persistent blueprint memory keeps intent, architecture choices, and outcomes available across sessions — across restarts, projects, and teams.' },
            { title: '🛡️ Change Guardian', desc: 'Before changes reach your code, SUNy checks whether they drift from your stated intent. Unintended contract changes are flagged instantly.' },
            { title: '⏳ Compound Knowledge', desc: 'Every session makes SUNy smarter about your project. Design memory compounds like a knowledge flywheel — the more you use it, the better it gets.' },
            { title: '🔍 Multi-Signal Ranking', desc: 'Design memories are now scored with a fusion of vector similarity, FTS5 full-text search, keyword overlap, and entity matching — all ranked with temporal decay. The most relevant design decisions surface first.' },
            { title: '🧬 Entity-Aware Retrieval', desc: 'SUNy extracts entities (technologies, patterns, concepts) from every interaction and links them to memory entries. When you ask about a specific tech or pattern, matching entities boost the relevance of related memories.' },
            { title: '⏱️ Temporal Ranking', desc: 'Search results are exponentially decayed by age — newer entries rank higher, but old high-value entries with strong semantic matches still surface. Half-life of ~14 days keeps the balance fresh.' },
          ].map(f => {
            const cleanTitle = f.title.replace(/ ?⚡PRO/g, '').trim();
            const isPro = isProCard(cleanTitle);
            return (
              <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: `1px solid ${isPro ? 'rgba(108,99,255,0.3)' : 'var(--border)'}`, background: 'var(--bg)', position: 'relative' }}>
                {isPro && (
                  <span style={{ position: 'absolute', top: 8, right: 8, fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(108,99,255,0.15)', color: 'var(--accent)', border: '1px solid rgba(108,99,255,0.3)' }}>⚡ PRO</span>
                )}
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, paddingRight: isPro ? 44 : 0 }}>{cleanTitle}</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>{f.desc}</p>
              </div>
            );
          })}
        </div>
      </div>

      <div id="pro" className="card" style={{ marginBottom: 24, borderColor: 'var(--accent)', borderWidth: 2, background: 'rgba(108,99,255,0.06)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>🧪 What&apos;s New in This Version</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          A growing set of capabilities that take SUNy to the next level.
        </p>
        {/* Dynamic PRO Features */}
        {proOnlyFlags.length > 0 && (
          <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 'var(--radius)', border: '1px solid rgba(108,99,255,0.4)', background: 'rgba(108,99,255,0.07)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 15 }}>⚡</span>
              <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--accent)' }}>PRO Plan — Exclusive Features</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
              {proOnlyFlags.map(f => (
                <div key={f.key} style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(108,99,255,0.25)', background: 'var(--bg)' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{f.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{f.description}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>Contact your administrator to upgrade your account to PRO.</div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {[
            { title: '🧊 Freeze Brain', desc: 'Lock a project to a saved memory snapshot so SUNy keeps using the same blueprint and behavioral rules until you unfreeze it.' },
            { title: '🎭 Prompt Variants', desc: 'A/B test different AI personas, tones, and strategies. Switch between Senior Engineer, Patient Teacher, or Test-First modes — or create your own custom variant.' },
            { title: '📸 Checkpoint Timeline', desc: 'Every change is saved as a named checkpoint. Browse your full history with file counts, tags, and one-click rollback to any earlier state.' },
            { title: '🌿 Fork Conversation', desc: 'Use the fork button in chat to save an instant snapshot before trying a new direction. You can restore any fork later from the Forks menu.' },
            { title: '🚧 @suny/sdk', desc: 'The official SDK for building SUNy extensions. Create custom tools, memory adapters, auth providers, and billing plugins with full TypeScript support.' },
            { title: '🚧 Scheduled Agents', desc: 'Schedule SUNy to run automatically — daily code reviews, weekly dependency audits, hourly health checks. Set it and forget it.' },
            { title: '🌐 Browser Automation', desc: 'SUNy can navigate web pages, take screenshots, fill forms, and extract data. Perfect for testing, scraping, and live site verification.' },
            { title: '🚧 MCP Marketplace', desc: 'Discover and install community-contributed MCP servers. Databases, search engines, Docker, Slack, GitHub — all pluggable in one command.' },
            { title: '🧠 Composable Behavior Profiles', desc: 'SUNy now composes multiple behavior sources — past interactions, learned rules, project context, and active skills — into a single weighted behavior profile. Inspired by activation-space controllers, stronger signals dominate while weaker ones still contribute. No more verbose memory dumps.' },
            { title: '🔍 Multi-Signal Memory Retrieval', desc: 'AI memory now fuses three retrieval signals — vector similarity, FTS5 full-text search, and keyword overlap — ranked with temporal decay. Results are sorted by fused relevance score, not just recency, so the most useful memories rise to the top.' },
            { title: '🧬 Entity Extraction & Linking', desc: 'SUNy automatically extracts entities (technologies, patterns, file paths, function names) from every interaction and links them to the source memory. This enables entity-aware retrieval where matching entities boost memory scores.' },
            { title: '📝 ADD-Only User Memory', desc: 'Saved user memories are now immutable — written once and never edited or deleted. This preserves a complete audit trail of everything the user has asked SUNy to remember, with no risk of data loss.' },
            { title: '🎫 Client Tickets (Fast/Smart)', desc: 'Generate a secure, shareable URL for non-technical clients. SUNy acts as your front-line assistant, chatting warmly with the client to gather detailed project requirements.' },
            { title: '🔭 Advanced Visual Portal ⚡PRO', desc: 'The ultimate Client Ticket upgrade. Clients get a visual overlay on your live staging app. They click a button on their screen, type a change, and SUNy automatically maps it to your code and writes the fix.' },
            { title: '⚡ Parallel Agent Swarm ⚡PRO', desc: 'SUNy acts as a Project Manager, spawning a swarm of Junior Developer AIs to handle massive features. Watch it write the frontend, backend, and tests simultaneously in real-time, cutting execution time by 70%.' },
            { title: '📋 Pre-Run Cost Estimate', desc: 'Before every run, SUNy shows a cost forecast with a low/high credit range based on your history or a lightweight AI analysis. You decide whether to proceed — no surprise bills.' },
            { title: '🔒 Per-Run Budget Gate', desc: 'Set a credit cap per run. SUNy tracks cumulative spend and alerts you when it hits the limit, giving you full visibility and control over costs.' },
            { title: '🧠 AI Learns Your Style', desc: 'SUNy now builds a structured model of your preferences, working style, tech choices, and hard constraints — updated silently as it observes patterns. Every session it knows you a little better.' },
            { title: '💾 AI Memories Panel', desc: 'See exactly what SUNy has saved about you. A new sidebar panel lists every AI memory with one-click delete — full transparency into what the AI knows.' },
            { title: '🌿 Git Worktree Isolation', desc: 'For risky or large changes, SUNy creates an isolated git worktree branch, makes all changes there, verifies them, then merges back — your main branch is never touched until it\'s proven to work.' },
            { title: '⚠️ Human Checkpoint Gates', desc: 'SUNy can pause mid-task and ask for your approval before continuing past a risky or irreversible step — keeping you in control of consequential decisions.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24, borderColor: 'var(--success)', borderWidth: 2, background: 'rgba(34,197,94,0.06)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>🗺️ Smart Code Navigation</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          SUNy no longer starts blind. Five new systems dramatically reduce token usage and speed up targeted edits by 60–80%. Instead of reading 50 files to find one line, SUNy navigates directly to the right spot.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {[
            { title: '🔍 Semantic Code Search', desc: 'SUNy queries the persistent code index by symbol name or concept — returns exact file paths and line numbers. No more scanning the whole project.' },
            { title: '📁 Auto .suny-rules', desc: 'After indexing, SUNy auto-generates a .suny-rules file with the top 50 exports organized by file — a human-readable project map loaded into every session.' },
            { title: '🔗 Who Imports This?', desc: 'Before editing a symbol, SUNy checks its blast radius — finds every file that imports it so no downstream breakage is missed.' },
            { title: '📐 Scope Declaration Law', desc: 'SUNy must declare its edit target and confidence level before every change. Low confidence triggers a code_search call first — preventing wrong-file edits.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── NEW: Token Saving Engine + Watchdog + Resilience ── */}
      <div className="card" style={{ marginBottom: 24, borderColor: '#f59e0b', borderWidth: 2, background: 'rgba(245,158,11,0.05)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>⚡ Token Saving Engine — Pay Less Than Direct AI Model Pricing</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          SUNy's dedicated Token Saving Engine uses <strong>5 optimization strategies</strong> to reduce your token usage on every request — making it cheaper to use SUNy than the original AI models directly.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {[
            { title: '🔄 Prompt Caching', desc: 'Repeated context (system prompts, conversation history) is cached at the provider level. Cache hits cost 90% less than fresh tokens — the #1 savings driver.' },
            { title: '✂️ Tool Schema Pruning', desc: 'Instead of loading all 25+ tool schemas every turn, the engine only includes tools relevant to the current task. A coding task skips web_search; a Q&A skips file_write. Saves ~2,000–4,000 tokens per turn.' },
            { title: '📦 Conversation Compression', desc: 'Older turns are compressed into concise summaries instead of being dropped entirely. You keep the context, at a fraction of the token cost.' },
            { title: '🔍 Redundant File Dedup', desc: 'When the same file is read twice in a session, the second read is replaced with a reference to the first — eliminating duplicate content tokens.' },
            { title: '🧹 Boilerplate Stripping', desc: 'Common AI filler phrases ("Sure!", "I\'ll help you with that") are stripped from assistant history before sending to the model — every token counts.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(245,158,11,0.25)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24, borderColor: '#ef4444', borderWidth: 2, background: 'rgba(239,68,68,0.05)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>🛡️ Zero-Downtime Watchdog</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          If SUNy ever writes a bad edit that crashes your dev server, the Watchdog detects it within milliseconds, automatically rolls back to the last safe checkpoint, and notifies you — all before you even notice the server went down.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {[
            { title: '🚨 Crash Detection', desc: 'Every background process stderr is scanned in real-time for fatal signatures: SyntaxError, TypeError, Module Not Found, Vite internal error.' },
            { title: '⏪ Instant Rollback', desc: 'On crash, the Watchdog auto-calls rollbackToCheckpoint() to restore the last safe git state — your working dev server is back in seconds.' },
            { title: '🔔 Silent Self-Heal', desc: 'A 🛡️ Watchdog triggered banner appears in chat with the rollback details. SUNy receives the stack trace and self-corrects without you lifting a finger.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(239,68,68,0.2)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24, borderColor: '#06b6d4', borderWidth: 2, background: 'rgba(6,182,212,0.05)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>🔄 Session Resilience — SUNy Never Loses Your Work</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7 }}>
          Close the browser, shut down your PC, lose your internet — SUNy picks up exactly where it left off when you reconnect. Every task, checkpoint, and memory is persisted to disk and restored automatically on next login. Nothing is ever lost.
        </p>
      </div>

      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>What can SUNy do for you?</h2>

      {[
        { icon: 'GOAL', title: '🎯 Persistent Goal Tracking', desc: 'SUNy remembers what it was working on across sessions. Active goals persist with success criteria and evidence collection. Pick up exactly where you left off.' },
        { icon: 'NAV', title: '🗺️ Smart Code Navigation', desc: 'SUNy uses semantic code search, on-demand repo maps, and auto-generated project rules to find files instantly — no more scanning 50 files to find one line.' },
        { icon: 'READ', title: 'It reads your entire project', desc: 'SUNy explores your project automatically to understand how everything fits together before touching a single file.' },
        { icon: 'EDIT', title: 'It writes, edits & creates files', desc: 'SUNy can create new files, modify existing ones, and organize your project -- all without you lifting a finger.' },
        { icon: 'AUTO', title: 'It handles the hard stuff automatically', desc: 'SUNy runs everything behind the scenes while keeping you in the loop with friendly, plain-English updates.' },
        { icon: 'LOOP', title: 'It does not give up', desc: 'If something does not work the first time, SUNy tries a different approach. It keeps going until it gets it right.' },
        { icon: 'DIAG', title: '🔀 Parallel Hypothesis Testing', desc: 'For tough problems, SUNy spawns multiple mini-agents with different strategies simultaneously and picks the best result.' },
        { icon: 'DAG', title: '📊 Task Dependency Graph', desc: 'Complex tasks are decomposed into dependency-ordered steps. SUNy works the graph -- unblocks nodes, completes leaves first, rolls up to the goal.' },
        { icon: 'CONF', title: '📈 Confidence Scoring', desc: 'SUNy self-reports uncertainty on every turn. Low confidence triggers automatic escalation to a stronger model.' },
        { icon: 'PROJ', title: 'Multiple Projects', desc: 'Work on as many projects as you need. SUNy keeps everything organized and separate.' },
        { icon: 'MEM', title: 'It gets smarter the more you use it', desc: 'SUNy remembers your preferences, your project style, and your past decisions -- so every session feels familiar.' },
        { icon: 'LANG', title: 'Plain English, always', desc: 'No tech jargon. SUNy explains what it is doing in a way that actually makes sense.' },
        { icon: 'BAL', title: "You're in control of your budget", desc: 'Your admin sets a credit balance for you. SUNy shows you what you have left at all times -- no surprise charges.' },
      ].map(f => (
        <div key={f.icon} className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 }}>{f.desc}</p>
        </div>
      ))}

      <div className="card" style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>What Makes SUNy Different From Regular AI Chat?</h2>
        <table>
          <thead>
            <tr>
              <th>Regular AI Chat</th>
              <th>SUNy</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Gives you code to copy-paste', 'Actually writes the files in your project'],
              ['You run the commands yourself', 'SUNy runs everything automatically'],
              ['Stops after one answer', 'Keeps going until the full goal is done'],
              ['Technical interface', 'Plain English, friendly, no jargon'],
            ].map(([old, suny]) => (
              <tr key={old}>
                <td style={{ color: 'var(--text-muted)' }}>{old}</td>
                <td style={{ color: 'var(--success)' }}>{suny}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 24, borderColor: 'var(--success,#22c55e)', background: 'rgba(34,197,94,0.04)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Costs More or Less?</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7 }}>
          SUNy is <strong>surprisingly affordable</strong>. Most tasks cost just a few cents. You only pay for what SUNy actually does, and we keep the pricing transparent. You always see your credit balance -- no surprise charges, ever.
        </p>
      </div>

      <div style={{ marginTop: 16, padding: '20px 24px', borderRadius: 'var(--radius)', border: '1px solid var(--accent)', background: 'rgba(108,99,255,0.06)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>Is the result guaranteed?</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7 }}>
          Yes -- SUNy does not give up after one attempt. It tests, evaluates, retries, and keeps going until the goal is done.
          <strong> It works the same way a skilled human developer would</strong> -- not by handing you a script, but by actually doing the work, running it, checking it, and fixing it until it works.
        </p>
      </div>

      {/* Privacy notice */}
      <div style={{ marginTop: 16, padding: '12px 16px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'rgba(34,197,94,0.04)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ fontSize: 18, flexShrink: 0 }}>🔒</span>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.7, margin: 0 }}>
          <strong style={{ color: 'var(--text-secondary)' }}>Your files never reach us.</strong> SUNy runs entirely on your machine — your data, memories, and projects stay local. When SUNy processes a task, relevant code is sent to the AI models under their privacy policy, but your files are totally safe. We never see your data.
        </p>
      </div>

      {/* PRO Features callout */}
      <div id="pro" style={{ marginTop: 24, padding: '24px 28px', borderRadius: 'var(--radius)', border: '2px solid rgba(108,99,255,0.4)', background: 'linear-gradient(135deg, rgba(108,99,255,0.08) 0%, rgba(108,99,255,0.03) 100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 22 }}>⚡</span>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>SUNy PRO</h2>
          <span style={{ fontSize: 10, fontWeight: 700, background: 'rgba(108,99,255,0.2)', color: 'var(--accent)', border: '1px solid rgba(108,99,255,0.4)', borderRadius: 4, padding: '2px 8px' }}>PREMIUM</span>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, marginBottom: 14 }}>
          PRO unlocks financial control features built for serious developers and agencies — budget gates, pre-run cost estimates, push notification receipts, and more. Features are managed by your admin.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {['🔒 Per-Run Budget Gate', '📋 Pre-Run Cost Estimate', '🔔 Push Notifications & Receipts', '⚡ Parallel Agent Swarm', '🔬 Hypothesis Testing', '🚧 Scheduled Agents', '🎫 Client Ticket Portal'].map(f => (
            <span key={f} style={{ fontSize: 12, padding: '4px 10px', background: 'rgba(108,99,255,0.1)', color: 'var(--text-primary)', borderRadius: 20, border: '1px solid rgba(108,99,255,0.2)' }}>{f}</span>
          ))}
        </div>
        <Link to="/pro-features" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: 'var(--accent)', textDecoration: 'none', padding: '8px 18px', border: '1px solid rgba(108,99,255,0.4)', borderRadius: 7, background: 'rgba(108,99,255,0.08)' }}>
          See all PRO features →
        </Link>
      </div>
    </div>
  );
}

function ArabicContent() {
  return (
    <div dir="rtl" className="page-enter" style={{ fontFamily: "'Noto Sans Arabic', Inter, sans-serif" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8 }}>تعرف على SUNy -- مساعدك الشخصي في البرمجة</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 32, fontSize: 15, lineHeight: 1.8 }}>
        SUNy ليس مجرد اداة. SUNy هو رفيق البرمجة الذي كنت دائما تتمنى وجوده -- لا يتعب، لا يحكم عليك، ولا يتوقف حتى ينجز مشروعك.
      </p>

      <div className="card" style={{ marginBottom: 24, borderColor: 'var(--accent)', background: 'rgba(108,99,255,0.04)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>تواريخ الرسائل وتقارير المهام</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.8, margin: 0 }}>
          كل رسالة في المحادثة تظهر وقت الارسال او الاستقبال بدقة حتى الثواني، ويمكن لردود SUNy ان تفتح تقريرا صغيرا فيه مدة المهمة والتوكنز والتكلفة وتقدير الوقت البشري.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 24, borderColor: 'var(--accent)', borderWidth: 2, background: 'rgba(108,99,255,0.06)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>🧠 ضمير SUNy البرمجي (Code Conscience)</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.8, marginBottom: 16 }}>
          SUNy هو اول مساعد برمجة يمتلك ذاكرة تصميم دائمة وحارس تغيير يتحقق من النية. نسميه <strong>الضمير البرمجي</strong> — وهو يعمل تلقائيا عبر الجلسات.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {[
            { title: '🧬 ذاكرة التصميم', desc: 'SUNy يتذكر كل قرار تصميم تتخذه — عبر الجلسات والمشاريع. لا ينسى ابدا لماذا تم عمل شيء بطريقة معينة.' },
            { title: '🛡️ حارس التغيير', desc: 'قبل ان تصل التغييرات الى كودك، يتحقق SUNy مما اذا كانت تنحرف عن نيتك المعلنة. يتم اكتشاف تغييرات العقود غير المقصودة فورا.' },
            { title: '⏳ معرفة متراكمة', desc: 'كل جلسة تجعل SUNy اذكى بشأن مشروعك. ذاكرة التصميم تتراكم مثل دولاب المعرفة — كلما استخدمته اكثر، كلما اصبح افضل.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24, borderColor: 'var(--success)', borderWidth: 2, background: 'rgba(34,197,94,0.06)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>🗺️ التنقل الذكي في الكود</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.8, marginBottom: 16 }}>
          لم يعد SUNy يبدأ أعمى. خمسة أنظمة جديدة تقلل استخدام التوكنز وتسرّع التعديلات الموجهة بنسبة 60–80%. بدلاً من قراءة 50 ملفاً للعثور على سطر واحد، يتنقل SUNy مباشرة إلى المكان الصحيح.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {[
            { title: '🔍 البحث الدلالي في الكود', desc: 'يبحث SUNy في فهرس الكود الدائم بالاسم أو المفهوم — ويعيد مسارات الملفات وأرقام الأسطر بالضبط. لا مزيد من تصفح المشروع بأكمله.' },
            { title: '📋 خريطة المشروع عند الطلب', desc: 'أصبحت خريطة المشروع أداة يستدعيها SUNy فقط عند الحاجة، مما يوفر 1,500–2,500 توكن لكل طلب مقارنة بالحقن التلقائي.' },
            { title: '📁 التوليد التلقائي لـ .suny-rules', desc: 'بعد الفهرسة، يولّد SUNy ملف .suny-rules بأهم 50 تصديراً مرتبة حسب الملف — خريطة مشروع مقروءة تُحمّل في كل جلسة.' },
            { title: '🔗 من يستورد هذا؟', desc: 'قبل تعديل أي رمز، يتحقق SUNy من نطاق التأثير — يجد كل ملف يستورده حتى لا يفوت أي كسر.' },
            { title: '📐 قانون إعلان النطاق', desc: 'يجب على SUNy إعلان هدف التعديل ومستوى الثقة قبل كل تغيير. الثقة المنخفضة تؤدي إلى بحث دلالي أولاً.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Token Saving Engine — Arabic */}
      <div className="card" style={{ marginBottom: 24, borderColor: '#f59e0b', borderWidth: 2, background: 'rgba(245,158,11,0.05)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>⚡ محرك توفير التوكنز — ادفع أقل من تسعير نموذج الذكاء الاصطناعي مباشرة</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.8, marginBottom: 16 }}>
          محرك توفير التوكنز المخصص في SUNy يستخدم <strong>5 استراتيجيات تحسين</strong> لتقليل استخدام التوكنز في كل طلب — مما يجعل استخدام SUNy أرخص من استخدام نماذج الذكاء الاصطناعي مباشرة.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {[
            { title: '🔄 التخزين المؤقت للنصوص', desc: 'السياق المتكرر (نصوص النظام، تاريخ المحادثة) يتم تخزينه مؤقتاً عند المزود. نتائج التخزين المؤقت تكلف 90% أقل من التوكنز الجديدة.' },
            { title: '✂️ تقليم مخططات الأدوات', desc: 'بدلاً من تحميل جميع مخططات الأدوات في كل دورة، يحمّل المحرك فقط الأدوات المتعلقة بالمهمة الحالية. يوفر 2,000-4,000 توكن في كل دورة.' },
            { title: '📦 ضغط المحادثة', desc: 'الدورات القديمة تُضغط إلى ملخصات مختصرة بدلاً من حذفها بالكامل. تحتفظ بالسياق بجزء بسيط من تكلفة التوكنز.' },
            { title: '🔍 إزالة تكرار الملفات', desc: 'عند قراءة نفس الملف مرتين في جلسة واحدة، تُستبدل القراءة الثانية بمرجع للأولى — مما يزيل توكنز المحتوى المكررة.' },
            { title: '🧹 إزالة النصوص الزائدة', desc: 'العبارات التمهيدية الشائعة للذكاء الاصطناعي تُزال من سجل المساعد قبل إرسالها إلى النموذج — كل توكن يُحسب.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(245,158,11,0.25)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Watchdog — Arabic */}
      <div className="card" style={{ marginBottom: 24, borderColor: '#ef4444', borderWidth: 2, background: 'rgba(239,68,68,0.05)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>🛡️ الحارس اللحظي — انعدام وقت التوقف</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.8, marginBottom: 16 }}>
          إذا كتب SUNy تعديلاً سيئاً أدى إلى تعطل خادم التطوير، يكتشفه الحارس في ميلي ثانية، يتراجع تلقائياً إلى آخر نقطة حفظ آمنة، ويخطرك — كل ذلك قبل أن تلاحظ توقف الخادم.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {[
            { title: '🚨 كشف الأعطال', desc: 'يتم فحص stderr كل عملية خلفية في الوقت الفعلي بحثاً عن أخطاء فادحة: SyntaxError, TypeError, Module Not Found, Vite internal error.' },
            { title: '⏪ تراجع فوري', desc: 'عند الاكتشاف، يستدعي الحارس تلقائياً rollbackToCheckpoint() لاستعادة آخر حالة git آمنة — خادم التطوير يعود في ثوانٍ.' },
            { title: '🔔 إصلاح صامت', desc: 'تظهر لافتة 🛡️ في الدردشة مع تفاصيل التراجع. يتلقى SUNy تتبع المكدس ويصحح نفسه دون أن تحرك إصبعاً.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(239,68,68,0.2)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Session Resilience — Arabic */}
      <div className="card" style={{ marginBottom: 24, borderColor: '#06b6d4', borderWidth: 2, background: 'rgba(6,182,212,0.05)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>🔄 مرونة الجلسة — SUNy لا يفقد عملك أبداً</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.8 }}>
          أغلق المتصفح، أوقف تشغيل الكمبيوتر، افقد الإنترنت — سيستمر SUNy من حيث توقف عند إعادة الاتصال. كل مهمة ونقطة حفظ وذاكرة يتم تخزينها على القرص واستعادتها تلقائياً عند تسجيل الدخول التالي. لا شيء يضيع أبداً.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 24, borderColor: 'var(--accent)', borderWidth: 2, background: 'rgba(108,99,255,0.06)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>🧪 الجديد في هذه النسخة</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.8, marginBottom: 16 }}>
          ست قدرات رئيسية جديدة ترتقي بـ SUNy إلى المستوى التالي.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {[
            { title: '🎭 متغيرات النصوص التوجيهية', desc: 'اختبر شخصيات ونغمات واستراتيجيات مختلفة للذكاء الاصطناعي. بدّل بين المهندس الخبير، المعلم الصبور، أو نهج الاختبار اولا — او انشئ متغيرك الخاص.' },
            { title: '📸 الجدول الزمني لنقاط الحفظ', desc: 'كل تغيير يتم حفظه كنقطة حفظ مسماة. تصفح تاريخك الكامل مع عدد الملفات والوسوم واستعد اي حالة سابقة بنقرة واحدة.' },
            { title: '🌿 تفرع المحادثة', desc: 'زر التفرع في واجهة الدردشة يحفظ لقطة فورية من المحادثة قبل تجربة مسار جديد. يمكنك استعادة اي تفرع لاحقا من قائمة التفرعات.' },
            { title: '🚧 @suny/sdk (قريباً)', desc: 'مجموعة التطوير الرسمية لبناء إضافات SUNy. اصنع ادوات مخصصة، موصلات ذاكرة، موفري مصادقة، واضافات فوترة مع دعم كامل لـ TypeScript.' },
            { title: '🚧 الوكلاء المجدولون (قريباً)', desc: 'جدول SUNy للتشغيل التلقائي — مراجعات كود يومية، فحص اعتماديات اسبوعي، فحوصات سلامة كل ساعة. اضبطه وانس امره.' },
            { title: '🌐 أتمتة المتصفح', desc: 'يستطيع SUNy تصفح صفحات الويب، التقاط لقطات شاشة، ملء النماذج، واستخراج البيانات. مثالي للاختبار والفحص المباشر.' },
            { title: '🚧 سوق MCP (قريباً)', desc: 'اكتشف وانصب خوادم MCP من المجتمع. قواعد بيانات، محركات بحث، Docker، Slack، GitHub — كلها قابلة للتوصيل بأمر واحد.' },
            { title: '🧠 ملفات السلوك القابلة للتركيب', desc: 'يقوم SUNy الآن بتركيب مصادر سلوك متعددة — التفاعلات السابقة، القواعد المستفادة، سياق المشروع، والمهارات النشطة — في ملف سلوك وزني واحد. مستوحى من وحدات التحكم في فضاء التنشيط، الإشارات الأقوى تسيطر بينما الأضعف تساهم.' },
            { title: '🎫 تذاكر العملاء (PRO)', desc: 'أنشئ رابطاً آمناً للعملاء غير التقنيين. يعمل SUNy كمساعدك في الخطوط الأمامية، حيث يدردش بود مع العميل لجمع متطلبات المشروع بدقة. تراجع أنت التذكرة المكتملة، تعتمدها، وينفذ SUNy التغييرات. لا مزيد من رسائل السلاك المتبادلة.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>ماذا يمكن لـ SUNy ان يفعل من اجلك؟</h2>

      {[
        { icon: 'GOAL', title: '🎯 تتبع الاهداف المستمر', desc: 'SUNy يتذكر ما كان يعمل عليه عبر الجلسات. الاهداف النشطة تحتفظ بمعايير النجاح والادلة. استمر من حيث توقفت.' },
        { icon: 'NAV', title: '🗺️ التنقل الذكي في الكود', desc: 'يستخدم SUNy البحث الدلالي، خرائط المشروع عند الطلب، وقواعد المشروع المولّدة تلقائياً للعثور على الملفات فوراً — لا مزيد من تصفح 50 ملفاً للعثور على سطر واحد.' },
        { icon: 'READ', title: 'يقرا مشروعك بالكامل', desc: 'يستكشف SUNy مشروعك تلقائيا ويفهم كيف يرتبط كل شيء ببعضه قبل ان يلمس اي ملف.' },
        { icon: 'EDIT', title: 'يكتب، يعدل، وينشئ الملفات', desc: 'يستطيع SUNy انشاء ملفات جديدة، تعديل الموجودة، وتنظيم مشروعك -- كل ذلك دون ان تحرك اصبعا.' },
        { icon: 'AUTO', title: 'يتعامل مع الامور الصعبة تلقائيا', desc: 'ينجز SUNy كل شيء خلف الكواليس، ويبقيك على اطلاع بتحديثات ودية وبلغة بسيطة.' },
        { icon: 'LOOP', title: 'لا يستسلم', desc: 'اذا لم ينجح الامر من المحاولة الاولى، يجرب SUNy نهجا مختلفا. يستمر حتى يصل الى الحل.' },
        { icon: 'DIAG', title: '🔀 اختبار الفرضيات المتوازي', desc: 'للمشاكل الصعبة، يطلق SUNy عدة وكلاء مصغرين باستراتيجيات مختلفة في وقت واحد ويختار افضل نتيجة.' },
        { icon: 'DAG', title: '📊 رسم بياني لتبعية المهام', desc: 'يتم تحليل المهام المعقدة الى خطوات مرتبة حسب التبعية. يعمل SUNy على الرسم البياني ويرفع النتائج الى الهدف.' },
        { icon: 'CONF', title: '📈 قياس الثقة', desc: 'SUNy يقيس مستوى ثقته في كل خطوة. الثقة المنخفضة تؤدي تلقائيا الى الترقية الى نموذج اقوى.' },
        { icon: 'PROJ', title: 'مشاريع متعددة', desc: 'اعمل على اي عدد من المشاريع تريد. SUNy يبقي كل شيء منظما ومنفصلا.' },
        { icon: 'PHONE', title: '📱 تحكم عن بعد من هاتفك', desc: 'ابتعد عن مكتبك دون إيقاف العمل. ادخل إلى حسابك في SUNy من هاتفك، أرسل التعليمات، وشاهده ينفذ مهام البرمجة تلقائيا على جهاز الكمبيوتر الخاص بك.' },
        { icon: 'MEM', title: 'يصبح اذكى كلما استخدمته اكثر', desc: 'يتذكر SUNy تفضيلاتك واسلوب عملك وقراراتك السابقة -- حتى تشعر في كل جلسة بالالفة.' },
        { icon: 'LANG', title: 'لغة بسيطة دائما', desc: 'لا مصطلحات تقنية. SUNy يشرح ما يفعله بطريقة مفهومة ومريحة.' },
        { icon: 'BAL', title: 'انت في السيطرة على ميزانيتك', desc: 'يحدد المسؤول رصيدا لك. SUNy يريك ما تبقى لديك في كل وقت -- لا مفاجآت في الفواتير.' },
      ].map(f => (
        <div key={f.icon} className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.8 }}>{f.desc}</p>
        </div>
      ))}

      <div className="card" style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>ما الذي يجعل SUNy مختلفا عن الذكاء الاصطناعي العادي؟</h2>
        <table>
          <thead>
            <tr>
              <th>الذكاء الاصطناعي العادي</th>
              <th>SUNy</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['يعطيك كودا لتنسخه وتلصقه', 'يكتب الملفات مباشرة في مشروعك'],
              ['انت من يشغل الاوامر', 'SUNy يشغل كل شيء تلقائيا'],
              ['يتوقف بعد اجابة واحدة', 'يستمر حتى ينجز الهدف بالكامل'],
              ['واجهة تقنية', 'لغة بسيطة، ودية، بلا مصطلحات معقدة'],
            ].map(([old, suny]) => (
              <tr key={old}>
                <td style={{ color: 'var(--text-muted)' }}>{old}</td>
                <td style={{ color: 'var(--success)' }}>{suny}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 24, borderColor: 'var(--success,#22c55e)', background: 'rgba(34,197,94,0.04)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>هل التكلفة مرتفعة؟</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.8 }}>
          SUNy <strong>ميسور التكلفة بشكل مفاجئ</strong>. معظم المهام لا تتجاوز بضعة سنتات. انت تدفع فقط مقابل ما يفعله SUNy فعلا، وتبقى مطلعا على رصيدك دائما -- بدون مفاجآت.
        </p>
      </div>

      <div style={{ marginTop: 16, padding: '20px 24px', borderRadius: 'var(--radius)', border: '1px solid var(--accent)', background: 'rgba(108,99,255,0.06)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>هل النتيجة مضمونة؟</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.8 }}>
          نعم -- SUNy لا يستسلم بعد محاولة واحدة. يختبر، يقيم، يعيد المحاولة، ويستمر حتى ينجز الهدف.
          <strong> يعمل تماما كما يعمل مطور بشري محترف</strong> -- لا يعطيك سكريبتا لتشغله بنفسك، بل يقوم هو بالعمل، يشغله، يتحقق منه، ويصلحه حتى يعمل بشكل صحيح.
        </p>
      </div>

      {/* PRO callout — Arabic */}
      <div style={{ marginTop: 24, padding: '24px 28px', borderRadius: 'var(--radius)', border: '2px solid rgba(108,99,255,0.4)', background: 'linear-gradient(135deg, rgba(108,99,255,0.08) 0%, rgba(108,99,255,0.03) 100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 22 }}>⚡</span>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>SUNy PRO</h2>
          <span style={{ fontSize: 10, fontWeight: 700, background: 'rgba(108,99,255,0.2)', color: 'var(--accent)', border: '1px solid rgba(108,99,255,0.4)', borderRadius: 4, padding: '2px 8px' }}>مميز</span>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.8, marginBottom: 14 }}>
          الخطة الاحترافية تفتح مجموعة من المميزات المتقدمة للتحكم في التكاليف وإدارة المشاريع — سقف الميزانية لكل تشغيل، تقدير التكلفة قبل البدء، إشعارات الانتهاء، تتبع صحة الكود، والمزيد.
        </p>
        <Link to="/pro-features" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: 'var(--accent)', textDecoration: 'none', padding: '8px 18px', border: '1px solid rgba(108,99,255,0.4)', borderRadius: 7, background: 'rgba(108,99,255,0.08)' }}>
          ← جميع مميزات PRO
        </Link>
      </div>
    </div>
  );
}
