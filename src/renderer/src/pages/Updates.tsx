import { useState } from 'react';
import { Link } from 'react-router-dom';

type Lang = 'en' | 'ar';

const releases: Record<Lang, Array<{ version: string; date: string; tagline: string; features: string[]; fixes?: string[]; breaking?: string[] }>> = {
  en: [
    {
      version: '1.0',
      date: 'May 16, 2026',
      tagline: 'Foundation launch — the first release of SUNy.',
      features: [
        '5-Stage Execution Pipeline — INTENT_PARSE → PLAN → EXECUTION → VERIFICATION → FINALIZE with per-stage safety rules',
        'Verification-First Engine — 10 error types (syntax, type, missing import, etc.) with targeted correction strategies',
        'Self-Correction Loop — auto-retry on failure with Fresh Eyes breaker after repeated failures',
        'Code Conscience — Design Memory — persistent blueprint memory storing intent, architecture choices, and outcomes across sessions',
        'Code Conscience — Change Guardian — intent-aware drift detection with TypeScript signature snapshots before changes',
        'Security Guard — protected files policy, credential scan in command output, path traversal validation',
        'Operation Audit Log — every tool call, stage transition, and result recorded to secure audit trail',
        'Session Replay & Content Undo — full session timeline with one-click file restore to any previous state',
        'Project Lock — per-project session lock preventing concurrent mutations, auto-releases on inactivity',
        'Browser File System Access — direct local file access via secure browser APIs with user permission',
        'Project Map & Symbol Reader — codebase topology scan + file structure inspection without full content loading',
        'Feature Flags — DB-backed runtime toggles for every advanced feature, no restart required',
        'Context Summarizer — automatic summarization of long conversations to manage context windows',
        'Prompt Registry — 6 pre-built task templates (architect, debug, refactor, explain, security, API)',
        'Loop Detector — detects repeated actions without progress and auto-switches strategy',
        'Execution Tracing — optional debug mode capturing full stdout/stderr/exit code of failed commands',
        'URL Fetching — on-demand web content fetching for docs, API specs, and online resources',
        'Smart File Discovery — search project files by name or content across large codebases',
        'Error Auto-Correction — root cause analysis + auto-fix on code failures',
        'Subtask Delegation — complex tasks split into focused sub-tasks handled by dedicated AI sub-agents',
        'Multi-Agent Review — independent reviewer persona for post-edit verification with structured checklist',
        'Semantic Code Index — regex-based import/export/symbol graph for JS/TS with search and query tools',
        'Failure Memory — persistent error pattern tracking with similarity matching across sessions',
        'Test Generator — auto-scaffold tests with vitest/jest/mocha detection and project convention following',
        'Admin Panel — user management, API key management with priority routing, per-mode pricing, usage stats',
        'Billing & Wallet — credit-based with wallet balance, per-mode pricing (free/fast/pro), auto-deduction',
        'User Settings & Preferences — dark/light mode, language, model selection, project management',
        'Project Folder Selection — pick your project folder via browser file picker, no installation required',
        'Real-Time Execution Timeline — WebSocket-based live stage-by-stage progress updates',
        'Bilingual — full English & Arabic support across all UI and system messages',
      ],
    },
  ],
  ar: [
    {
      version: '1.0',
      date: '16 مايو 2026',
      tagline: 'إطلاق الأساس — أول إصدار من SUNy.',
      features: [
        'خط أنابيب من 5 مراحل — فهم النية → التخطيط → التنفيذ → التحقق → الإنهاء مع قواعد سلامة لكل مرحلة',
        'محرك التحقق أولاً — 10 أنواع أخطاء مع استراتيجيات تصحيح مستهدفة',
        'حلقة التصحيح الذاتي — إعادة المحاولة تلقائياً عند الفشل مع كاسر للروتين بعد التكرار',
        'الضمير البرمجي — ذاكرة التصميم — تخزين دائم للنية وخيارات التصميم عبر الجلسات',
        'الضمير البرمجي — حارس التغيير — كشف الانحراف عن النية باستخدام لقطات تواقيع TypeScript',
        'الحارس الأمني — حماية الملفات الحساسة، فحص بيانات الاعتماد، منع هجمات المسار',
        'سجل تدقيق العمليات — تسجيل كل استدعاء أداة وانتقال بين المراحل',
        'إعادة الجلسة والتراجع عن المحتوى — استعادة الملفات بنقرة واحدة لأي حالة سابقة',
        'قفل المشروع — منع التعديلات المتزامنة مع تحرير تلقائي عند الخمول',
        'الجسر الآمن — تطبيق محلي يعزل عمليات الملفات (قراءة/كتابة داخل المشروع فقط)',
        'خريطة المشروع وقارئ الرموز — مسح هيكل الكود وفحص الملفات بدون تحميل كامل',
        'مفاتيح الميزات — تشغيل/إيقاف الميزات في وقت التشغيل بدون إعادة تشغيل',
        'ملخص السياق — تلخيص تلقائي للمحادثات الطويلة لإدارة نافذة السياق',
        'سجل الأوامر — 6 قوالب مهام مبنية مسبقاً: معماري، تصحيح، إعادة هيكلة، شرح، أمن، API',
        'كاشف الحلقات — كشف الإجراءات المتكررة والتبديل التلقائي للاستراتيجية',
        'تتبع التنفيذ — وضع تصحيح اختياري يلتقط مخرجات الأوامر الفاشلة بالكامل',
        'جلب عناوين URL — جلب محتوى الويب عند الطلب للتوثيق ومواصفات API',
        'اكتشاف ذكي للملفات — البحث في المشروع بالاسم أو المحتوى',
        'التصحيح التلقائي للأخطاء — تحليل السبب الجذري مع الإصلاح التلقائي',
        'تفويض المهام الفرعية — تقسيم المهام المعقدة إلى مهام فرعية مع وكلاء ذكاء اصطناعي مخصصين',
        'المراجعة متعددة الوكلاء — مراجع مستقل للتحقق بعد التعديل مع قائمة مراجعة منظمة',
        'فهرس الكود الدلالي — رسم بياني للواردات/الصادرات/الرموز لأنواع JS/TS',
        'ذاكرة الفشل — تتبع أنماط الأخطاء مع مطابقة التشابه عبر الجلسات',
        'مولد الاختبارات — إنشاء تلقائي للاختبارات مع كشف vitest/jest/mocha',
        'لوحة المسؤول — إدارة المستخدمين، مفاتيح API، التسعير، إحصائيات الاستخدام',
        'الفواتير والمحفظة — نظام ائتماني مع تسعير حسب الوضع والخصم التلقائي',
        'إعدادات المستخدم — الوضع المظلم/الفاتح، اللغة، اختيار النموذج، إدارة المشاريع',
        'إعداد وإدارة الجسر — تثبيت بنقرة واحدة، حالة الاتصال، دعم مشاريع متعددة',
        'الجدول الزمني المباشر — تحديثات لحظية للتقدم عبر WebSocket',
        'ثنائي اللغة — دعم كامل للعربية والإنجليزية في جميع واجهات المستخدم والرسائل النظامية',
      ],
    },
  ],
};

export default function Updates() {
  const [lang, setLang] = useState<Lang>(() => {
    const browserLang = navigator.language.split('-')[0];
    return browserLang === 'ar' ? 'ar' : 'en';
  });

  const log = releases[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', padding: 32 }} dir={dir}>
      <style>{`
        @keyframes updateReveal {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .update-reveal { opacity: 0; animation: updateReveal 360ms ease forwards; }
        .update-r1 { animation-delay: 60ms; }
        .update-r2 { animation-delay: 130ms; }
        .update-r3 { animation-delay: 200ms; }

        @media (max-width: 760px) {
          .update-shell { padding: 16px !important; }
          .update-topbar { flex-direction: column; align-items: stretch !important; }
          .update-topbar > a { justify-content: center; }
          .update-lang { justify-content: center; }
        }
      `}</style>
      <div className="update-shell" style={{ maxWidth: 800, margin: '0 auto' }}>
        {/* Top bar */}
        <div className="update-topbar update-reveal update-r1" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, gap: 8 }}>
          <Link to="/login" className="btn btn-secondary" style={{ textDecoration: 'none', fontSize: 13 }}>
            {lang === 'en' ? 'Back to Login' : 'العودة لتسجيل الدخول'}
          </Link>
          <div className="update-lang" style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-sm" onClick={() => setLang('en')} style={{ background: lang === 'en' ? 'var(--accent)' : 'var(--surface)', color: lang === 'en' ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              English
            </button>
            <button className="btn btn-sm" onClick={() => setLang('ar')} style={{ background: lang === 'ar' ? 'var(--accent)' : 'var(--surface)', color: lang === 'ar' ? '#fff' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>
              العربية
            </button>
          </div>
        </div>

        {/* Header */}
        <div className="update-reveal update-r1" style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 6 }}>
            {lang === 'en' ? 'Update Log' : 'سجل التحديثات'}
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 }}>
            {lang === 'en'
              ? 'Every release of SUNy tracked here — new features, fixes, and changes.'
              : 'كل إصدار من SUNy موثق هنا — الميزات الجديدة، الإصلاحات، والتغييرات.'}
          </p>
        </div>

        {/* Releases */}
        {log.map((release) => (
          <div key={release.version} className="update-reveal update-r2" style={{ marginBottom: 24 }}>
            {/* Release header */}
            <div style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 12,
              marginBottom: 14,
              flexWrap: 'wrap',
            }}>
              <span style={{
                fontSize: 22,
                fontWeight: 700,
                color: 'var(--accent)',
                letterSpacing: '0.02em',
              }}>
                {lang === 'en' ? 'v' : 'إصدار '}{release.version}
              </span>
              <span style={{
                fontSize: 12,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}>
                {release.date}
              </span>
              <span className="badge badge-green" style={{ fontSize: 10 }}>
                {lang === 'en' ? 'Latest' : 'الأحدث'}
              </span>
            </div>

            {/* Tagline */}
            <p style={{
              color: 'var(--text-secondary)',
              fontSize: 14,
              lineHeight: 1.6,
              marginBottom: 18,
              padding: '10px 14px',
              background: 'rgba(41,255,122,0.04)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
            }}>
              {release.tagline}
            </p>

            {/* Features */}
            <div className="card" style={{ marginBottom: release.fixes ? 14 : 0 }}>
              <h2 style={{
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--accent)',
                marginBottom: 14,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}>
                {lang === 'en' ? 'Features' : 'الميزات'}
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {release.features.map((f, i) => (
                  <div key={i} style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    fontSize: 13,
                    lineHeight: 1.65,
                    color: 'var(--text-primary)',
                  }}>
                    <span style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 3 }}>✦</span>
                    <span>{f}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Fixes */}
            {release.fixes && release.fixes.length > 0 && (
              <div className="card" style={{ marginBottom: 14 }}>
                <h2 style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: 'var(--warning)',
                  marginBottom: 14,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}>
                  {lang === 'en' ? 'Bug Fixes' : 'إصلاحات الأخطاء'}
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {release.fixes.map((fix, i) => (
                    <div key={i} style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                      fontSize: 13,
                      lineHeight: 1.65,
                      color: 'var(--text-primary)',
                    }}>
                      <span style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 3 }}>✧</span>
                      <span>{fix}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Breaking changes */}
            {release.breaking && release.breaking.length > 0 && (
              <div className="card" style={{ borderColor: 'var(--error)' }}>
                <h2 style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: 'var(--error)',
                  marginBottom: 14,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                }}>
                  {lang === 'en' ? 'Breaking Changes' : 'تغييرات جذرية'}
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {release.breaking.map((b, i) => (
                    <div key={i} style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                      fontSize: 13,
                      lineHeight: 1.65,
                      color: 'var(--text-primary)',
                    }}>
                      <span style={{ color: 'var(--error)', flexShrink: 0, marginTop: 3 }}>⚠</span>
                      <span>{b}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* End marker */}
        <div className="update-reveal update-r3" style={{
          textAlign: 'center',
          padding: '24px 0 8px',
          color: 'var(--text-muted)',
          fontSize: 12,
          letterSpacing: '0.08em',
        }}>
          {lang === 'en' ? '— end of log —' : '— نهاية السجل —'}
        </div>
      </div>
    </div>
  );
}
