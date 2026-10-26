// Preloaded into the local API (node -r): every RESTCotizadorAutV2 call goes out
// with GenerarPresupuesto=false, so quoting never creates a presupuesto in
// Triunfo, at most one call every 2 s and at most MAX_CALLS per run. Calls are
// logged (without credentials) to .out/triunfo-calls.jsonl.
//
// RESTDocumentosV2 and its document links never leave the machine: the seeded
// certificados get fixed documents (the ONIX: no cuponera, like Convenio; the
// PALIO: with cuponera, like some Plan de Pago) and each link behaves like
// Triunfo's, a 302 that sets a session cookie, then the PDF only with it.
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

const PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'fake.pdf'));
const SERVLET = 'https://www.triunfonet.com.ar/gauswebtriunfo/servlet/';
const LINKS = {
  '1050': ['Tarjeta Mercosur', 'htarjetaverdec'],
  '1000': ['Certificado de Cobertura', 'hcertificadoau'],
  '1040': ['Constancia de Pago', 'hbuscarabrecertpagom'],
  '1060': ['Cuponera de Pago', 'hcuponeratriunfonet'],
  '1020': ['Poliza', 'hpolizap'],
  '1030': ['Cláusulas', 'hclausulasdepoliza'],
};
const DOCUMENTS = {
  9900001: ['1000', '1020', '1030', '1040', '1050'],
  9900002: ['1000', '1020', '1030', '1050', '1060'],
  9900003: ['1000', '1020', '1050'],
  9900020: ['1000', '1020', '1030', '1050'],
  9900021: ['1000', '1020', '1030', '1050'],
  9900022: ['1000', '1020', '1050'],
  9900025: ['1000', '1020', '1050'],
};

function documentos(cfg) {
  const data = typeof cfg.data === 'string' ? JSON.parse(cfg.data) : cfg.data;
  const { Articulo, Certificado } = data.SDTWSDocumentosIn;
  const codes = DOCUMENTS[Certificado];
  fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), documentos: { Articulo, Certificado, codes: codes || [] } }) + '\n');
  const out = codes
    ? { Links: codes.map((c) => ({ Codigo: c, Nombre: LINKS[c][0], URL: `${SERVLET}${LINKS[c][1]}?suite${Certificado}` })), Resultado: { Estado: 'S', Mensajes: [] } }
    : { Links: [], Resultado: { Estado: 'N', Mensajes: [{ Id: 'OperacionNoValida', Description: 'Operación inexistente o no asociada al productor', Type: 1 }] } };
  return { status: 200, statusText: 'OK', headers: {}, config: cfg, data: { SDTWSDocumentosOut: out } };
}

function documentLink(cfg) {
  const url = String(cfg.url);
  const name = url.slice(SERVLET.length).split('?')[0];
  if (name.startsWith('h'))
    return { status: 302, statusText: 'Found', config: cfg, data: Buffer.alloc(0), headers: { location: `/gauswebtriunfo/servlet/o${name.slice(1)}?x`, 'set-cookie': ['JSESSIONID=suite; Path=/gauswebtriunfo; Secure'] } };
  const ok = String(cfg.headers?.Cookie || '').includes('JSESSIONID=suite');
  return { status: ok ? 200 : 403, statusText: ok ? 'OK' : 'Forbidden', config: cfg, headers: {}, data: ok ? PDF : Buffer.from('<html>403</html>') };
}

const original = axios.Axios.prototype.request;
axios.Axios.prototype.request = async function (configOrUrl, config) {
  const cfg = typeof configOrUrl === 'string' ? { ...(config || {}), url: configOrUrl } : configOrUrl || {};
  if (String(cfg.url || '').includes('RESTDocumentosV2')) return documentos(cfg);
  if (String(cfg.url || '').startsWith(SERVLET)) return documentLink(cfg);
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
