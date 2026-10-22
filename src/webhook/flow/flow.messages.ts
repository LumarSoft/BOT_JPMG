import type {
  CatalogField,
  CuotaImpaga,
  EstadoCuentaPoliza,
  PolizaDocumento,
  PolizaSummary,
  ProductPlanSummary,
  SiniestroSummary,
} from '../../api/api.types';
import type { ListRow, OutgoingMessage, ReplyButton } from './flow.types';
import { fold } from '../text';

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
  // Not shown in the menu: typed requests for payment coupons route here.
  cupones: 'm_cupones',
  // Offered after the account status: adhere a card/CBU or move to coupons.
  cambioPago: 'm_cambio_pago',
  bajaPoliza: 'm_baja_poliza',
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
  // "¿hablo con Juan?" — the number writing is that client's phone
  phoneSi: 'id_phone_si',
  phoneNo: 'id_phone_no',
  // "¿es por esto o por otra cosa?" after asking for an advisor
  asesorMisma: 'asesor_misma',
  asesorOtra: 'asesor_otra',
  // "No, es otra cosa" when a request was read as a cancellation
  bajaNo: 'baja_no',
  // Never shown: the model passes a request only the office can do, with its
  // summary as the text (see the FAQ's pasar_a_la_oficina tool).
  pedidoOficina: 'm_pedido_oficina',
  // Never shown in the menu: "¿mi póliza cubre X?", read from the message or
  // opened by the FAQ model.
  cobertura: 'm_cobertura',
} as const;

/** The client menu's option ids — the taps that still mean something after a
 * session expires (unlike a picker's `pol_`/`plan_` ids, which reference data
 * the expired session no longer has). */
export const CLIENT_MENU_OPTS = new Set<string>([
  OPT.siniestros,
  OPT.cotizacion,
  OPT.pagos,
  OPT.documentos,
  OPT.cupones,
  OPT.cambioPago,
  OPT.bajaPoliza,
  OPT.grua,
  OPT.asesor,
  OPT.cobertura,
]);

/** Same idea for the welcome buttons. */
export const ROOT_OPTS = new Set<string>([OPT.cliente, OPT.noCliente]);

/** The non-client menu's options ("Ya soy cliente" included). */
export const LEAD_MENU_OPTS = new Set<string>([
  OPT.leadCotizar,
  OPT.leadVendedor,
  OPT.leadConsultas,
  OPT.cliente,
]);

/**
 * A request read as a cancellation without the customer saying "baja": asked
 * before opening it ("necesito el descuento de la cuota" was opened as one).
 */
export function bajaCheck(): OutgoingMessage {
  return {
    kind: 'buttons',
    body: 'Para no equivocarme: ¿querés dar de baja una póliza?',
    buttons: [
      { id: OPT.bajaPoliza, title: 'Sí, dar de baja' },
      { id: OPT.bajaNo, title: 'No, es otra cosa' },
    ],
  };
}

export const POLIZA_PREFIX = 'pol_';
/** "Todas mis pólizas" row of the coupon picker. */
export const ALL_POLIZAS_ID = `${POLIZA_PREFIX}todas`;
/** "Otra póliza" row: one we don't have (another insurer, a nómina). */
export const OTHER_POLIZA_ID = `${POLIZA_PREFIX}otra`;
export const DOC_PREFIX = 'doc_';
/** "Todos los documentos" row of the document picker. */
export const ALL_DOCS_ID = `${DOC_PREFIX}todos`;
/** "Copia de una denuncia" row of the document picker: the office sends it. */
export const CLAIM_COPY_ID = `${DOC_PREFIX}denuncia`;

/** "Copia de la denuncia", "la denuncia administrativa". Folded text. */
export const CLAIM_COPY_RE =
  /\bcopia de (?:la |mi |una )?denuncia\b|\bdenuncia administrativa\b|\bconstancia de (?:la )?denuncia\b|\b(?:la |mi )?denuncia (?:en pdf|impresa|firmada)\b/;

/**
 * Asks for the company's claims phone ("¿cuál es el 0800 para denunciar?").
 * Not "número de siniestro", which is the claim number. Folded text.
 */
export const CLAIMS_PHONE_RE =
  /\b0 ?8[01]0\b|\btelefono\b.{0,50}\b(?:denunci|siniestro|compania|triunfo|aseguradora)|\b(?:denunci|siniestro|compania|triunfo|aseguradora)\w*\b.{0,50}\btelefono\b|\bllam(?:o|ar|amos)\b.{0,40}\b(?:denunci|siniestro|triunfo|compania|aseguradora)/;
export const PLAN_PREFIX = 'plan_';

// ─── Helpers ────────────────────────────────────────────────

/**
 * Due dates and incident dates are calendar days stored at UTC midnight: read
 * in Argentine time they fell on the day before ("vence 05/10" for the 6th).
 */
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
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
export function polizaLabel(
  p: Pick<PolizaSummary, 'riskType' | 'vehicle'> & {
    product?: string | null;
  },
): string {
  const v = p.vehicle;
  if (v && (v.brand || v.model)) {
    return [v.brand, v.model].filter(Boolean).join(' ');
  }
  // "Bicicleta", "Sepelio", "Acc. personales" instead of "Otro riesgo" or
  // "Vida" three times in a list (#216, #224).
  return p.product?.trim() || riskLabel(p.riskType);
}

/**
 * Secondary line for a policy: certificate number plus plate, or the insured
 * address of a home or shop, when there is one.
 */
function polizaRef(
  p: Pick<PolizaSummary, 'certificateNumber' | 'vehicle'> & {
    place?: string | null;
  },
): string {
  const where = p.vehicle?.licensePlate || p.place?.trim();
  return `Póliza ${p.certificateNumber}${where ? ` · ${where}` : ''}`;
}

/** One-line mention for the office: "CHEVROLET CORSA (Póliza 1741715 · ABC123)". */
export function polizaMention(
  p: Pick<PolizaSummary, 'riskType' | 'vehicle' | 'certificateNumber'> & {
    product?: string | null;
    place?: string | null;
  },
): string {
  return `${polizaLabel(p)} (${polizaRef(p)})`;
}

/** "CONTENIDO GENERAL" → "Contenido general". */
const sentenceCase = (text: string) =>
  text ? text.charAt(0) + text.slice(1).toLowerCase() : text;

/**
 * What a policy covers, written out: the shown answer when the model can't
 * read the question, and the detail behind "¿qué me cubre mi seguro?".
 */
export function coverageSummary(p: PolizaSummary): string {
  const head = `🛡️ Tu *${polizaLabel(p)}* (${polizaRef(p)})`;
  const tail =
    '\n\nSi lo que buscás no figura acá, tocá *Hablar con un asesor* y la oficina te lo confirma.';
  const c = p.coverage;
  if (c && c.benefits.length) {
    const lines = [
      `${head} tiene *${c.name}*${c.code ? ` (${c.code})` : ''}:`,
      ...c.benefits.map((b) => `• ${b}`),
      ...(c.exclusions.length
        ? ['', '_No incluye:_', ...c.exclusions.map((e) => `• ${e}`)]
        : []),
      ...(c.deductible ? ['', `Franquicia: ${c.deductible}`] : []),
    ];
    return lines.join('\n') + tail;
  }
  const riesgos = p.riesgos ?? [];
  if (riesgos.length) {
    const lines = riesgos.map((r) => {
      const name =
        r.cobertura && r.cobertura !== r.riesgo
          ? `${sentenceCase(r.riesgo)} · ${sentenceCase(r.cobertura)}`
          : sentenceCase(r.riesgo || r.cobertura);
      return `• ${name}${r.sumaAsegurada !== null ? ` — hasta ${fmtMoney(r.sumaAsegurada)}` : ''}`;
    });
    return [`${head} cubre:`, ...lines].join('\n') + tail;
  }
  return `${head}: no tengo el detalle de lo que cubre.${tail}`;
}

/** Under a coverage answer: the claim and the office are a tap away. */
export function claimOrAdvisorButtons(): OutgoingMessage {
  return {
    kind: 'buttons',
    body: '¿Qué querés hacer?',
    buttons: [
      { id: OPT.siniestros, title: 'Hacer una denuncia' },
      { id: OPT.asesor, title: 'Hablar con un asesor' },
      { id: OPT.menu, title: 'Volver al menú' },
    ],
  };
}

/** WhatsApp cuts list-row titles at 24 characters. */
const ROW_TITLE_MAX = 24;

const shorten = (text: string, max = ROW_TITLE_MAX) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/**
 * List titles that tell policies apart. Two "RENAULT LOGAN II 1.6" or three
 * "Vida" read the same on a list (#216, #238): a repeated title starts with the
 * plate (a vehicle), the address or the policy number, which fit in the 24
 * characters WhatsApp shows.
 */
export function polizaTitles(
  polizas: Array<
    Pick<PolizaSummary, 'riskType' | 'vehicle' | 'certificateNumber'> & {
      product?: string | null;
      place?: string | null;
    }
  >,
): string[] {
  const labels = polizas.map((p) => polizaLabel(p));
  const count = new Map<string, number>();
  for (const l of labels) count.set(l, (count.get(l) ?? 0) + 1);
  return polizas.map((p, i) => {
    const label = labels[i];
    // Meta cuts a long unique title itself; only the prefixed ones are cut here.
    if ((count.get(label) ?? 0) < 2) return label;
    const key = p.vehicle?.licensePlate?.trim() || p.place?.trim();
    // The policy number reads after the name: "Acc. personales 1205970".
    return shorten(
      key ? `${key} · ${label}` : `${label} ${p.certificateNumber}`,
    );
  });
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
export function displayName(
  firstName?: string | null,
  /** The WhatsApp profile name, to tell the given name among several words. */
  profileName?: string | null,
): string | null {
  const raw = firstName?.trim();
  if (!raw || COMPANY_RE.test(raw)) return null;

  // Triunfo sends "APELLIDO NOMBRES" in one string, so a compound surname
  // ("RUIZ PAZ SOFIA") leaves part of it in firstName: "¿Hablo con Paz?".
  // The word the WhatsApp profile starts with is the given name.
  const words = raw.split(/\s+/);
  const fold = (w: string) =>
    w
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  const profileFirst = profileName
    ? fold(profileName.trim().split(/\s+/)[0])
    : '';
  const first =
    (words.length > 1 && words.find((w) => fold(w) === profileFirst)) ||
    words[0];
  return first
    .toLowerCase()
    .replace(
      /(^|[-'])(\p{L})/gu,
      (_m, sep: string, ch: string) => sep + ch.toUpperCase(),
    );
}

/** "¡Hola de nuevo, Evelyn!" — or without the name when there isn't a usable one. */
export function returningGreeting(
  firstName?: string | null,
  profileName?: string | null,
): string {
  const name = displayName(firstName, profileName);
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

/**
 * How much the welcome introduces the bot. The full introduction goes once: a
 * chat that already saw it (later in the same session) or that talked to us a
 * few hours ago gets the question alone — repeating "Soy NICO…" on every turn
 * read like a bot stuck in a loop.
 */
export type WelcomeIntro = 'full' | 'returning' | 'none';

/** One-line opener for a reply that already answers the first message. */
export function openingLine(
  intro: WelcomeIntro,
  botName?: string | null,
): string | null {
  if (intro === 'full') return `¡Hola! ${botIntro(botName)} 👋`;
  if (intro === 'returning') return '¡Hola de nuevo! 👋';
  return null;
}

export function welcomeMenu(
  firstName?: string,
  botName?: string | null,
  intro: WelcomeIntro = 'full',
): OutgoingMessage {
  const name = displayName(firstName);
  const hi = name ? `¡Hola, ${name}! ` : '¡Hola! ';
  const body =
    intro === 'full'
      ? `${hi}${botIntro(botName)} 👋 Estoy para darte una mano. Para arrancar, decime: ¿ya sos cliente nuestro?`
      : intro === 'returning'
        ? '¡Hola de nuevo! 👋 Para arrancar, decime: ¿ya sos cliente nuestro?'
        : 'Para ayudarte, decime: ¿ya sos cliente nuestro?';
  return {
    kind: 'buttons',
    body,
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
        id: OPT.bajaPoliza,
        title: 'Baja de póliza',
        description: 'Solicitar la baja de un seguro',
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

export function leadMenu(): OutgoingMessage {
  return {
    kind: 'list',
    body: 'Perfecto, ¿con qué te puedo ayudar?',
    button: 'Ver opciones',
    rows: [
      { id: OPT.leadCotizar, title: '💰 Cotizar un seguro' },
      { id: OPT.leadVendedor, title: '📞 Que me llamen' },
      { id: OPT.leadConsultas, title: '💬 Otras consultas' },
      // Who tapped "Todavía no" by mistake had no way to their policies.
      {
        id: OPT.cliente,
        title: '👤 Ya soy cliente',
        description: 'Siniestros, pagos y documentación',
      },
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

/**
 * Whether a client message says the car has GNC: the button they tapped (its
 * label arrives as the text), a bare yes/no right after the bot asked, or an
 * explicit mention ("tiene GNC", "sin GNC"). Undefined when it says nothing —
 * the quote must not go out on a guess (the model used to assume "no").
 */
export function gncAnswer(
  text: string,
  previousBotText?: string,
): boolean | undefined {
  const label = text.trim().toLowerCase();
  const button = GNC_BUTTONS.find((b) => b.title.toLowerCase() === label);
  if (button) return button.id === 'gnc_si';
  const t = fold(text);
  if (/\bgnc\b/.test(t) && !/\bno se\b/.test(t)) {
    if (
      /\b(?:sin|no tiene|no usa|no lleva|no es a|no)\s+(?:el\s+)?gnc\b/.test(t)
    )
      return false;
    if (/\b(?:tiene|con|usa|lleva|a)\s+(?:el\s+)?gnc\b/.test(t)) return true;
  }
  // The stored question carries its button labels after it, so it is not
  // necessarily the end of the message.
  if (previousBotText && /\bgnc\s*\?/.test(fold(previousBotText))) {
    if (/^(?:si|sip|claro|correcto|afirmativo|tiene)\b/.test(t)) return true;
    if (/^(?:no|nop|nope|negativo)\b/.test(t)) return false;
  }
  return undefined;
}

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
  options: { allRow?: boolean; otherRow?: boolean } = {},
): OutgoingMessage {
  const titles = polizaTitles(polizas);
  const rows: ListRow[] = polizas.map((p, i) => ({
    id: `${POLIZA_PREFIX}${p.id}`,
    title: titles[i],
    description: polizaRef(p),
  }));
  // A WhatsApp list holds at most 10 rows.
  if (options.allRow && rows.length > 1 && rows.length < 10)
    rows.push({ id: ALL_POLIZAS_ID, title: 'Todas mis pólizas' });
  // Asked for the drivers' accidentes personales (in SanCor), a customer
  // could only pick one of his trucks.
  if (options.otherRow && rows.length < 10)
    rows.push({
      id: OTHER_POLIZA_ID,
      title: 'Otra póliza',
      description: 'No está en la lista',
    });
  return { kind: 'list', body, button: 'Elegir póliza', rows };
}

/** Selection ids of the cancellation-reason picker. */
export const BAJA_MOTIVO_PREFIX = 'bm_';
export const BAJA_MOTIVO_OTRO_ID = `${BAJA_MOTIVO_PREFIX}otro`;

/**
 * Why the client wants out, worded as the office files it. "venta" reads
 * differently for a car and for a home or shop policy.
 */
export function bajaMotivoLabels(vehicle: boolean): Record<string, string> {
  return {
    [`${BAJA_MOTIVO_PREFIX}venta`]: vehicle
      ? 'Vendí el vehículo'
      : 'Vendí / ya no tengo el bien',
    [`${BAJA_MOTIVO_PREFIX}costo`]: 'Por el costo',
    [`${BAJA_MOTIVO_PREFIX}desistimiento`]: 'Ya no lo necesito',
    [`${BAJA_MOTIVO_PREFIX}cambio`]: 'Cambio de compañía',
  };
}

/**
 * Asked after the client confirms the cancellation, so the office knows the
 * motive before calling (John, 21/10: sale, desisting, cost…).
 */
export function bajaMotivoPicker(vehicle: boolean): OutgoingMessage {
  const labels = bajaMotivoLabels(vehicle);
  return {
    kind: 'list',
    body: '¿Por qué motivo pedís la baja? Así la oficina lo gestiona más rápido.',
    button: 'Elegir motivo',
    rows: [
      ...Object.entries(labels).map(([id, title]) => ({ id, title })),
      {
        id: BAJA_MOTIVO_OTRO_ID,
        title: 'Otro motivo',
        description: 'Te pido que me lo cuentes',
      },
    ],
  };
}

/** What to send for "Otra póliza": the office takes it from the description. */
export function otherPolizaPrompt(): OutgoingMessage {
  return {
    kind: 'text',
    body: 'Contame cuál es (patente, a nombre de quién está o de qué compañía) y qué necesitás, y se lo paso a la oficina.',
  };
}

/** "¿Hablo con Juan?" — the number writing is that client's phone. */
export function phoneQuestion(
  name: string,
  opener?: string | null,
): OutgoingMessage {
  const yes = `Sí, soy ${name}`;
  return {
    kind: 'buttons',
    body: `${opener ? `${opener} ` : ''}¿Hablo con *${name}*? Si sos vos, te identifico con este número y seguimos.`,
    buttons: [
      // WhatsApp cuts button titles at 20 characters.
      { id: OPT.phoneSi, title: yes.length <= 20 ? yes : 'Sí, soy yo' },
      { id: OPT.phoneNo, title: 'No, soy otra persona' },
    ],
  };
}

/** Offers the reason the customer already gave instead of asking for it again. */
export function advisorSameQuestion(question: string): OutgoingMessage {
  const quoted =
    question.length > 200 ? `${question.slice(0, 200)}…` : question;
  return {
    kind: 'buttons',
    body: `Listo, ya le pasé a la oficina tu consulta 🙌 Un asesor te contacta por este chat.\n\n_“${quoted}”_\n\n¿Es por esto o por otra cosa?`,
    buttons: [
      { id: OPT.asesorMisma, title: 'Sí, es eso' },
      { id: OPT.asesorOtra, title: 'Es otra cosa' },
    ],
  };
}

/** What follows the account status: the payment things only the office can do. */
export function pagosMenu(): OutgoingMessage {
  return {
    kind: 'list',
    body: '¿Necesitás algo más con tus pagos?',
    button: 'Ver opciones',
    rows: [
      {
        id: OPT.cupones,
        title: '🧾 Pedir cupón de pago',
        description: 'La oficina te lo manda por acá',
      },
      {
        id: OPT.cambioPago,
        title: '💳 Cambiar forma de pago',
        description: 'Adherir tarjeta o CBU, o pasar a cupón',
      },
      {
        id: OPT.asesor,
        title: '👤 Hablar con un asesor',
        description: 'Te contacta un asesor',
      },
      { id: OPT.menu, title: '↩️ Volver al menú' },
    ],
  };
}

/** Reply to photos of the incident added to a claim in the guided photo step. */
export function claimPhotoAddedText(count = 1): string {
  return count === 1
    ? '📎 Recibí la foto y la sumé a tu denuncia. Si tenés *más fotos del siniestro*, mandámelas. Cuando termines, escribí *listo*.'
    : `📎 Recibí las ${count} fotos y las sumé a tu denuncia. Si tenés *más fotos del siniestro*, mandámelas. Cuando termines, escribí *listo*.`;
}

/** Reply to photos of the vehicle in the take-out documents. */
export function vehiclePhotoAddedText(count = 1): string {
  return count === 1
    ? '📎 Recibí la foto del vehículo. Si te falta algún lado, mandala; cuando termines, escribí *listo*.'
    : `📎 Recibí las ${count} fotos del vehículo. Si te falta algún lado, mandala; cuando termines, escribí *listo*.`;
}

/** The latest guided-step reply, worded for every photo of the batch it answers. */
export function pluralizeClaimPhotoReply(
  messages: OutgoingMessage[],
  count: number,
): OutgoingMessage[] {
  if (count === 1) return messages;
  return messages.map((m) => {
    if (m.kind !== 'text') return m;
    if (m.body === claimPhotoAddedText(1))
      return { ...m, body: claimPhotoAddedText(count) };
    if (m.body === vehiclePhotoAddedText(1))
      return { ...m, body: vehiclePhotoAddedText(count) };
    return m;
  });
}

export function docPicker(
  docs: PolizaDocumento[],
  body = '📄 ¿Qué documento querés que te envíe?',
): OutgoingMessage {
  const rows: ListRow[] = docs.map((d) => ({
    id: `${DOC_PREFIX}${d.code}`,
    // Meta rejects list rows longer than 24 characters.
    title: d.name.slice(0, 24),
  }));
  if (docs.length > 1)
    rows.push({ id: ALL_DOCS_ID, title: 'Todos los documentos' });
  // Triunfo does not give it: the office sends the claim it filed (#205, #209).
  if (rows.length < 10)
    rows.push({
      id: CLAIM_COPY_ID,
      title: 'Copia de una denuncia',
      description: 'Te la manda la oficina',
    });
  return { kind: 'list', body, button: 'Ver documentos', rows };
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

/**
 * "¿Por qué no se debitó?", "no me descontaron la cuota", "rechazaron el
 * débito", "le di stop debit", "no se realizó por débito automático", "me
 * llegó una notificación de que no se pudo realizar el pago", "pago fallido".
 * Folded text.
 */
export const DEBIT_FAILED_RE =
  /\bno (?:se )?(?:me |le |nos )?(?:(?:pudo|pudieron|pueden) )?(?:debit|descont|cobr)|\brechaz|\bstop debit|\bno (?:paso|entro|impacto) el (?:debito|pago)|\bno se (?:realizo|hizo|efectuo|proceso|concreto|acredito)\b.*\b(?:debito|pago|cobro)|\bno (?:se )?pud(?:o|ieron) (?:realizar|hacer|efectuar|procesar|concretar)(?: el| la)? (?:pago|debito|cobro)|\b(?:pago|debito) (?:fallido|fallo|rechazado|no realizado)|\bfallo el (?:pago|debito)/;

/**
 * "No me aparece la factura para pagar", "ya debería pagar la cuota 4 y no me
 * aparece en la aplicación". Folded text.
 */
export const INSTALLMENT_MISSING_RE =
  /\bno (?:me |le |nos )?(?:aparece|aparecen|figura|figuran|sale|salen|encuentro|lo encuentro|la encuentro|llego|llegaron)\b.*\b(?:factura|cuota|cupon|boleta|pagar|pago|app|aplicacion)|\b(?:factura|cuota|cupon|boleta)s?\b.*\bno (?:me |le )?(?:aparece|figura|sale|llego)|\bya (?:deberia|tendria que|tengo que) pagar\b/;

/** Triunfo's "Débito Tarjeta", "Débito Caja de Ahorro"…; the rest is paid with a coupon. */
function paysByDebit(
  p: Pick<EstadoCuentaPoliza, 'paymentMethod'>,
): boolean | null {
  const method = fold(p.paymentMethod ?? '').trim();
  if (!method) return null;
  return method.startsWith('debito');
}

function paymentLine(p: EstadoCuentaPoliza): string {
  const debit = paysByDebit(p);
  if (debit === null) return '';
  return debit
    ? '\n💳 Se paga por *débito automático*.'
    : '\n🧾 Se paga con *cupón* (no tiene débito automático).';
}

const isOverdue = (c: CuotaImpaga) =>
  c.status === 'overdue' || c.status === 'rejected';

/**
 * How long after its due date a debit installment with no rejection is still
 * being collected: the cartera shows it overdue until the bank's answer comes
 * in, and "⚠️ vencida" alarmed a customer whose debit was in process.
 */
const DEBIT_IN_PROCESS_DAYS = 40;

/** A debit installment past due, no rejection yet: the bank is collecting it. */
function inDebitProcess(p: EstadoCuentaPoliza, c: CuotaImpaga): boolean {
  if (paysByDebit(p) !== true || c.status !== 'overdue' || !c.dueDate)
    return false;
  const days = (Date.now() - new Date(c.dueDate).getTime()) / 86_400_000;
  return days <= DEBIT_IN_PROCESS_DAYS;
}

const DEBIT_IN_PROCESS_NOTE =
  '\n_Se debita en estos días: dejá el dinero disponible. Si el banco la rechaza, te avisamos para pagarla con cupón._';

const DEBIT_NOT_DONE_NOTE =
  '\n⚠️ Me contás que el débito no se hizo. Ya le avisé a la oficina para regularizarlo: te escriben por este chat (se puede pagar con cupón o transferencia).';

/**
 * The policies whose debit the customer says did not go through and that we
 * still show as being collected: the office has to hear it, because the bot
 * has no rejection on record (#242: the office had sent the coupon for a
 * rejected debit and the bot answered "en proceso de débito").
 */
export function debitNotDone(
  polizas: EstadoCuentaPoliza[],
): EstadoCuentaPoliza[] {
  return polizas.filter(
    (p) =>
      !p.hasRejectedInstallments &&
      p.unpaidInstallments.some((c) => inDebitProcess(p, c)),
  );
}

export function formatEstadoCuenta(
  polizas: EstadoCuentaPoliza[],
  /** The customer says the debit did not go through: nothing is "in process". */
  opts: { debitFailed?: boolean } = {},
): string {
  if (polizas.length === 0) {
    return 'No encontré pólizas asociadas a tu cuenta. Si creés que es un error, escribí *asesor* y lo revisa la oficina.';
  }

  const blocks = polizas.map((p) => {
    // The client recognises the policy by the insured asset, not by its
    // certificate number — same label the claim flow uses.
    const head = `*${polizaLabel(p)}*\n_${polizaRef(p)}_`;
    if (p.unpaidInstallments.length === 0) {
      // Batches are numbered from 1 again, so the next one goes without a number.
      const proxima = p.nextDueDate
        ? `\n🗓️ Próxima cuota: vence alrededor del ${fmtDate(p.nextDueDate)}. Todavía no figura emitida.`
        : '';
      return `${head}\n✅ Sin cuotas impagas. ${p.paidInstallments} cuota(s) paga(s).${proxima}${paymentLine(p)}`;
    }
    const cuotas = p.unpaidInstallments
      .map((c) => {
        const tag =
          c.status === 'rejected'
            ? '⛔ rechazo de débito'
            : inDebitProcess(p, c)
              ? opts.debitFailed
                ? '⚠️ sin debitar'
                : '⏳ en proceso de débito'
              : c.status === 'overdue'
                ? '⚠️ vencida'
                : 'pendiente';
        // The first installment of a renewed policy read as a second charge
        // (#245): "the one debited was the last of the old policy".
        const renewal =
          c.number === 1 && /RENOVACION/i.test(p.lastMovement ?? '')
            ? ' · 1ª cuota de la renovación'
            : '';
        return `  • Cuota ${c.number}: ${fmtMoney(c.amount)} — vence ${fmtDate(c.dueDate)} (${tag}${renewal})`;
      })
      .join('\n');
    // Only for coupons: debit installments often show as overdue while the
    // bank is still collecting them, so a total there would ask for money twice.
    const vencidas = p.unpaidInstallments.filter(isOverdue);
    const total =
      paysByDebit(p) === false && vencidas.length > 1
        ? `\n  *Total vencido: ${fmtMoney(vencidas.reduce((sum, c) => sum + Number(c.amount), 0))}*`
        : '';
    const aviso = p.hasRejectedInstallments
      ? '\n⚠️ Hay un rechazo de débito. Ya le avisé a la oficina para regularizarlo: te escriben por este chat.'
      : '';
    const enProceso = p.unpaidInstallments.some((c) => inDebitProcess(p, c))
      ? opts.debitFailed && !p.hasRejectedInstallments
        ? DEBIT_NOT_DONE_NOTE
        : DEBIT_IN_PROCESS_NOTE
      : '';
    return `${head}\n${cuotas}${total}${paymentLine(p)}${enProceso}${aviso}`;
  });

  return ['💳 *Estado de cuenta*', ...blocks].join('\n\n');
}

/**
 * The payment rules the office repeats by hand (chats 6–20/10): until when an
 * installment can be paid, how to pay, card versus cash, a stolen vehicle, a
 * policy left "sin forma de pago" and the first installment of a renewal.
 * Folded text.
 */
export const PAY_DEADLINE_RE =
  /\bhasta cuando\b|\bhasta que (?:dia|fecha)\b|\bplazo\b|\bhasta el (?:dia )?10\b|\bpuedo pagar(?:la|lo)? (?:despues|mas tarde|la semana|el mes)|\bsi (?:la |lo )?pago (?:despues|tarde|atrasad|la semana|el mes)|\bsigo (?:estando )?cubiert|\bme quedo sin (?:seguro|cobertura)/;
export const PAY_METHODS_RE =
  /\bformas? de pago\b|\bmedios? de pago\b|\bcomo (?:puedo |se )?pag|\bdonde (?:puedo |se )?pag|\bpuedo pagar(?:la|lo)? (?:con|por|en|por)\b|\bmercado ?pago\b|\brapipago\b|\bpago ?facil\b|\bsanta fe servicios\b|\bhome ?banking\b/;
export const CARD_VS_CASH_RE =
  /\bmismo precio\b|\bmas (?:barat|car)|\bdiferencia\b|\brecargo\b|\bconviene (?:pagar|con)|\b(?:cupon|efectivo)\b.{0,30}\b(?:tarjeta|debito)\b.{0,30}\b(?:precio|sale|cuesta|diferencia|igual)|\b(?:tarjeta|debito)\b.{0,30}\b(?:cupon|efectivo)\b.{0,30}\b(?:precio|sale|cuesta|diferencia|igual)/;
export const STOLEN_RE =
  /\b(?:me (?:la |lo )?robaron|robo total|robad[ao])\b.{0,80}\b(?:pag|cuota|seguir)|\b(?:pag|cuotas?|seguir)\b.{0,80}\b(?:robaron|robad[ao]|robo)\b/;
export const NO_PAYMENT_METHOD_RE =
  /\bsin (?:forma|medio) de pago\b|\bquedo sin (?:la )?tarjeta\b/;
export const RENEWAL_CHARGE_RE =
  /\bya (?:me )?(?:la |lo )?(?:debitaron|cobraron|descontaron|pague|la pague)\b|\b(?:cobraron|debitaron) dos veces\b|\bdoble (?:debito|cobro)\b|\botra vez\b|\bde nuevo\b/;

/**
 * What falls due on one date for a policy. Triunfo puts an endorsement (a
 * value raise, an added coverage) on the same due date as the installment, so
 * the amount due that day is their sum (John, 20/10: "70 + 10"). Cancelled
 * installments come as negative amounts that offset another one: a date that
 * adds up to nothing is not due.
 */
interface DueGroup {
  dueDate: string | null;
  numbers: number[];
  total: number;
  items: CuotaImpaga[];
}

function dueGroups(p: EstadoCuentaPoliza): DueGroup[] {
  const byDate = new Map<string, CuotaImpaga[]>();
  for (const c of p.unpaidInstallments) {
    const key = c.dueDate ? c.dueDate.slice(0, 10) : '';
    byDate.set(key, [...(byDate.get(key) ?? []), c]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, items]) => ({
      dueDate: items[0].dueDate,
      numbers: items.filter((c) => Number(c.amount) > 0).map((c) => c.number),
      total: items.reduce((sum, c) => sum + Number(c.amount), 0),
      items,
    }))
    .filter((g) => g.total > 0);
}

/** "cuota 3" or "cuotas 1 y 3". */
function cuotasLabel(numbers: number[]): string {
  return numbers.length === 1
    ? `cuota ${numbers[0]}`
    : `cuotas ${joinWithY(numbers.map(String))}`;
}

/** The account a customer can transfer an installment to (bot config). */
export interface TransferInfo {
  alias?: string;
  cbu?: string;
  holder?: string;
  bank?: string;
}

const hasTransfer = (t?: TransferInfo): t is TransferInfo =>
  !!(t?.alias || t?.cbu);

/** "Alias: x · CBU: y · Titular: z" as WhatsApp lines. */
export function transferLines(t: TransferInfo): string {
  return [
    t.alias ? `• Alias: *${t.alias}*` : '',
    t.cbu ? `• CBU: *${t.cbu}*` : '',
    t.holder ? `• Titular: ${t.holder}` : '',
    t.bank ? `• Banco: ${t.bank}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * How to pay, as John put it (20/10): Rapipago, Pago Fácil, Santa Fe
 * Servicios and Mercado Pago all need the coupon (its barcode) or Triunfo's
 * app; what works without it is a transfer.
 */
function payMethodsText(transfer?: TransferInfo): string {
  return (
    '📌 *Formas de pago:*\n' +
    '• Débito automático con tarjeta de crédito o débito, o con CBU: la cuota sale un 5 % menos que en efectivo.\n' +
    (hasTransfer(transfer)
      ? `• Transferencia, mandando el comprobante por acá:\n${transferLines(transfer)}\n`
      : '• Transferencia: la oficina te pasa los datos y aplica el pago con el comprobante.\n') +
    '• En efectivo con el cupón, en Rapipago, Pago Fácil o Santa Fe Servicios.\n' +
    '• Por Mercado Pago con el cupón, o desde la app de Triunfo.\n' +
    'Si necesitás el cupón, pedilo abajo en *Pedir cupón de pago*.'
  );
}

const CARD_VS_CASH_TEXT =
  '📌 Con débito automático (tarjeta de crédito, débito o CBU) la cuota sale un *5 % menos* que pagándola en efectivo con cupón. Si querés pasarte a débito automático, tocá *Cambiar forma de pago* abajo.';

const STOLEN_TEXT =
  '📌 Las cuotas las podés seguir pagando mes a mes. Si no, cuando la compañía te entregue el convenio con lo que te va a pagar por el vehículo, te descuentan las cuotas que quedaron pendientes.';

const NO_PAYMENT_METHOD_TEXT =
  '📌 *Sin forma de pago* quiere decir que la póliza quedó sin tarjeta ni cuenta para debitar (por ejemplo, porque el banco rechazó el débito o la tarjeta venció). Para seguir con débito automático hay que pasar una tarjeta de crédito o débito, o un CBU; si no, se paga en efectivo con cupón. Abajo podés *Cambiar forma de pago* o *Pedir cupón de pago*.';

/**
 * "¿Hasta cuándo puedo pagar?": until the installment's due date. The grace
 * the organization gives on its own is never told to the customer, who goes
 * by the due date (John, 20/10); nor is a debit day, which varies with the
 * card or account.
 */
function deadlineAnswer(polizas: EstadoCuentaPoliza[]): string {
  const now = Date.now();
  const lines: string[] = [];
  for (const p of polizas) {
    const [next] = dueGroups(p);
    if (!next?.dueDate) continue;
    const what = cuotasLabel(next.numbers);
    const when = fmtDate(next.dueDate);
    if (onDebit(p))
      lines.push(
        `• *${polizaLabel(p)}*: la ${what} (vence ${when}) se paga por débito automático: no tenés que hacer nada. Si el banco la rechaza, te avisamos.`,
      );
    else if (new Date(next.dueDate).getTime() < now)
      lines.push(
        `• *${polizaLabel(p)}*: la ${what} venció el ${when}: pagala cuanto antes. Abajo podés pedir el cupón o los datos para transferir.`,
      );
    else lines.push(`• *${polizaLabel(p)}*: la ${what} vence el ${when}.`);
  }
  return (
    '📌 *Hasta cuándo pagar:* hasta el vencimiento de la cuota.' +
    (lines.length
      ? `\n${lines.join('\n')}`
      : '\nNo tenés cuotas pendientes de pago.')
  );
}

/** A renewed policy whose first installment is still to be paid. */
const renewedFirst = (p: EstadoCuentaPoliza) =>
  /RENOVACION/i.test(p.lastMovement ?? '') &&
  p.unpaidInstallments.some((c) => c.number === 1);

function renewalAnswer(polizas: EstadoCuentaPoliza[]): string | null {
  const renewed = polizas.filter(renewedFirst);
  if (!renewed.length) return null;
  return renewed
    .map(
      (p) =>
        `📌 Tu *${polizaLabel(p)}* se renovó: la cuota 1 es la primera de la póliza nueva. Lo que se cobró antes era la última cuota de la póliza anterior.`,
    )
    .join('\n');
}

/**
 * The answer to what the customer asked about their payments, from the same
 * account status. Two questions the office was answering by hand: a debit that
 * didn't go through (a policy paid with a coupon has no debit) and an
 * installment that "doesn't show up" (it isn't billed yet). Null for anything
 * else, which the account status alone answers.
 */
export function paymentAnswer(
  polizas: EstadoCuentaPoliza[],
  question: string,
  transfer?: TransferInfo,
): string | null {
  if (polizas.length === 0) return null;
  const t = fold(question);
  if (DEBIT_FAILED_RE.test(t)) return debitAnswer(polizas);
  if (INSTALLMENT_MISSING_RE.test(t)) return missingAnswer(polizas);
  if (STOLEN_RE.test(t)) return STOLEN_TEXT;
  if (NO_PAYMENT_METHOD_RE.test(t)) return NO_PAYMENT_METHOD_TEXT;
  if (RENEWAL_CHARGE_RE.test(t)) {
    const renewal = renewalAnswer(polizas);
    if (renewal) return renewal;
  }
  if (PAY_DEADLINE_RE.test(t)) return deadlineAnswer(polizas);
  if (CARD_VS_CASH_RE.test(t)) return CARD_VS_CASH_TEXT;
  if (PAY_METHODS_RE.test(t) || /\btransfer/.test(t))
    return payMethodsText(transfer);
  return null;
}

/**
 * What a customer who asked for the coupon can do right away: transfer the
 * installment and send the receipt (John, 20/10: the coupon only serves to pay
 * at Rapipago, Pago Fácil, Santa Fe Servicios or Mercado Pago). An installment
 * the bank is still debiting is not offered: paying it too would pay twice,
 * and the office waits for the rejection (#140, #158) — unless the customer
 * says the debit failed. Null when there is nothing to offer.
 */
export function transferOffer(
  polizas: EstadoCuentaPoliza[],
  transfer: TransferInfo | undefined,
  debitFailed = false,
): string | null {
  if (!hasTransfer(transfer)) return null;
  const lines: string[] = [];
  const waiting: string[] = [];
  for (const p of polizas) {
    const [due] = dueGroups(p);
    if (!due) continue;
    if (!debitFailed && onDebit(p)) {
      waiting.push(polizaLabel(p));
      continue;
    }
    lines.push(
      `• *${polizaLabel(p)}*: ${cuotasLabel(due.numbers)}, ${fmtMoney(due.total)}${due.numbers.length > 1 ? ' en total' : ''} (vence ${fmtDate(due.dueDate)})`,
    );
  }
  if (!lines.length && !waiting.length) return null;
  const parts: string[] = [];
  if (lines.length)
    parts.push(
      `💸 Si querés pagarla ya, podés transferir:\n${lines.join('\n')}\n\n${transferLines(transfer)}\n\nCuando transfieras, mandame el comprobante por acá y la oficina lo aplica. Para pagar en Rapipago, Pago Fácil o Santa Fe Servicios, la oficina te manda el cupón en el horario de atención.`,
    );
  if (waiting.length)
    parts.push(
      `_La cuota de ${joinWithY(waiting.map((w) => `tu ${w}`))} se está debitando: si el banco la rechaza, la podés transferir y la oficina te avisa._`,
    );
  return parts.join('\n\n');
}

/**
 * Paid by automatic debit with no rejection on record: covered until a
 * rejection comes (John, 20/10), and the debit day depends on the card or
 * account (a Visa credit card debits on the 14th and the 24th). Nothing to
 * pay by hand, and paying it too would pay twice.
 */
const onDebit = (p: EstadoCuentaPoliza) =>
  paysByDebit(p) === true && !p.hasRejectedInstallments;

function joinWithY(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

function debitAnswer(polizas: EstadoCuentaPoliza[]): string {
  const lines = polizas.map((p) => {
    const label = `*${polizaLabel(p)}*`;
    const vencidas = p.unpaidInstallments.filter(isOverdue);
    const debit = paysByDebit(p);
    if (debit === null)
      return `• ${label}: no tengo registrada su forma de pago. ${vencidas.length ? 'Figura con cuotas vencidas: la oficina lo revisa con vos.' : 'Figura al día.'}`;
    if (debit === false) {
      const deuda = vencidas.length
        ? ` Tiene ${vencidas.length === 1 ? `la cuota ${vencidas[0].number} vencida` : `${vencidas.length} cuotas vencidas`} por ${fmtMoney(vencidas.reduce((sum, c) => sum + Number(c.amount), 0))}.`
        : '';
      return `• ${label}: no tiene débito automático, se paga con *cupón*. Por eso no se debitó.${deuda}`;
    }
    if (p.hasRejectedInstallments)
      return `• ${label}: el banco *rechazó el débito*. Se puede pagar con cupón o volver a adherir la tarjeta o la cuenta.`;
    if (p.unpaidInstallments.length)
      return `• ${label}: tiene débito automático y la cuota ${p.unpaidInstallments[0].number} figura sin debitar. Ya le avisé a la oficina para que lo revise con vos y te diga cómo pagarla (cupón o transferencia).`;
    return `• ${label}: tiene débito automático y figura al día.`;
  });
  const coupon = polizas.some(
    (p) => paysByDebit(p) === false || p.hasRejectedInstallments,
  );
  return (
    `📌 *Sobre el débito:*\n${lines.join('\n')}` +
    (coupon
      ? '\n\nSi querés, abajo podés pedir el *cupón* para pagarla o *cambiar la forma de pago* (tarjeta o CBU).'
      : '')
  );
}

function missingAnswer(polizas: EstadoCuentaPoliza[]): string {
  const lines = polizas.map((p) => {
    const label = `*${polizaLabel(p)}*`;
    const [first] = p.unpaidInstallments;
    if (first) {
      const how =
        paysByDebit(p) === true
          ? ' Se cobra por débito automático.'
          : ' Si no te aparece para pagar, pedí el *cupón* abajo y te lo manda la oficina.';
      const estado = inDebitProcess(p, first)
        ? 'en proceso de débito'
        : isOverdue(first)
          ? 'vencida'
          : 'pendiente';
      return `• ${label}: tenés la cuota ${first.number} ${estado} (vence ${fmtDate(first.dueDate)}).${how}`;
    }
    return p.nextDueDate
      ? `• ${label}: ya pagaste todas las cuotas emitidas. La próxima *todavía no se emitió*, por eso no te aparece: va a estar para pagar cerca del vencimiento (${fmtDate(p.nextDueDate)}).`
      : `• ${label}: no tenés cuotas pendientes de pago.`;
  });
  return `📌 *Sobre tu consulta:*\n${lines.join('\n')}`;
}

export function formatSiniestros(siniestros: SiniestroSummary[]): string {
  if (siniestros.length === 0) {
    // A claim the office or the company took is not in the bot (#119): "no
    // tenés denuncias" read as if it had been lost.
    return 'No veo denuncias hechas por este chat. Si la hiciste con la oficina o directamente con la compañía, tocá *Hablar con un asesor* y te dicen cómo va.';
  }

  const estados: Record<SiniestroSummary['status'], string> = {
    pending: '🟡 Pendiente de carga en la compañía',
    in_progress: '🔵 En proceso',
    resolved: '🟢 Resuelto',
  };

  const blocks = siniestros.map((s) => {
    const estado = estados[s.status] ?? s.status;
    const oficial = s.insurerClaimNumber
      ? `\n  N° oficial Triunfo: ${s.insurerClaimNumber}`
      : '\n  Aún sin número oficial (en carga).';
    return (
      `• *${s.type}* — ${fmtDate(s.occurredAt)}\n` +
      `  Estado: ${estado}${oficial}`
    );
  });

  return ['🛡️ *Tus siniestros*', ...blocks].join('\n\n');
}
