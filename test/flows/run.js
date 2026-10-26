#!/usr/bin/env node
// npm run test:flows — every conversational flow of the bot, end to end, before
// a deploy. Loads synthetic clients into the local database, starts the local
// API (Triunfo quotes without presupuesto) and the bot (WhatsApp intercepted),
// runs scenarios.js, prints what passed and what failed, and removes everything
// it created. Real calls: OpenAI (bot) and Triunfo's quoter (API), a few cents.
//
//   npm run test:flows                       all scenarios + inactivity (~7 min)
//   npm run test:flows -- --only=P09,C01     some scenarios
//   npm run test:flows -- --skip-inactivity  without the 4-minute inactivity wait
//   npm run test:flows -- --no-build         use the current dist/ of both repos
//   npm run test:flows -- --keep             leave the test data in the database to inspect
//   npm run test:flows -- --cleanup          only remove the test data (after --keep)
//
// The API repo is ../api_john (FLOWS_API_DIR to change it). Credentials come
// from each repo's .env and are never printed.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { makeQuery } = require('./db');
const { runScenarios, sentTo } = require('./runner');

const BOT_DIR = path.resolve(__dirname, '../..');
const API_DIR = path.resolve(process.env.FLOWS_API_DIR || path.join(BOT_DIR, '../api_john'));
const OUT_DIR = path.join(__dirname, '.out');
const API_PORT = 3001;
const BOT_PORT = 3002;
const PNID = '1109940228878973';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');
const concurrency = Number(args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] || 6);

const children = [];
let query;
let startedAt;

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exitCode = 2;
  throw new Error(message);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

function build(dir, name) {
  process.stdout.write(`Compilando ${name}… `);
  const res = spawnSync('npm', ['run', 'build'], { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) {
    console.log('falló');
    console.error((res.stdout + res.stderr).split('\n').slice(-30).join('\n'));
    fail(`No compila ${name}`);
  }
  console.log('ok');
}

function start(name, cwd, preload, entry, env) {
  const log = fs.openSync(path.join(OUT_DIR, `${name}.log`), 'w');
  const child = spawn(process.execPath, ['-r', preload, entry], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', log, log] });
  child.name = name;
  children.push(child);
  return child;
}

async function waitReady(name, url, child) {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) {
      const tail = fs.readFileSync(path.join(OUT_DIR, `${name}.log`), 'utf8').split('\n').slice(-20).join('\n');
      fail(`${name} se cerró al arrancar:\n${tail}`);
    }
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(500);
    }
  }
  fail(`${name} no respondió en 90 s (ver test/flows/.out/${name}.log)`);
}

/** Files the run uploaded (fake photos, PDFs, the voice note), read before the rows go. */
function uploadedFiles() {
  const rows = query(`
    SELECT m.rawData FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.waId LIKE '5493419990%' AND m.rawData IS NOT NULL
    UNION ALL SELECT cl.attachments FROM Claim cl JOIN Client c ON c.id=cl.clientId WHERE c.dni IN ('99000001','99000002','30712345671','99000004','99000006','99000010','99000011','99000012','99000013','99000014') AND cl.attachments IS NOT NULL
    UNION ALL SELECT l.payload FROM ContactLead l JOIN Conversation c ON c.id=l.conversationId WHERE c.waId LIKE '5493419990%';`);
  const found = new Set();
  for (const [json] of rows)
    for (const m of json.matchAll(/\/uploads\/(siniestros|leads|audios|inbox)\/([A-Za-z0-9._-]+)/g))
      found.add(path.join(API_DIR, 'uploads', m[1], path.basename(m[2])));
  return [...found];
}

async function cleanup() {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await sleep(1000);
  if (!query) return;
  if (flag('keep')) {
    console.log('\n--keep: quedan los datos de prueba en la base (npm run test:flows -- --cleanup los borra).');
    return;
  }
  try {
    let removed = 0;
    for (const file of uploadedFiles()) if (fs.existsSync(file)) { fs.unlinkSync(file); removed += 1; }
    query(fs.readFileSync(path.join(__dirname, 'data/cleanup.sql'), 'utf8'));
    if (startedAt)
      query(`DELETE q FROM Quote q LEFT JOIN QuoteRequest r ON r.quoteId=q.id WHERE q.createdAt >= '${startedAt}' AND q.userId IS NULL AND r.id IS NULL;`);
    console.log(`Limpieza: datos de prueba borrados de la base y ${removed} archivo(s) subido(s).`);
  } catch (error) {
    console.error(`No se pudo limpiar todo: ${error.message}`);
  }
}

/** The inactivity scenarios, once the 2-minute session timeout and the minute sweep have passed. */
async function checkInactivity(scenarios, results) {
  console.log('\nEsperando el cierre por inactividad (hasta 4 min)…');
  const since = Date.now() - 10 * 60_000;
  const goodbyes = (sc) => sentTo(sc.wa, since).filter((m) => /Por inactividad/.test(m)).length;
  const expected = scenarios.filter((sc) => sc.afterIdle?.goodbye);
  const until = Date.now() + 240_000;
  while (Date.now() < until && expected.some((sc) => goodbyes(sc) === 0)) await sleep(10_000);
  await sleep(expected.length ? 70_000 : 0); // a late sweep must not slip through for the ones that must stay quiet
  for (const sc of scenarios) {
    const r = results.find((x) => x.id === sc.id);
    const sent = goodbyes(sc);
    const stored = Number(query(`SELECT COUNT(*) FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.waId='${sc.wa}' AND m.content LIKE 'Por inactividad%'`)[0][0]);
    const fails = sc.afterIdle.goodbye
      ? [sent !== 1 && `esperaba 1 cierre por inactividad, mandó ${sent}`, stored !== 1 && 'el cierre no quedó guardado en el chat'].filter(Boolean)
      : [sent !== 0 && `no debía mandar el cierre (mandó ${sent})`].filter(Boolean);
    if (fails.length) { r.failures.push({ step: 'inactividad', fails }); r.ok = false; }
    process.stdout.write(`${r.ok ? '✓' : '✗'} ${sc.id} ${sc.name}\n`);
  }
}

function report(results, ms) {
  const failed = results.filter((r) => !r.ok && !r.known);
  const known = results.filter((r) => !r.ok && r.known);
  const ok = results.filter((r) => r.ok);
  console.log(`\n${ok.length}/${results.length} OK · ${failed.length} fallaron · ${known.length} pendiente(s) conocido(s) · ${Math.round(ms / 1000)} s`);
  for (const r of [...failed, ...known]) {
    console.log(`\n${r.known ? '·' : '✗'} ${r.id} ${r.name}${r.known ? ` — pendiente conocido: ${r.known}` : ''}`);
    for (const f of r.failures) console.log(`   ${f.step}: ${f.fails.join('; ')}`);
    if (!r.known)
      for (const t of r.transcript.slice(-3)) {
        console.log(`     > ${t.in}`);
        for (const o of t.out) console.log(`       < ${o.replace(/\n/g, ' | ').slice(0, 240)}`);
      }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ at: new Date().toISOString(), ms, results }, null, 1));
  console.log('\nDetalle de cada charla: test/flows/.out/results.json · logs: test/flows/.out/{api,bot}.log');
  return failed.length;
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (spawnSync('mysql', ['--version']).status !== 0) fail('Falta el cliente `mysql` (brew install mysql-client).');
  if (!fs.existsSync(path.join(API_DIR, '.env'))) fail(`No encuentro la API en ${API_DIR} (o su .env). Usá FLOWS_API_DIR.`);
  if (!fs.existsSync(path.join(BOT_DIR, '.env'))) fail('Falta el .env del bot.');
  if (!flag('cleanup'))
    for (const port of [API_PORT, BOT_PORT])
      if (await portInUse(port)) fail(`El puerto ${port} está ocupado: cerrá la API/bot que estén corriendo en local.`);

  query = makeQuery(API_DIR);
  if (flag('cleanup')) return;
  const number = query(`SELECT p.botEnabled FROM PhoneNumber n JOIN Producer p ON p.id=n.producerId WHERE n.phoneNumberId='${PNID}' AND n.deletedAt IS NULL`);
  if (!number.length) fail(`La base local no tiene el número de prueba ${PNID} (producerId 1).`);
  if (number[0][0] !== '1') fail('El bot está desactivado para el productor del número de prueba (Producer.botEnabled).');

  if (!flag('no-build')) { build(API_DIR, 'la API'); build(BOT_DIR, 'el bot'); }

  startedAt = query('SELECT UTC_TIMESTAMP(3)')[0][0];
  query(fs.readFileSync(path.join(__dirname, 'data/cleanup.sql'), 'utf8') + fs.readFileSync(path.join(__dirname, 'data/seed.sql'), 'utf8'));
  console.log('Datos de prueba cargados (DNI 990000xx, CUIT 30712345671, números 5493419990xxx).');

  const api = start('api', API_DIR, path.join(__dirname, 'triunfo-preload.js'), 'dist/src/main.js', {
    PORT: String(API_PORT),
    SESSION_TIMEOUT_MINUTES: '2',
    TRIUNFO_CARTERA_SYNC_ENABLED: 'false',
    RESEND_API_KEY: '',
    FLOWS_API_DIR: API_DIR,
  });
  await waitReady('api', `http://localhost:${API_PORT}/`, api);
  const bot = start('bot', BOT_DIR, path.join(__dirname, 'meta-intercept.js'), 'dist/main.js', {
    PORT: String(BOT_PORT),
    API_URL: `http://localhost:${API_PORT}`,
  });
  await waitReady('bot', `http://localhost:${BOT_PORT}/webhook`, bot);
  console.log('API y bot locales listos (WhatsApp interceptado, Triunfo sin presupuesto).\n');

  const all = require('./scenarios');
  const chosen = only ? all.filter((s) => only.includes(s.id)) : all;
  const main = chosen.filter((s) => s.stage !== 'inactivity');
  const idle = flag('skip-inactivity') ? [] : chosen.filter((s) => s.stage === 'inactivity');
  const t0 = Date.now();
  const botUrl = `http://localhost:${BOT_PORT}`;
  const results = await runScenarios(main, { botUrl, query, concurrency });
  if (idle.length) {
    const idleResults = await runScenarios(idle, { botUrl, query, concurrency });
    await checkInactivity(idle, idleResults);
    results.push(...idleResults);
  }
  results.sort((a, b) => a.id.localeCompare(b.id));
  if (report(results, Date.now() - t0) > 0) process.exitCode = 1;
}

process.on('SIGINT', () => { cleanup().finally(() => process.exit(130)); });
main()
  .catch((error) => {
    if (!process.exitCode) {
      console.error(error);
      process.exitCode = 2;
    }
  })
  .finally(cleanup);
