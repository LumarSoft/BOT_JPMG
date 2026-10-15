// Preloaded into the bot (node -r): every request to graph.facebook.com is
// recorded in .out/meta-out.jsonl and answered OK, so nothing reaches WhatsApp.
// Media downloads are served from fixtures/ by the media id's prefix: "pdf…" a
// PDF, "aud…" a voice note, anything else a PNG.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const BOT_DIR = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, '.out', 'meta-out.jsonl');
const FIXTURES = path.join(__dirname, 'fixtures');
const axios = createRequire(path.join(BOT_DIR, 'package.json'))('axios');

const media = (id) =>
  id.startsWith('pdf') ? ['fake.pdf', 'application/pdf']
    : id.startsWith('aud') ? ['voz.m4a', 'audio/mp4']
      : ['fake.png', 'image/png'];

const original = axios.Axios.prototype.request;
axios.Axios.prototype.request = function (configOrUrl, config) {
  const cfg = typeof configOrUrl === 'string' ? { ...(config || {}), url: configOrUrl } : configOrUrl || {};
  const url = String(cfg.url || '');
  if (url.startsWith('https://fake-media/')) {
    const buf = fs.readFileSync(path.join(FIXTURES, media(url.slice('https://fake-media/'.length))[0]));
    return Promise.resolve({ status: 200, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), headers: {}, config: cfg });
  }
  if (url.includes('graph.facebook.com') && url.endsWith('/media')) {
    const file = cfg.data && typeof cfg.data.get === 'function' ? cfg.data.get('file') : null;
    fs.appendFileSync(OUT, JSON.stringify({ at: Date.now(), url, upload: file?.name ?? null, size: file?.size ?? 0 }) + '\n');
    return Promise.resolve({ status: 200, data: { id: `media.suite${Date.now()}` }, headers: {}, config: cfg });
  }
  if (url.includes('graph.facebook.com')) {
    const id = url.match(/graph\.facebook\.com\/v[\d.]+\/([A-Za-z0-9_-]+)$/)?.[1];
    if (id && (cfg.method || 'get').toLowerCase() === 'get')
      return Promise.resolve({ status: 200, data: { url: `https://fake-media/${id}`, mime_type: media(id)[1] }, headers: {}, config: cfg });
    let data = cfg.data;
    try { if (typeof data === 'string') data = JSON.parse(data); } catch { /* keep as is */ }
    fs.appendFileSync(OUT, JSON.stringify({ at: Date.now(), url, data }) + '\n');
    return Promise.resolve({ status: 200, data: { messages: [{ id: `wamid.fake${Date.now()}${Math.random()}` }] }, headers: {}, config: cfg });
  }
  return original.apply(this, arguments);
};
