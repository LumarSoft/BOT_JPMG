// Preloaded into the local API (node -r): every RESTCotizadorAutV2 call goes out
// with GenerarPresupuesto=false, so quoting never creates a presupuesto in
// Triunfo, at most one call every 2 s and at most MAX_CALLS per run. Calls are
// logged (without credentials) to .out/triunfo-calls.jsonl.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const API_DIR = process.env.FLOWS_API_DIR || process.cwd();
const OUT = path.join(__dirname, '.out', 'triunfo-calls.jsonl');
const MIN_GAP_MS = 2000;
const MAX_CALLS = Number(process.env.TRIUNFO_MAX_CALLS || 100);
const axios = createRequire(path.join(API_DIR, 'node_modules/@nestjs/axios/package.json'))('axios');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let last = 0;
let calls = 0;
let queue = Promise.resolve();
const waitTurn = () => {
  const turn = queue.then(async () => {
    if (calls >= MAX_CALLS) throw new Error(`Tope de ${MAX_CALLS} llamadas a Triunfo en esta corrida`);
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    calls += 1;
  });
  queue = turn.catch(() => undefined);
  return turn;
};

const original = axios.Axios.prototype.request;
axios.Axios.prototype.request = async function (configOrUrl, config) {
  const cfg = typeof configOrUrl === 'string' ? { ...(config || {}), url: configOrUrl } : configOrUrl || {};
  if (!String(cfg.url || '').includes('RESTCotizadorAutV2')) return original.apply(this, arguments);
  const data = typeof cfg.data === 'string' ? JSON.parse(cfg.data) : cfg.data;
  data.SDTSrvCotizacionIn.General.GenerarPresupuesto = false;
  cfg.data = data;
  await waitTurn();
  const t0 = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { Autenticacion, ...request } = data.SDTSrvCotizacionIn;
  try {
    const res = await original.call(this, cfg);
    fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, request }) + '\n');
    return res;
  } catch (error) {
    fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, request, error: error.message }) + '\n');
    throw error;
  }
};
