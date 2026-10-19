// Scenario engine of the flow suite: posts each scenario's messages to the local
// bot as Meta would, waits until the bot stops answering, and checks what it
// sent (.out/meta-out.jsonl, written by meta-intercept.js) and, where it
// matters, what reached the database.
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '.out', 'meta-out.jsonl');
const PNID = '1109940228878973';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Meta sends to Argentine numbers without the 9 after 54. */
const to54 = (wa) => wa.replace(/^549/, '54');

function render(d) {
  if (!d) return '';
  if (d.type === 'text') return d.text.body;
  if (d.type === 'document') return `[documento ${d.document.filename}]${d.document.caption ? ` ${d.document.caption}` : ''}`;
  if (d.type === 'interactive') {
    const i = d.interactive;
    const opts = i.type === 'button'
      ? i.action.buttons.map((b) => `[${b.reply.title}|${b.reply.id}]`)
      : i.action.sections.flatMap((s) => s.rows.map((r) => `[${r.title}|${r.id}]`));
    return `${i.body.text}\n${opts.join(' ')}`;
  }
  return '';
}

/** What the bot sent to this number since `since` (ms). */
function sentTo(wa, since) {
  if (!fs.existsSync(OUT)) return [];
  const t = to54(wa);
  return fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((l) => l.at >= since && l.url.endsWith('/messages') && l.data && l.data.to === t && l.data.type && !l.data.status)
    .map((l) => render(l.data));
}

let seq = 0;
function message(wa, step) {
  // Media ids carry no dots: meta-intercept.js reads them from the URL.
  const mid = `${Date.now()}x${seq++}`;
  const m = { from: wa, id: `wamid.suite${mid}`, timestamp: String(Math.floor(Date.now() / 1000)) };
  if (step.select) {
    const kind = step.list ? 'list_reply' : 'button_reply';
    return { ...m, type: 'interactive', interactive: { type: kind, [kind]: { id: step.select, title: step.title || step.select } } };
  }
  if (step.image) return { ...m, type: 'image', image: { id: `${step.receipt ? 'rec' : 'img'}${mid}`, mime_type: step.receipt ? 'image/jpeg' : 'image/png', ...(step.caption ? { caption: step.caption } : {}) } };
  if (step.pdf) return { ...m, type: 'document', document: { id: `pdf${mid}`, mime_type: 'application/pdf', filename: step.pdf, ...(step.caption ? { caption: step.caption } : {}) } };
  if (step.doc) return { ...m, type: 'document', document: { id: `doc${mid}`, mime_type: 'application/msword', filename: step.doc } };
  if (step.video) return { ...m, type: 'video', video: { id: `vid${mid}`, mime_type: 'video/mp4' } };
  if (step.audio) return { ...m, type: 'audio', audio: { id: `aud${mid}`, mime_type: 'audio/ogg; codecs=opus', voice: true } };
  if (step.location) return { ...m, type: 'location', location: step.location };
  if (step.contact) return { ...m, type: 'contacts', contacts: [{ name: { formatted_name: step.contact }, phones: [{ phone: step.phone }] }] };
  return { ...m, type: 'text', text: { body: step.text } };
}

async function post(botUrl, wa, step) {
  const metadata = { phone_number_id: PNID, display_phone_number: '0' };
  const value = step.echo
    ? { messaging_product: 'whatsapp', metadata, message_echoes: [{ from: '0', to: wa, id: `wamid.echo${Date.now()}x${seq++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: step.echo } }] }
    : { messaging_product: 'whatsapp', metadata, contacts: [{ profile: { name: 'Prueba' }, wa_id: wa }], messages: [message(wa, step)] };
  const res = await fetch(`${botUrl}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field: step.echo ? 'smb_message_echoes' : 'messages', value }] }] }),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

/** Waits until the bot stops sending to this number (photos wait 8 s for the rest of the album). */
async function settle(wa, since, { quiet = 3500, max = 45000, silent = false, media = false } = {}) {
  if (silent) { await sleep(quiet + 4000); return sentTo(wa, since); }
  const start = Date.now();
  const needed = media ? Math.max(quiet, 10500) : quiet;
  let last = 0;
  let lastChange = Date.now();
  for (;;) {
    await sleep(500);
    const n = sentTo(wa, since).length;
    if (n !== last) { last = n; lastChange = Date.now(); }
    if (n > 0 && Date.now() - lastChange >= needed) break;
    if (Date.now() - start > max) break;
  }
  return sentTo(wa, since);
}

function label(step) {
  if (step.select) return `(toca) ${step.title || step.select}`;
  if (step.image) return `[${step.burst ? `${step.burst} fotos` : 'foto'}]${step.caption ? ` "${step.caption}"` : ''}`;
  if (step.pdf) return `[PDF ${step.pdf}]${step.caption ? ` "${step.caption}"` : ''}`;
  if (step.doc) return `[archivo ${step.doc}]`;
  if (step.video) return '[video]';
  if (step.audio) return '[audio]';
  if (step.location) return '[ubicación]';
  if (step.contact) return `[contacto ${step.contact}]`;
  if (step.echo) return `OFICINA (desde el celular): ${step.echo}`;
  return step.text;
}

function check(expect, text, sent) {
  const fails = [];
  if (!expect) return fails;
  for (const re of expect.any || []) if (!re.test(text)) fails.push(`falta ${re}`);
  for (const re of expect.none || []) if (re.test(text)) fails.push(`no debería ${re}`);
  if (expect.silent && sent.length) fails.push('debería quedarse callado');
  if (expect.count !== undefined && sent.length !== expect.count) fails.push(`esperaba ${expect.count} mensaje(s), mandó ${sent.length}`);
  if (expect.reply && !sent.length) fails.push('no respondió');
  return fails;
}

async function runScenario(sc, { botUrl, query }) {
  const transcript = [];
  const failures = [];
  let prev = '';
  try {
    for (const step of sc.steps) {
      if (step.drive) {
        // A model-led quote goes wherever it goes: answer what it asks.
        for (let i = 0; i < step.drive.max; i++) {
          if (step.drive.until.test(prev)) break;
          const next = step.drive.answer(prev);
          if (!next) break;
          const since = Date.now();
          await post(botUrl, sc.wa, next);
          const sent = await settle(sc.wa, since, { max: 90000, quiet: 5000 });
          prev = sent.join('\n');
          transcript.push({ in: label(next), out: sent });
        }
        const fails = check(step.drive.expect, prev, [prev]);
        if (fails.length) failures.push({ step: 'conversación guiada', fails });
        continue;
      }
      const since = Date.now();
      await post(botUrl, sc.wa, step);
      // An album: WhatsApp delivers each photo as its own message, back to back.
      for (let i = 1; i < (step.burst || 1); i++) { await sleep(400); await post(botUrl, sc.wa, step); }
      const sent = await settle(sc.wa, since, { silent: step.expect?.silent, media: !!(step.image || step.pdf), max: step.max || 45000, quiet: step.quiet || 3500 });
      prev = sent.join('\n');
      transcript.push({ in: label(step), out: sent });
      const fails = check(step.expect, prev, sent);
      if (fails.length) failures.push({ step: label(step), fails });
    }
    for (const c of sc.db || []) {
      const rows = query(c.sql.replaceAll('$WA', sc.wa));
      if (!c.test(rows)) failures.push({ step: `base: ${c.name}`, fails: [`resultado: ${JSON.stringify(rows).slice(0, 300)}`] });
    }
  } catch (error) {
    failures.push({ step: 'ejecución', fails: [error.message] });
  }
  return { id: sc.id, area: sc.area, name: sc.name, regression: sc.regression || null, known: sc.known || null, ok: failures.length === 0, failures, transcript };
}

/** Runs scenarios `concurrency` at a time (each has its own number), printing each result. */
async function runScenarios(scenarios, { botUrl, query, concurrency = 6 }) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, async () => {
    while (next < scenarios.length) {
      const sc = scenarios[next++];
      const r = await runScenario(sc, { botUrl, query });
      results.push(r);
      process.stdout.write(`${r.ok ? '✓' : r.known ? '·' : '✗'} ${sc.id} ${sc.name}\n`);
    }
  }));
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { runScenarios, sentTo, to54 };
