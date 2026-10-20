// Hàm máy chủ: nhận câu hỏi từ trang STATVERSE, gọi Gemini API (gói miễn phí), trả kết quả dạng stream.
// API key chỉ nằm ở biến môi trường của Netlify, không xuất hiện trong trang web.
import { convert } from '../lib/convert.mjs';

const hits = new Map();
const LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR || 20);
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const bad = (s, m) => new Response(m, { status: s });

export default async (req) => {
  // Trang kiểm tra nhanh: mở https://<trang-của-bạn>/api/ask?test=1 trên trình duyệt
  if (req.method === 'GET') {
    const info = { keySet: !!process.env.GEMINI_API_KEY, model: MODEL, limitPerHour: LIMIT };
    if (new URL(req.url).searchParams.get('test') !== '1' || !info.keySet) return Response.json(info);
    const t0 = Date.now();
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Trả lời đúng một từ: OK' }] }], generationConfig: { maxOutputTokens: 200 } }),
      });
      const txt = (await r.text()).replace(/AIza\S+/g, '***').slice(0, 400);
      return Response.json({ ...info, geminiStatus: r.status, ms: Date.now() - t0, response: txt });
    } catch (e) {
      return Response.json({ ...info, error: String(e).slice(0, 200) });
    }
  }
  if (req.method !== 'POST') return bad(405, 'Method not allowed');
  const allowed = process.env.ALLOWED_ORIGIN;
  if (allowed && req.headers.get('origin') !== allowed) return bad(403, 'Forbidden');
  if (!process.env.GEMINI_API_KEY) return bad(500, 'Server not configured');

  const ip = req.headers.get('x-nf-client-connection-ip') || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= LIMIT) return bad(429, 'Rate limited');
  recent.push(now); hits.set(ip, recent);

  let b; try { b = await req.json(); } catch { return bad(400, 'Bad JSON'); }
  const m = b.messages, imgs = Array.isArray(b.images) ? b.images : [];
  if (!Array.isArray(m) || m.length < 1 || m.length > 20) return bad(400, 'Bad messages');
  let total = 0;
  for (const x of m) {
    if (!['user', 'assistant'].includes(x.role) || typeof x.content !== 'string') return bad(400, 'Bad message');
    total += x.content.length;
  }
  if (total > 40000 || m[m.length - 1].role !== 'user' || imgs.length > 2) return bad(400, 'Too large');
  if (imgs.some((d) => typeof d !== 'string' || d.length > 3_500_000)) return bad(400, 'Image too large');

  const contents = m.map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] }));
  contents[contents.length - 1].parts.unshift(...imgs.map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } })));

  const up = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: b.tier === 'complex' ? 8000 : 6000 } }),
    }
  );
  if (up.status === 429) return bad(429, 'Rate limited by provider');
  if (!up.ok) { const t = (await up.text().catch(() => '')).slice(0, 200); console.error('Gemini error', up.status, t); return bad(up.status === 429 || up.status === 503 ? up.status : 502, 'Gemini ' + up.status + ' ' + t); }
  return new Response(convert(up.body), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
};
export const config = { path: '/api/ask' };
