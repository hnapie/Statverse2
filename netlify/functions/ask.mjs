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
        signal: AbortSignal.timeout(8000),
      });
      const txt = (await r.text()).replace(/AIza\S+/g, '***').slice(0, 400);
      return Response.json({ ...info, geminiStatus: r.status, ms: Date.now() - t0, response: txt });
    } catch (e) {
      return Response.json({ ...info, error: String(e).slice(0, 200), hint: 'Gemini không trả lời trong 8 giây: model chậm hoặc mạng bị nghẽn. Thử model Flash-Lite hoặc đổi GEMINI_MODEL.' });
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:streamGenerateContent?alt=sse`;
  const payload = JSON.stringify({ contents, generationConfig: { maxOutputTokens: b.tier === 'complex' ? 8000 : 6000 } });
  const TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS || 25000);
  const enc = new TextEncoder();
  const evt = (o) => enc.encode('data: ' + JSON.stringify(o) + '\n\n');

  // Gửi ngay một byte để Netlify không báo "Inactivity Timeout", rồi mới chờ Gemini.
  const stream = new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(': ok\n\n'));
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), TIMEOUT);
      try {
        const up = await fetch(url, {
          method: 'POST',
          headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
          body: payload,
          signal: ctl.signal,
        });
        if (!up.ok) {
          const t = (await up.text().catch(() => '')).replace(/AIza\S+/g, '***').slice(0, 200);
          console.error('Gemini error', up.status, t);
          c.enqueue(evt({ type: 'error', status: up.status, message: t }));
        } else {
          const reader = convert(up.body).getReader();
          for (;;) { const { done, value } = await reader.read(); if (done) break; c.enqueue(value); }
        }
      } catch (e) {
        c.enqueue(evt({ type: 'error', status: 0, message: e.name === 'AbortError' ? 'Gemini không trả lời kịp (timeout)' : String(e).slice(0, 100) }));
      } finally { clearTimeout(tm); c.close(); }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
};
export const config = { path: '/api/ask' };
