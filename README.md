# gpt5-content-tool-backend (Vercel)

Backend بسيط لمسارات:
- POST /api/gpt5/outline
- POST /api/gpt5/article

## تشغيل محليًا
npm i
OPENAI_API_KEY=sk-... node server.js
# http://localhost:8787

## النشر على Vercel
- اربط GitHub → Vercel → Add New Project
- أضف OPENAI_API_KEY في Settings → Environment
- المسارات ستكون:
  https://your-app.vercel.app/api/gpt5/outline
  https://your-app.vercel.app/api/gpt5/article
