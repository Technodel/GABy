import { useState } from 'react';
import { Link } from 'react-router-dom';

type Lang = 'en' | 'ar';

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
            { title: '🧬 Design Memory', desc: 'SUNy remembers every design decision you make — across sessions, projects, and restarts. It never forgets why something was done a certain way.' },
            { title: '🛡️ Change Guardian', desc: 'Before changes reach your code, SUNy checks whether they drift from your stated intent. Unintended contract changes are flagged instantly.' },
            { title: '⏳ Compound Knowledge', desc: 'Every session makes SUNy smarter about your project. Design memory compounds like a knowledge flywheel — the more you use it, the better it gets.' },
            { title: '🤝 Bidirectional', desc: 'Both you and the AI benefit. SUNy gives you context-aware answers, and you get a sidekick that truly understands your codebase.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24, borderColor: 'var(--accent)', borderWidth: 2, background: 'rgba(108,99,255,0.06)' }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>🧪 What&apos;s New in This Version</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.7, marginBottom: 16 }}>
          Six major new capabilities that take SUNy to the next level.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {[
            { title: '🎭 Prompt Variants', desc: 'A/B test different AI personas, tones, and strategies. Switch between Senior Engineer, Patient Teacher, or Test-First modes — or create your own custom variant.' },
            { title: '📸 Checkpoint Timeline', desc: 'Every change is saved as a named checkpoint. Browse your full history with file counts, tags, and one-click rollback to any earlier state.' },
            { title: '📦 @gaby/sdk', desc: 'The official SDK for building SUNy extensions. Create custom tools, memory adapters, auth providers, and billing plugins with full TypeScript support.' },
            { title: '⏰ Scheduled Agents', desc: 'Schedule SUNy to run automatically — daily code reviews, weekly dependency audits, hourly health checks. Set it and forget it.' },
            { title: '🌐 Browser Automation', desc: 'SUNy can navigate web pages, take screenshots, fill forms, and extract data. Perfect for testing, scraping, and live site verification.' },
            { title: '🏪 MCP Marketplace', desc: 'Discover and install community-contributed MCP servers. Databases, search engines, Docker, Slack, GitHub — all pluggable in one command.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>What can SUNy do for you?</h2>

      {[
        { icon: 'GOAL', title: '🎯 Persistent Goal Tracking', desc: 'SUNy remembers what it was working on across sessions. Active goals persist with success criteria and evidence collection. Pick up exactly where you left off.' },
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
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>What Makes SUNy Different From Just Using ChatGPT?</h2>
        <table>
          <thead>
            <tr>
              <th>ChatGPT / Regular AI</th>
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
            { title: '🤝 ثنائي الاتجاه', desc: 'انت والذكاء الاصطناعي تستفيدان معا. SUNy يعطيك اجابات واعية بالسياق، وانت تحصل على مساعد يفهم قاعدة اكوادك حقا.' },
          ].map(f => (
            <div key={f.title} style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{f.title}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.8, margin: 0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
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
            { title: '📦 @gaby/sdk', desc: 'مجموعة التطوير الرسمية لبناء إضافات SUNy. اصنع ادوات مخصصة، موصلات ذاكرة، موفري مصادقة، واضافات فوترة مع دعم كامل لـ TypeScript.' },
            { title: '⏰ الوكلاء المجدولون', desc: 'جدول SUNy للتشغيل التلقائي — مراجعات كود يومية، فحص اعتماديات اسبوعي، فحوصات سلامة كل ساعة. اضبطه وانس امره.' },
            { title: '🌐 أتمتة المتصفح', desc: 'يستطيع SUNy تصفح صفحات الويب، التقاط لقطات شاشة، ملء النماذج، واستخراج البيانات. مثالي للاختبار والفحص المباشر.' },
            { title: '🏪 سوق MCP', desc: 'اكتشف وانصب خوادم MCP من المجتمع. قواعد بيانات، محركات بحث، Docker، Slack، GitHub — كلها قابلة للتوصيل بأمر واحد.' },
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
        { icon: 'READ', title: 'يقرا مشروعك بالكامل', desc: 'يستكشف SUNy مشروعك تلقائيا ويفهم كيف يرتبط كل شيء ببعضه قبل ان يلمس اي ملف.' },
        { icon: 'EDIT', title: 'يكتب، يعدل، وينشئ الملفات', desc: 'يستطيع SUNy انشاء ملفات جديدة، تعديل الموجودة، وتنظيم مشروعك -- كل ذلك دون ان تحرك اصبعا.' },
        { icon: 'AUTO', title: 'يتعامل مع الامور الصعبة تلقائيا', desc: 'ينجز SUNy كل شيء خلف الكواليس، ويبقيك على اطلاع بتحديثات ودية وبلغة بسيطة.' },
        { icon: 'LOOP', title: 'لا يستسلم', desc: 'اذا لم ينجح الامر من المحاولة الاولى، يجرب SUNy نهجا مختلفا. يستمر حتى يصل الى الحل.' },
        { icon: 'DIAG', title: '🔀 اختبار الفرضيات المتوازي', desc: 'للمشاكل الصعبة، يطلق SUNy عدة وكلاء مصغرين باستراتيجيات مختلفة في وقت واحد ويختار افضل نتيجة.' },
        { icon: 'DAG', title: '📊 رسم بياني لتبعية المهام', desc: 'يتم تحليل المهام المعقدة الى خطوات مرتبة حسب التبعية. يعمل SUNy على الرسم البياني ويرفع النتائج الى الهدف.' },
        { icon: 'CONF', title: '📈 قياس الثقة', desc: 'SUNy يقيس مستوى ثقته في كل خطوة. الثقة المنخفضة تؤدي تلقائيا الى الترقية الى نموذج اقوى.' },
        { icon: 'PROJ', title: 'مشاريع متعددة', desc: 'اعمل على اي عدد من المشاريع تريد. SUNy يبقي كل شيء منظما ومنفصلا.' },
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
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>ما الذي يجعل SUNy مختلفا عن ChatGPT العادي؟</h2>
        <table>
          <thead>
            <tr>
              <th>ChatGPT / الذكاء الاصطناعي العادي</th>
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
    </div>
  );
}
