// Hàm máy chủ: nhận câu hỏi từ trang STATVERSE, gọi Gemini API (gói miễn phí), trả kết quả dạng stream.
// API key chỉ nằm ở biến môi trường của Netlify, không xuất hiện trong trang web.
import { convert } from '../lib/convert.mjs';

const hits = new Map();
const LIMIT = Number(process.env.RATE_LIMIT_PER_HOUR || 20);
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const bad = (s, m) => new Response(m, { status: s });

export default async (req) => {
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
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: b.tier === 'complex' ? 4000 : 2500 } }),
    }
  );
  if (up.status === 429) return bad(429, 'Rate limited by provider');
  if (!up.ok) return bad(502, 'Upstream error ' + up.status);
  return new Response(convert(up.body), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
};
export const config = { path: '/api/ask' };
