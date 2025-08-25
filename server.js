import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// 🔐 لا تضعي المفاتيح في الكود. استخدمي OPENAI_API_KEY من إعدادات Vercel
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Helpers =====
const SAFE_DOMAINS = [
  'who.int','cdc.gov','nhs.uk','pubmed.ncbi.nlm.nih.gov','ncbi.nlm.nih.gov','mayoclinic.org','nih.gov'
];
const isAllowedSource = (url) => {
  try { const u = new URL(url); const d = u.hostname.toLowerCase();
    if (SAFE_DOMAINS.some(sd => d === sd || d.endsWith('.'+sd))) return true;
    return d.endsWith('.gov') || d.endsWith('.edu');
  } catch { return false; }
};

async function gpt5Structured({ system, user, schema }) {
  const resp = await openai.chat.completions.create({
    model: 'gpt-5',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    response_format: { type: 'json_schema', json_schema: schema }
  });
  const txt = resp.choices?.[0]?.message?.content || '{}';
  return JSON.parse(txt);
}

// ===== Schemas =====
const outlineSchema = {
  name: 'outline_schema',
  schema: {
    type: 'object',
    properties: { outline: { type: 'string' } },
    required: ['outline'],
    additionalProperties: false
  }
};

const articleSchema = {
  name: 'article_schema',
  schema: {
    type: 'object',
    properties: {
      article: {
        type: 'object',
        properties: {
          articleTitle: { type: 'string' },
          articleHtmlContent: { type: 'string' },
          secondaryKeywords: { type: 'array', items: { type: 'string' } }
        },
        required: ['articleTitle','articleHtmlContent','secondaryKeywords'],
        additionalProperties: false
      },
      metadata: {
        type: 'object',
        properties: {
          metaTitle: { type: 'string' },
          metaDescription: { type: 'string' },
          socialTitle: { type: 'string' },
          socialDescription: { type: 'string' }
        },
        required: ['metaTitle','metaDescription','socialTitle','socialDescription'],
        additionalProperties: false
      },
      gate: {
        type: 'object',
        properties: {
          blocked: { type: 'boolean' },
          reasons: { type: 'array', items: { type: 'string' } },
          claimsNeedingCitations: { type: 'array', items: { type: 'string' } }
        },
        required: ['blocked','reasons','claimsNeedingCitations'],
        additionalProperties: false
      }
    },
    required: ['article','metadata','gate'],
    additionalProperties: false
  }
};

// ===== Prompts =====
const SYS_COMMON = 'أنت مساعد تحرير لمحتوى صحي YMYL. التزم بدقة الحقائق، الأسلوب الواضح، والحياد. أخرج دائمًا JSON صالحًا فقط.';
const OUTLINE_USER = ({topic, language}) =>
  `أنشئ هيكل SEO مفصل لمقال (~1500 كلمة) حول: "${topic}" باللغة ${language}. يجب أن يحتوي على H2 رئيسية و H3 فرعية (بدون أرقام تلقائية). أعده في حقل outline نصًا خامًا.`;

const ARTICLE_USER = (p) => `اكتب مقالاً (~1500 كلمة) باللغة ${p.language} وفق الهيكل التالي:
--- OUTLINE START ---
${p.outline}
--- OUTLINE END ---

الشروط:
- اتبع أسلوب مقدمة: ${p.introStyle||'مباشرة'}، وخاتمة: ${p.conclusionStyle||'تلخيصية'}.
- أدرج إحالات مرقّمة داخل النص مثل [1], [2] تشير إلى المصادر المعطاة (لا تخترع مصادر).
- أضف فقرة "إخلاء المسؤولية الطبية" في النهاية.
- إن فُعّل FAQ اجعل قسم "أسئلة شائعة" آخر عنصر.
- ولّد secondaryKeywords ذات صلة (≥3).

بيانات مساعدة:
- الكلمة الأساسية: ${p.primaryKeyword}
- مصادر موثوقة:
${p.sources.map((s,i)=>`[${i+1}] ${s}`).join('\n')}
- روابط داخلية (اختياري):
${(p.internalLinks||[]).map(u=>`- ${u}`).join('\n')}

أعد JSON بالمفاتيح: article{articleTitle, articleHtmlContent, secondaryKeywords[]}, metadata{metaTitle, metaDescription, socialTitle, socialDescription}, gate{blocked, reasons[], claimsNeedingCitations[]}. لا تعُد أي حقول أخرى.`;

// ===== Routes =====
app.post('/api/gpt5/outline', async (req, res) => {
  try {
    const { topic, language='العربية' } = req.body || {};
    if (!topic) return res.status(400).send('topic مطلوب');
    const data = await gpt5Structured({ system: SYS_COMMON, user: OUTLINE_USER({topic, language}), schema: outlineSchema });
    res.json({ outline: data.outline || '' });
  } catch (e) { res.status(400).send(e.message || 'Bad Request'); }
});

app.post('/api/gpt5/article', async (req, res) => {
  try {
    const p = req.body || {};
    const reasons = [];
    if(!p.topic || !p.primaryKeyword || !p.outline) reasons.push('topic/primaryKeyword/outline مطلوبة');
    if(!Array.isArray(p.sources) || p.sources.length < 3 || p.sources.length > 6) reasons.push('عدد المصادر يجب أن يكون بين 3 و6');
    const bad = (p.sources||[]).filter(s => !isAllowedSource(s));
    if(bad.length) reasons.push('مصادر غير موثوقة: '+bad.join(', '));
    if(reasons.length){
      return res.json({
        article:{ articleTitle: p.topic||'', articleHtmlContent:'', secondaryKeywords:[] },
        metadata:{ metaTitle:'', metaDescription:'', socialTitle:'', socialDescription:'' },
        gate:{ blocked:true, reasons, claimsNeedingCitations:[] }
      });
    }

    const out = await gpt5Structured({ system: SYS_COMMON, user: ARTICLE_USER(p), schema: articleSchema });

    const textOnly = (out?.article?.articleHtmlContent||'').replace(/<[^>]+>/g,' ');
    const wc = (textOnly.match(/\S+/g)||[]).length;
    if (wc < 1200) out.gate.reasons.push('عدد الكلمات أقل من 1200.');
    if (!/إخلاء\s*المسؤولية|تنبيه\s*طبي|Disclaimer/i.test(textOnly)) out.gate.reasons.push('لا يوجد إخلاء مسؤولية طبي.');
    if (!Array.isArray(out.article.secondaryKeywords) || out.article.secondaryKeywords.length < 3) out.gate.reasons.push('كلمات ثانوية غير كافية.');

    const hasClaims = /\b(يقلل|يزيد|يمنع|يعالج|يحسن|يؤدي إلى)\b/.test(textOnly);
    const hasCites = /\[\d+\]/.test(out.article.articleHtmlContent||'');
    if (hasClaims && !hasCites) out.gate.claimsNeedingCitations.push('ادعاءات بدون إحالات مرقمة.');

    if(out.gate.reasons.length || out.gate.blocked || out.gate.claimsNeedingCitations.length) out.gate.blocked = true;
    res.json(out);
  } catch (e) { res.status(400).send(e.message || 'Bad Request'); }
});

// ✅ للتشغيل محليًا فقط. على Vercel (سيرفرلس) ما نشغل app.listen
const PORT = process.env.PORT || 8787;
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log('Server running on http://localhost:'+PORT));
}
export default app; // مهم لـ Vercel
