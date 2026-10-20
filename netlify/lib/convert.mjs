// Đổi luồng SSE của Gemini sang định dạng trang STATVERSE đang đọc.
export function convert(body) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = '';
  const send = (c, obj) => c.enqueue(enc.encode('data: ' + JSON.stringify(obj) + '\n\n'));
  const handle = (c, block) => {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return;
    let j; try { j = JSON.parse(line.slice(5).trim()); } catch { return; }
    if (j.error) { send(c, { type: 'error' }); return; }
    const parts = j.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (p.thought) continue; // bỏ phần "suy nghĩ" nội bộ nếu có
      if (typeof p.text === 'string' && p.text) send(c, { type: 'content_block_delta', delta: { text: p.text } });
    }
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk, c) {
      buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      const blocks = buf.split('\n\n'); buf = blocks.pop();
      blocks.forEach((b) => handle(c, b));
    },
    flush(c) { if (buf.trim()) handle(c, buf); },
  }));
}
