import type {
  CatalogField,
  EstadoCuentaPoliza,
  PolizaDocumento,
  PolizaSummary,
  ProductPlanSummary,
  SiniestroSummary,
} from '../../api/api.types';
import type { ListRow, OutgoingMessage, ReplyButton } from './flow.types';

/**
 * Deterministic copy and menu builders. Every message the bot sends in a
 * transactional flow comes from here, so the wording is always the same and the
 * option ids are stable (the flow.service routes on them).
 */

// ─── Option ids (kept in sync with flow.service routing) ────

export const OPT = {
  // root
  cliente: 'cliente',
  noCliente: 'no_cliente',
  // client menu
  siniestros: 'm_siniestros',
  cotizacion: 'm_cotizacion',
  pagos: 'm_pagos',
  documentos: 'm_documentos',
  grua: 'm_grua',
  asesor: 'm_asesor',
  // lead menu
  leadCotizar: 'l_cotizar',
  leadVendedor: 'l_vendedor',
  leadConsultas: 'l_consultas',
  // cotización categories
  cotAuto: 'cot_auto',
  cotMoto: 'cot_moto',
  cotBici: 'cot_bici',
  cotBolso: 'cot_bolso',
  cotComercio: 'cot_comercio',
  cotHogar: 'cot_hogar',
  cotPersonas: 'cot_personas',
  cotPraxis: 'cot_praxis',
  // siniestro
  sinNueva: 'sin_nueva',
  sinConsultar: 'sin_consultar',
  confirmar: 'confirmar',
  cancelar: 'cancelar',
  // global
  menu: 'menu',
  finalizar: 'finalizar',
  // offered when a step has failed to understand the user twice
  stuckMenu: 'stuck_menu',
  stuckAsesor: 'stuck_asesor',
} as const;

/** The client menu's option ids — the taps that still mean something after a
 * session expires (unlike a picker's `pol_`/`plan_` ids, which reference data
 * the expired session no longer has). */
export const CLIENT_MENU_OPTS = new Set<string>([
  OPT.siniestros,
  OPT.cotizacion,
  OPT.pagos,
  OPT.documentos,
  OPT.grua,
  OPT.asesor,
]);

/** Same idea for the welcome buttons. */
export const ROOT_OPTS = new Set<string>([OPT.cliente, OPT.noCliente]);

export const POLIZA_PREFIX = 'pol_';
export const DOC_PREFIX = 'doc_';
export const PLAN_PREFIX = 'plan_';

// ─── Helpers ────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function fmtMoney(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
}

/**
 * Whole-peso currency, used for fixed-plan prices and coverage amounts. Mirrors
 * the web cotizador exactly (`maximumFractionDigits: 0`) so a hogar/bolso plan
 * reads identically on WhatsApp and on the site.
 */
function fmtPlanMoney(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  });
}

/**
 * Human label per risk type. The API stores the raw Prisma enum (`other`,
 * `home`, …); showing it as-is leaked "other" into the pickers and the account
 * statement, so every fallback goes through here.
 */
const RISK_LABEL: Record<string, string> = {
  auto: 'Auto',
  moto: 'Moto',
  home: 'Hogar',
  life: 'Vida',
  commercial: 'Comercio',
  other: 'Otro riesgo',
};

function riskLabel(riskType: string): string {
  return RISK_LABEL[riskType] ?? riskType;
}

/**
 * Short, human label for a policy: the insured asset ("FORD RANGER 3.0 TDI DC
 * 4X4"), falling back to the risk type when the policy carries no vehicle.
 * Shared by the pickers, the claim confirmation and the account statement so the
 * client always recognises the policy by the same name.
 */
function polizaLabel(p: Pick<PolizaSummary, 'riskType' | 'vehiculo'>): string {
  const v = p.vehiculo;
  if (v && (v.marca || v.modelo)) {
    return [v.marca, v.modelo].filter(Boolean).join(' ');
  }
  return riskLabel(p.riskType);
}

/** Secondary line for a policy: certificate number plus plate when there is one. */
function polizaRef(p: Pick<PolizaSummary, 'certificado' | 'vehiculo'>): string {
  const dominio = p.vehiculo?.dominio;
  return `Póliza ${p.certificado}${dominio ? ` · ${dominio}` : ''}`;
}

/**
 * Legal-entity markers. The cartera stores a company's razón social in
 * `firstName`, so greeting "by name" produced "¡Hola de nuevo, JOHN PELLEGRINI
 * MANAGEMENT GROUP SRL!". When one of these matches we greet without a name.
 */
const COMPANY_RE =
  /\b(s\.?r\.?l|s\.?a\.?s?|s\.?a\.?u|sociedad|coop(erativa)?|asociaci[oó]n|fundaci[oó]n)\b\.?/i;

/**
 * How the bot addresses a client: first given name only, in normal casing. The
 * cartera stores names shouted in caps ("EVELYN ELIZABETH"), which reads as if
 * the bot were yelling. Returns null when there is no usable name (empty, or a
 * company), so callers greet without one instead of interpolating a blank.
 */
export function displayName(firstName?: string | null): string | null {
  const raw = firstName?.trim();
  if (!raw || COMPANY_RE.test(raw)) return null;

  const first = raw.split(/\s+/)[0];
  return first
    .toLowerCase()
    .replace(
      /(^|[-'])(\p{L})/gu,
      (_m, sep: string, ch: string) => sep + ch.toUpperCase(),
    );
}

/** "¡Hola de nuevo, Evelyn!" — or without the name when there isn't a usable one. */
export function returningGreeting(firstName?: string | null): string {
  const name = displayName(firstName);
  return name ? `¡Hola de nuevo, ${name}!` : '¡Hola de nuevo!';
}

// ─── Menus ──────────────────────────────────────────────────

/**
 * How the bot introduces itself. Uses the per-producer configured name
 * (Producer.botName) and falls back to a generic identity when none is set.
 */
export function botIntro(botName?: string | null): string {
  const name = botName?.trim();
  return name
    ? `Soy *${name}*, el asistente de *John Pellegrini Management Group*`
    : `Soy *el asistente de John Pellegrini Management Group* (JPMG)`;
}

export function welcomeMenu(
  firstName?: string,
  botName?: string | null,
): OutgoingMessage {
  const name = displayName(firstName);
  const hi = name ? `¡Hola, ${name}! ` : '¡Hola! ';
  return {
    kind: 'buttons',
    body:
      `${hi}${botIntro(botName)} 👋 ` +
      `Estoy para darte una mano. Para arrancar, decime: ¿ya sos cliente nuestro?`,
    buttons: [
      { id: OPT.cliente, title: 'Sí, soy cliente' },
      { id: OPT.noCliente, title: 'Todavía no' },
      { id: OPT.finalizar, title: 'Finalizar' },
    ],
  };
}

/**
 * Offered when a step has failed to read the user's answer twice in a row.
 * Repeating the same question a third time is what turned a misunderstanding
 * into a loop, so at this point we stop insisting and hand over the two things
 * that always work: going back to the list of options, or a human.
 */
export function stuckMenu(): OutgoingMessage {
  return {
    kind: 'buttons',
    body:
      'Perdón, no te estoy entendiendo por acá 🙈. ' +
      '¿Querés volver al menú y elegir de la lista, o preferís que te contacte un asesor?',
    buttons: [
      { id: OPT.stuckMenu, title: 'Elegir de la lista' },
      { id: OPT.stuckAsesor, title: 'Hablar con un asesor' },
    ],
  };
}

/** Goodbye sent when the user ends the chat (global "finalizar" command). */
export function goodbyeText(): string {
  return '¡Gracias por escribirnos! 🙌 Cerramos la conversación por acá. Cuando necesites algo, escribime de nuevo y arrancamos al toque.';
}

export function clientMenu(): OutgoingMessage {
  return {
    kind: 'list',
    body: 'Contame, ¿en qué te doy una mano hoy?',
    button: 'Ver opciones',
    rows: [
      {
        id: OPT.siniestros,
        title: '🛡️ Siniestros',
        description: 'Denunciar o consultar un siniestro',
      },
      {
        id: OPT.cotizacion,
        title: '💰 Cotización',
        description: 'Cotizar un seguro',
      },
      {
        id: OPT.pagos,
        title: '💳 Pagos y cobranzas',
        description: 'Estado de cuenta y cuotas',
      },
      {
        id: OPT.documentos,
        title: '📄 Documentación',
        description: 'Tarjeta, póliza, certificado, cupón',
      },
      {
        id: OPT.grua,
        title: '🆘 Auxilio / Grúa',
        description: 'Número de asistencia',
      },
      {
        id: OPT.asesor,
        title: '👤 Hablar con un asesor',
        description: 'Te contacta un asesor',
      },
    ],
  };
}

export function leadMenu(botName?: string | null): OutgoingMessage {
  return {
    kind: 'buttons',
    body: `¡Gracias por escribirnos! ${botIntro(botName)} 👋 ¿Con qué te puedo ayudar?`,
    buttons: [
      { id: OPT.leadCotizar, title: 'Cotizar un seguro' },
      { id: OPT.leadVendedor, title: 'Que me llamen' },
      { id: OPT.leadConsultas, title: 'Otras consultas' },
    ],
  };
}

/**
 * Quote categories. Auto and moto are quoted online (Triunfo + InfoAuto); the
 * rest are quoted by an advisor — same split as the web (only auto/moto have an
 * instant quote; the other risks are a contact form there too).
 */
export const COTIZAR_ONLINE = new Set<string>([OPT.cotAuto, OPT.cotMoto]);

/** Categories with admin-configured fixed-price plans (bolso, hogar). */
export const COTIZAR_FIXED = new Set<string>([OPT.cotBolso, OPT.cotHogar]);

/**
 * Maps a quote category option to the canonical productType the API expects for
 * leads and pricing (auto/moto are quoted online and not included here).
 */
export const COTIZAR_PRODUCT_TYPE: Record<string, string> = {
  [OPT.cotBici]: 'bici',
  [OPT.cotBolso]: 'bolso',
  [OPT.cotComercio]: 'comercio',
  [OPT.cotHogar]: 'hogar',
  [OPT.cotPersonas]: 'personas',
  [OPT.cotPraxis]: 'praxis',
};

/** Human label per quote category, used in the advisor hand-off copy. */
export const COTIZAR_LABEL: Record<string, string> = {
  [OPT.cotAuto]: 'Auto',
  [OPT.cotMoto]: 'Moto',
  [OPT.cotBici]: 'Bicicleta',
  [OPT.cotBolso]: 'Bolso protegido',
  [OPT.cotComercio]: 'Comercio e Industria',
  [OPT.cotHogar]: 'Hogar',
  [OPT.cotPersonas]: 'Personas (vida/accidentes/salud)',
  [OPT.cotPraxis]: 'Praxis profesional',
};

export function cotizarMenu(): OutgoingMessage {
  return {
    kind: 'list',
    body: '💰 *Cotización*\n¿Qué querés cotizar?',
    button: 'Ver coberturas',
    rows: [
      {
        id: OPT.cotAuto,
        title: '🚗 Auto',
        description: 'Cotización online al instante',
      },
      {
        id: OPT.cotMoto,
        title: '🏍️ Moto',
        description: 'Cotización online al instante',
      },
      {
        id: OPT.cotBici,
        title: '🚲 Bici / Monopatín',
        description: 'Urbanas, MTB, eléctricas y monopatines',
      },
      {
        id: OPT.cotBolso,
        title: '👜 Bolso protegido',
        description: 'Robo, hurto y contenido',
      },
      {
        id: OPT.cotComercio,
        title: '🏪 Comercio',
        description: 'Locales, depósitos y plantas',
      },
      {
        id: OPT.cotHogar,
        title: '🏠 Hogar',
        description: 'Edificio y contenido',
      },
      {
        id: OPT.cotPersonas,
        title: '🧑 Personas',
        description: 'Vida, accidentes y salud',
      },
      {
        id: OPT.cotPraxis,
        title: '⚕️ Praxis profesional',
        description: 'RC profesional',
      },
    ],
  };
}

/**
 * Full coverage breakdown of every fixed-price plan, sent as text before the
 * picker. Mirrors the web's comparison table ("qué incluye cada plan"): each
 * plan lists its coverages with the insured amount and the monthly fee, plus the
 * same provincial-tax disclaimer — so the WhatsApp quote matches the site.
 */
export function planDetails(
  productLabel: string,
  plans: ProductPlanSummary[],
): OutgoingMessage {
  const blocks = plans.map((p) => {
    const lines = [`*${p.name}* — ${fmtPlanMoney(p.monthlyPrice)} / mes`];
    if (p.description) lines.push(`_${p.description}_`);
    for (const c of p.coverageItems) {
      const cat = c.category ? ` (${c.category})` : '';
      lines.push(`• ${c.label}${cat}: ${fmtPlanMoney(c.amount)}`);
    }
    return lines.join('\n');
  });

  return {
    kind: 'text',
    body: [
      `📋 *${productLabel}* — qué incluye cada plan`,
      ...blocks,
      '_Estos valores pueden variar conforme los impuestos de cada provincia._\n\n👇 Elegí un plan en la lista para que un asesor lo deje listo.',
    ].join('\n\n'),
  };
}

/**
 * Fixed-price plan picker for bolso/hogar. Row id = `plan_<id>`. `intro` prefixes
 * the body when we're re-asking after an answer we couldn't read, so the retry
 * never looks like the bot repeating itself verbatim.
 */
export function planPicker(
  productLabel: string,
  plans: ProductPlanSummary[],
  intro?: string,
): OutgoingMessage {
  const rows: ListRow[] = plans.slice(0, 10).map((p) => ({
    id: `${PLAN_PREFIX}${p.id}`,
    title: p.name,
    description: `${fmtPlanMoney(p.monthlyPrice)} / mes`,
  }));
  return {
    kind: 'list',
    body: `${intro ?? ''}*${productLabel}*\nElegí el plan que más te convenga:`,
    button: 'Ver planes',
    rows,
  };
}

// Prefix for an option tapped in a `select` field picker. The suffix is the
// option's index in field.options, so the value is resolved back in the flow.
export const FIELD_OPT_PREFIX = 'field_opt_';

/**
 * The phrasing the bot uses to ask a field: the catalog's natural-language
 * `question` when set, otherwise a generic prompt built from the label (with the
 * help note and a placeholder example). Self-contained so it works as plain text
 * or as a picker body.
 */
function fieldAsk(field: CatalogField): string {
  const q = field.question?.trim();
  if (q) return q;
  const help = field.help ? ` _(${field.help})_` : '';
  const example = field.placeholder
    ? ` Por ejemplo: *${field.placeholder}*.`
    : '';
  return field.numeric
    ? `¿Cuál es *${field.label}*?${help} Escribilo en números.${example}`
    : `Decime *${field.label}*.${help}${example}`;
}

/**
 * Question for a single catalog field, asked when the user types instead of
 * tapping (text/numeric fields). `intro` prefixes the very first field with the
 * "te ayudo a cotizar X" line so the capture opens naturally, and is reused to
 * gently re-ask after an invalid answer; later fields are asked on their own.
 */
export function fieldPrompt(
  field: CatalogField,
  intro?: string,
): OutgoingMessage {
  return { kind: 'text', body: `${intro ?? ''}${fieldAsk(field)}` };
}

/** Interactive picker for a `select` catalog field. Row id = `field_opt_<index>`. */
export function fieldSelectPicker(
  field: CatalogField,
  intro?: string,
): OutgoingMessage {
  const rows: ListRow[] = (field.options ?? []).slice(0, 10).map((opt, i) => ({
    id: `${FIELD_OPT_PREFIX}${i}`,
    title: opt,
  }));
  return {
    kind: 'list',
    body: `${intro ?? ''}${fieldAsk(field)}`,
    button: 'Ver opciones',
    rows,
  };
}

// ─── LLM output cleanup ─────────────────────────────────────

/**
 * Rewrites the standard-markdown the model keeps emitting into WhatsApp's own
 * syntax. WhatsApp bolds with a single `*`, so every quote went out reading
 * literally `**Cobertura A**`; it has no headings either. The prompt already
 * asks for WhatsApp formatting — this is the belt to that suspenders, applied to
 * whatever the model actually produced.
 */
export function toWhatsAppMarkdown(text: string): string {
  return (
    text
      // **bold** / __bold__ → *bold*  (run before the italics rule)
      .replace(/\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/g, '*$1*')
      .replace(/__(?!\s)([\s\S]+?)(?<!\s)__/g, '*$1*')
      // ### Heading → *Heading*
      .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '*$1*')
      // Markdown bullets "- " / "* " → the bullet WhatsApp users expect
      .replace(/^(\s*)[-*]\s+(?=\S)/gm, '$1• ')
      .trim()
  );
}

// ─── GNC (cotización online) ────────────────────────────────

/**
 * The one yes/no the quote sub-flow always has to ask. The LLM writes the
 * question as free text, so we re-render it as reply buttons: the client taps
 * instead of typing and the answer comes back as a fixed label the model can't
 * misread ("Sí, tiene GNC" arrives as the user's text), which saves the extra
 * round trip an ambiguous answer would otherwise cost.
 */
const GNC_BUTTONS: ReplyButton[] = [
  { id: 'gnc_si', title: 'Sí, tiene GNC' },
  { id: 'gnc_no', title: 'No tiene GNC' },
];

/** A numbered list means the message is still offering options — not a yes/no. */
const NUMBERED_LIST_RE = /^\s*\d+[.)]\s/m;

/**
 * Turns a model reply that ends by asking about GNC into a buttons message, or
 * returns null when it isn't that question. We only convert when the *last*
 * question of the message is the GNC one and the message isn't still offering a
 * numbered list of versions — otherwise the buttons would answer a different
 * question than the one on screen.
 */
export function gncButtons(reply: string): OutgoingMessage | null {
  if (NUMBERED_LIST_RE.test(reply)) return null;

  const end = reply.lastIndexOf('?');
  if (end === -1) return null;
  // The closing question starts after the nearest opening "¿" or sentence break.
  const before = reply.slice(0, end);
  const start = Math.max(
    before.lastIndexOf('¿'),
    before.lastIndexOf('.'),
    before.lastIndexOf('!'),
    before.lastIndexOf('\n'),
  );
  if (!/\bgnc\b/i.test(before.slice(start + 1))) return null;

  // The model sometimes still appends "(sí/no)" — the buttons replace it.
  const body = reply.replace(/\s*\(\s*s[ií]\s*\/\s*no\s*\)/gi, '').trim();
  return body ? { kind: 'buttons', body, buttons: GNC_BUTTONS } : null;
}

export function siniestroTypeMenu(): OutgoingMessage {
  return {
    kind: 'buttons',
    body: '🛡️ *Siniestros*\n¿Qué necesitás?',
    buttons: [
      { id: OPT.sinNueva, title: 'Denuncia nueva' },
      { id: OPT.sinConsultar, title: 'Consultar una' },
    ],
  };
}

export function polizaPicker(
  polizas: PolizaSummary[],
  body: string,
): OutgoingMessage {
  const rows: ListRow[] = polizas.map((p) => ({
    id: `${POLIZA_PREFIX}${p.id}`,
    title: polizaLabel(p),
    description: polizaRef(p),
  }));
  return { kind: 'list', body, button: 'Elegir póliza', rows };
}

export function docPicker(docs: PolizaDocumento[]): OutgoingMessage {
  const rows: ListRow[] = docs.map((d) => ({
    id: `${DOC_PREFIX}${d.codigo}`,
    title: d.nombre,
  }));
  return {
    kind: 'list',
    body: '📄 ¿Qué documento querés que te envíe?',
    button: 'Ver documentos',
    rows,
  };
}

export function siniestroConfirm(
  poliza: PolizaSummary | undefined,
  fecha: string,
  descripcion: string,
): OutgoingMessage {
  const polizaTxt = poliza
    ? `${polizaLabel(poliza)} (${polizaRef(poliza)})`
    : 'la póliza seleccionada';
  return {
    kind: 'buttons',
    body:
      `Revisá la denuncia antes de registrarla:\n\n` +
      `• *Póliza:* ${polizaTxt}\n` +
      `• *Fecha del hecho:* ${fecha}\n` +
      `• *Descripción:* ${descripcion}\n\n` +
      `¿Confirmás?`,
    buttons: [
      { id: OPT.confirmar, title: 'Confirmar' },
      { id: OPT.cancelar, title: 'Cancelar' },
    ],
  };
}

// ─── Data formatting (free text) ────────────────────────────

export function formatEstadoCuenta(polizas: EstadoCuentaPoliza[]): string {
  if (polizas.length === 0) {
    return 'No encontré pólizas asociadas a tu cuenta. Si creés que es un error, te derivo con un asesor.';
  }

  const blocks = polizas.map((p) => {
    // The client recognises the policy by the insured asset, not by its
    // certificate number — same label the claim flow uses.
    const head = `*${polizaLabel(p)}*\n_${polizaRef(p)}_`;
    if (p.cuotasImpagas.length === 0) {
      return `${head}\n✅ Sin cuotas impagas. ${p.cuotasPagas} cuota(s) paga(s).`;
    }
    const cuotas = p.cuotasImpagas
      .map((c) => {
        const tag =
          c.status === 'rejected'
            ? '⛔ rechazo de débito'
            : c.status === 'overdue'
              ? '⚠️ vencida'
              : 'pendiente';
        return `  • Cuota ${c.numeroCuota}: ${fmtMoney(c.amount)} — vence ${fmtDate(c.dueDate)} (${tag})`;
      })
      .join('\n');
    const aviso = p.tieneRechazos
      ? '\n⚠️ Hay un rechazo de débito. Un asesor te va a contactar para regularizarlo.'
      : '';
    return `${head}\n${cuotas}${aviso}`;
  });

  return ['💳 *Estado de cuenta*', ...blocks].join('\n\n');
}

export function formatSiniestros(siniestros: SiniestroSummary[]): string {
  if (siniestros.length === 0) {
    return 'No tenés denuncias de siniestro registradas. Si querés iniciar una, elegí *Denuncia nueva*.';
  }

  const estados: Record<string, string> = {
    pendiente: '🟡 Pendiente de carga en la compañía',
    en_proceso: '🔵 En proceso',
    resuelto: '🟢 Resuelto',
  };

  const blocks = siniestros.map((s) => {
    const estado = estados[s.estado] ?? s.estado;
    const oficial = s.nroSiniestroCompania
      ? `\n  N° oficial Triunfo: ${s.nroSiniestroCompania}`
      : '\n  Aún sin número oficial (en carga).';
    return (
      `• *${s.tipo}* — ${fmtDate(s.fecha)}\n` + `  Estado: ${estado}${oficial}`
    );
  });

  return ['🛡️ *Tus siniestros*', ...blocks].join('\n\n');
}

export function formatDocumento(doc: PolizaDocumento): string {
  return (
    `📄 *${doc.nombre}*\n${doc.url}\n\n` +
    `Podés llevarla en el celular, no es obligatorio tenerla impresa.`
  );
}
