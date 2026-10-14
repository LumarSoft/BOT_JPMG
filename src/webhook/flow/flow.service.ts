import {
  IdentificationInterpreter,
  type IdentificationAction,
} from './identification-interpreter.service';
import { identificationFromText } from './identification';
import {
  IntentInterpreter,
  type OpeningIntent,
} from './intent-interpreter.service';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ApiService } from '../../api/api.service';
import type { PolizaSummary } from '../../api/api.types';
import type {
  FlowContext,
  FlowHandleResult,
  FlowResult,
  FlowState,
  FlowStep,
  OutgoingMessage,
  UserInput,
} from './flow.types';
import {
  advisorSameQuestion,
  ALL_POLIZAS_ID,
  claimPhotoAddedText,
  vehiclePhotoAddedText,
  clientMenu,
  CLIENT_MENU_OPTS,
  cotizarMenu,
  DEBIT_FAILED_RE,
  displayName,
  INSTALLMENT_MISSING_RE,
  OTHER_POLIZA_ID,
  otherPolizaPrompt,
  pagosMenu,
  paymentAnswer,
  phoneQuestion,
  COTIZAR_FIXED,
  COTIZAR_LABEL,
  COTIZAR_ONLINE,
  COTIZAR_PRODUCT_TYPE,
  docPicker,
  DOC_PREFIX,
  FIELD_OPT_PREFIX,
  fieldPrompt,
  fieldSelectPicker,
  formatDocumento,
  goodbyeText,
  formatEstadoCuenta,
  formatSiniestros,
  leadMenu,
  openingLine,
  OPT,
  PLAN_PREFIX,
  planDetails,
  planPicker,
  POLIZA_PREFIX,
  polizaLabel,
  polizaPicker,
  polizaMention,
  returningGreeting,
  ROOT_OPTS,
  siniestroConfirm,
  siniestroTypeMenu,
  stuckMenu,
  welcomeMenu,
  type WelcomeIntro,
} from './flow.messages';
import type {
  CatalogField,
  ProductCatalogItem,
  ProductPlanSummary,
} from '../../api/api.types';
import { attentionHoursOf } from '../constants/business';
import { recentHumanReply } from '../closers';
import { fold } from '../text';
import { SiniestroExtractor } from './siniestro-extractor.service';
import {
  SINIESTRO_DATOS_VACIOS,
  mergeDatos,
  pendientes,
  siniestroChecklist,
  siniestroDescripcion,
  siniestroFaltantes,
  type SiniestroCampo,
  type SiniestroDatos,
} from './siniestro-datos';

/**
 * Matches a message that is *only* a greeting ("hola", "buenas", "buen día"),
 * used to send the user back to the menu mid-session. Anchored so a greeting
 * with an actual request ("hola, quiero una denuncia") is NOT caught here and
 * still routes to its intent.
 */
const GREETING_RE =
  /^(?:hola+s?|holi+s?|ola+s?|hi+|hello|holis|buenas|buen(?:os|as)?\s*(?:d[ií]as?|tardes?|noches?)?|buen\s*d[ií]a|hey+|qu[eé]\s+tal|saludos)[\s!.,¡?]*$/i;

/** A quick double-send of the same greeting is usually a user tap/retry, not a
 * request for another copy of the menu. Keep this narrow: only standalone
 * greetings in menu states are suppressed, never ordinary repeated answers. */
const GREETING_DEBOUNCE_MS = 15_000;

/** Words of a bare quote request — anything else is vehicle data. */
const QUOTE_FILLER = new Set(
  (
    'hola buenas buen buenos dia dias tardes noches quiero queria quisiera ' +
    'necesito me gustaria cotizar cotizame cotizacion cotiza cotizo un una ' +
    'el la lo mi mis los las del de para por favor seguro seguros poliza ' +
    'auto autos coche vehiculo moto motos camioneta precio presupuesto ' +
    'cuanto sale cuesta que con tengo es gracias info informacion saber ' +
    'hacer sacar al y o'
  ).split(' '),
);

/**
 * Someone who talked to us this recently gets "¡Hola de nuevo!" instead of the
 * full introduction: a new session starts after minutes of silence, and the
 * same person was introduced to NICO three times in one afternoon.
 */
const RETURNING_WINDOW_MS = 12 * 60 * 60_000;

/**
 * An explicit request to talk to someone, at the start of the message ("asesor",
 * "quiero hablar con un asesor por la cuota"). Deliberately narrow: "quiero
 * denunciar un choque con una persona herida" is a claim, and anything less
 * explicit is left to the intent model. Folded text (see `fold`).
 */
const ADVISOR_RE =
  /^(?:hola[\s,.!]*)?(?:(?:un |una |el |la |al )?(?:asesor|asesora|representante|humano)\b|(?:quiero |queria |necesito |me gustaria |puedo )?(?:hablar|comunicarme|contactarme) con (?:un |una |el |la |al |alguien del |alguien de )?(?:asesor|asesora|representante|humano|persona|alguien|equipo|oficina)\b)/;

/** Only asking for a person, with nothing about what for. Folded text. */
const BARE_ADVISOR_RE =
  /^(?:hola[\s,.!]*)?¿?(?:quiero |queria |necesito )?(?:hablar con )?(?:un |una |el |al )?(?:asesor|asesora|representante|humano|persona)[\s.!?]*$/;

/** Command words that only make sense mid-chat, sent as a first message. Folded. */
const OPENING_COMMAND_RE =
  /^(?:menu|cancelar|cancela|volver|atras|finalizar|terminar|salir|chau|chao|adios)[\s.!]*$/;

/** A message that asks for a quote. Run against folded text (see `fold`). */
/**
 * Payment coupons ("cupón", "los cupones", "la cuponera"). Triunfo gives us no
 * way to fetch them, so they get their own path to the office instead of the
 * documents picker, which ended in "no tengo los documentos" every time.
 * Folded text.
 */
const CUPON_RE = /\bcupon(?:es|era|eras)?\b/;

/** Policy papers asked for together with the coupons. Folded text. */
/** A payment receipt being sent, or a payment that did not register. Folded. */
const PAYMENT_PROOF_RE =
  /\b(ya pague|(?:envio|adjunto|mando|paso|te (?:mando|paso|envio)|aca (?:esta|va|tenes)|este es|es) (?:el |un |mi )?comprobante|comprobante (?:de (?:la )?(?:pago|transferencia))|no (?:se )?(?:acredito|acredita) (?:mi |el )?pago)\b/;

/** Activity this recent means the same conversation is still going on. */
const MID_CONVERSATION_MS = 10 * 60_000;

/**
 * A person from the office wrote to this chat this recently: a customer coming
 * back about it the next morning ("¿ya está hecha la denuncia?") is following
 * that up, not starting over. A claim taken by hand one afternoon was asked
 * about at 9 the next day, and the bot answered "¿ya sos cliente?" and the DNI.
 */
const OFFICE_THREAD_MS = 72 * 60 * 60_000;

/**
 * Policies the bot can't see: accidentes personales and the nómina of drivers
 * or employees (mostly in SanCor), other insurers, clauses added for a third
 * party. Asked for "las pólizas de los choferes que tengo en nómina", the bot
 * listed the customer's trucks. Folded text.
 */
const OFFICE_ONLY_POLICY_RE =
  /\bnomina\b|\bchofer(?:es)?\b|\baccidentes? personal(?:es)?\b|\bsancor\b|\b(?:la|una|poliza de|seguro de) ap\b|\bclausula\b|\bsubrogacion\b|\bno repeticion\b/;

/** Titles of the client menu rows, which reach the flow as typed text too. */
const MENU_TITLES = new Set(
  (clientMenu() as Extract<OutgoingMessage, { kind: 'list' }>).rows.map((r) =>
    words(r.title),
  ),
);

function words(text: string): string {
  return fold(text)
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words of a message that only greets ("Hola buen día", "buenas, ¿cómo andás?"). */
const GREETING_WORDS = new Set(
  (
    'hola holas holis ola buen buenos buenas dia dias tarde tardes noche noches ' +
    'que tal como estas esta andas anda va todo bien saludos hey'
  ).split(' '),
);

/**
 * A greeting with nothing else in it. GREETING_RE takes one greeting; this
 * one takes them combined, which the model read as following up whatever the
 * office said last — and a "Hola buen día" reached the office as a request.
 */
function isGreetingOnly(text: string): boolean {
  const w = words(text).split(' ').filter(Boolean);
  return (
    w.length > 0 &&
    w.length <= 6 &&
    w.every((x) => GREETING_WORDS.has(x) || /^hola+$/.test(x))
  );
}

/**
 * The customer's own words when they asked something ("no me aparece la cuota
 * 4"), worth passing to the office as is. Null for a menu tap or a word or two.
 */
function questionOf(text: string | undefined): string | null {
  if (!text) return null;
  const w = words(text);
  if (!w || MENU_TITLES.has(w) || w.split(' ').length < 3) return null;
  return text.trim();
}

/** The identification data once "¿hablo con…?" is no longer the question. */
function withoutPhoneQuestion(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...data };
  delete rest.phoneConfirm;
  delete rest.fromGreeting;
  return rest;
}

const clip = (text: string, max = 300) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** A new incident being reported, as people say it. Folded text. */
const NEW_INCIDENT_RE =
  /\bnuev[ao]|\bdenunci|\breportar|\bregistr|\bquiero hacer|\bocurri|\btuve|\bchoc|\baccidente|\bme robaron|\brob(?:o|aron)\b|\bhurt|\bgranizo|\bincendi|\bse (?:quemo|prendio fuego)|\bme (?:rompieron|golpearon|pegaron)/;

const DOCS_TOO_RE = /\bpolizas?\b|\btarjeta\b|\bcertificado\b|\bdocumenta/;

/** Something in a request shaped like a DNI/CUIT (7+ digits, dots or dashes
 * allowed) or a plate — only then is it worth asking the model to read it. */
const MAYBE_IDENTIFICATION_RE =
  /\d(?:[ .-]?\d){6,}|\b[a-z]{2}[ -]?\d{3}[ -]?[a-z]{2}\b|\b[a-z]{3}[ -]?\d{3}\b|\b[a-z]\d{3}[a-z]{3}\b/i;

const NOT_FOUND_TEXT =
  'No encontré ningún cliente con ese dato. Verificá el DNI, CUIT o patente y mandámelo de nuevo, o escribí *asesor* si preferís que te contacten.';

/**
 * Steps where the customer is talking to the bot and may ask it to pass
 * something on to a person ("¿le podés decir a Milagros…?"). Guided steps
 * (claim details, photos, documents) are left alone so a name can't cut them.
 */
const PERSON_MENTION_STEPS = new Set<FlowStep>([
  'CLIENT_MENU',
  'LEAD_MENU',
  'IDENTIFY',
  'COTIZAR_TIPO',
  'LLM_FAQ',
  'LLM_COTIZACION',
  'ASESOR_MOTIVO',
]);

/** The office person a message names ("Hola Mili", "decile a Milagros"), if any. */
export function staffNamed(
  text: string,
  staffNames: string[],
  botName?: string | null,
): string | null {
  const t = fold(text);
  const bot = botName ? fold(botName).trim() : '';
  for (const name of staffNames) {
    const n = fold(name).trim();
    if (n.length < 3 || n === bot) continue;
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(t)) return name;
  }
  return null;
}

/**
 * Tells the customer the office person was alerted, inside the bot's own
 * reply: after the greeting's wave, as a short first line, or — when the model
 * answers — through the prompt so it says it in its own words.
 */
export function withStaffNotice(result: FlowResult, name: string): FlowResult {
  const notice = `Ya le avisé a ${name} que le escribiste`;
  const [first, ...rest] = result.messages;
  if (!first)
    return result.handoff
      ? { ...result, staffNotified: name }
      : { ...result, messages: [{ kind: 'text', body: `${notice} 🙌` }] };
  if (first.body.includes('👋'))
    return {
      ...result,
      messages: [
        { ...first, body: first.body.replace('👋', `👋 ${notice}.`) },
        ...rest,
      ],
    };
  return {
    ...result,
    messages: [{ kind: 'text', body: `${notice} 🙌` }, ...result.messages],
  };
}

const QUOTE_INTENT_RE =
  /\bcotiz|\bpresupuest|\basegurar\b|\bcuanto (sale|cuesta|me sale|vale|saldria)\b.*\b(seguro|asegur)|\bprecio.*\b(seguro|asegur)/;

/**
 * Brands that only make cars / only make motorcycles, so "quiero cotizar mi
 * gol trend… vw" is known to be a car without the word "auto". Brands that
 * make both (Honda, Suzuki) are left to the quote model.
 */
const CAR_BRAND_RE =
  /\b(chevrolet|chevy|ford|fiat|volkswagen|vw|renault|peugeot|citroen|toyota|nissan|jeep|kia|hyundai|chery|audi|bmw|mercedes|dodge|mitsubishi|subaru|volvo|alfa romeo|baic|jac|geely|byd|haval|great wall|lifan|iveco)\b/;
/** Brands that make both cars and motorcycles: a vehicle, type unknown. */
const DUAL_BRAND_RE = /\b(honda|suzuki)\b/;
/** A model year ("2010", "1998"): a strong sign the text describes a vehicle. */
const MODEL_YEAR_RE = /\b(19[5-9]\d|20[0-4]\d)\b/;

/** Steps inside a quote: re-tapping a quote category there starts over. */
const QUOTE_STEPS = new Set<FlowStep>([
  'LLM_COTIZACION',
  'COT_PLAN',
  'COT_LEAD_FIELDS',
  'COT_LEAD_NOMBRE',
  'COT_LEAD_TELEFONO',
]);

/** "Quiero empezar de nuevo", "reiniciar", "volver a empezar". */
const RESTART_QUOTE_RE =
  /\b(empezar|arrancar|comenzar|cotizar) (de nuevo|otra vez|de cero)\b|\bvolver a (empezar|arrancar|comenzar)\b|\breinicia(r|lo|la)?\b/;
const MOTO_BRAND_RE =
  /\b(motomel|gilera|zanella|corven|keller|mondial|guerrero|bajaj|kawasaki|ktm|benelli|harley|royal enfield|siam|appia|okinoi|kymco|sym|voge|cfmoto|rouser|yamaha)\b/;
const LAST_GREETING_TEXT = 'lastGreetingText';
const LAST_GREETING_AT = 'lastGreetingAt';
const MENU_STEPS = new Set<FlowStep>(['ROOT', 'CLIENT_MENU', 'LEAD_MENU']);

/**
 * Steps where the user is not in the middle of answering something, so a
 * deterministic off-topic refusal can't swallow real data. Everywhere else the
 * text is an answer (a picker, a capture step, or the quote conversation — whose
 * prompt already refuses off-topic requests without losing the collected data).
 * A real conversation lost its quote here: "2000 es el codigo postal" matched
 * the programming pattern "código" and was bounced to the main menu.
 */
const OPEN_STEPS = new Set<FlowStep>([
  'ROOT',
  'CLIENT_MENU',
  'LEAD_MENU',
  'LLM_FAQ',
]);

/** Synthetic selectionId the media handler feeds in when a photo was received,
 * so the deterministic claim-photo steps advance without the user typing. */
export const PHOTO_RECEIVED = '__photo_received__';

/** Claim photo steps → the `tipo` label stored on each attachment. */
export const SINIESTRO_PHOTO_TIPO: Partial<Record<FlowStep, string>> = {
  SINIESTRO_FOTO_TARJETA: 'tarjeta_verde',
  SINIESTRO_FOTO_CARNET: 'carnet',
  SINIESTRO_TERCERO_TARJETA: 'tarjeta_verde_tercero',
  SINIESTRO_TERCERO_CARNET: 'carnet_tercero',
  SINIESTRO_FOTO_DANIO: 'siniestro',
};

/** Take-out document steps → the `tipo` label stored on each lead attachment. */
export const LEAD_DOC_TIPO: Partial<Record<FlowStep, string>> = {
  COT_DOC_DNI_FRENTE: 'dni_frente',
  COT_DOC_DNI_DORSO: 'dni_dorso',
  // A photo sent instead of answering "¿es 0 km?" still belongs to the request.
  COT_DOC_CERO_KM: 'documento',
  COT_DOC_TARJETA_AZUL: 'tarjeta',
  COT_DOC_NO_RODAMIENTO: 'certificado_no_rodamiento',
  COT_DOC_FOTOS_VEHICULO: 'foto_vehiculo',
  COT_DOC_TARJETA_GNC: 'tarjeta_gnc',
};

/**
 * What the vehicle being taken out needs, as the office asks for it: DNI;
 * a used one its tarjeta verde o azul and photos of the vehicle, a 0 km (not
 * registered yet, so no tarjeta) the certificado de no rodamiento; with GNC,
 * the tarjeta de GNC. `zeroKm` undefined = unknown, asked after the DNI.
 */
export interface TakeOutDocs {
  zeroKm?: boolean;
  gnc?: boolean;
}

/** The take-out steps for a vehicle, in order. */
export function takeOutSteps(docs: TakeOutDocs): FlowStep[] {
  return [
    'COT_DOC_DNI_FRENTE',
    'COT_DOC_DNI_DORSO',
    ...(docs.zeroKm === undefined ? (['COT_DOC_CERO_KM'] as const) : []),
    ...(docs.zeroKm === true ? (['COT_DOC_NO_RODAMIENTO'] as const) : []),
    ...(docs.zeroKm === false
      ? (['COT_DOC_TARJETA_AZUL', 'COT_DOC_FOTOS_VEHICULO'] as const)
      : []),
    ...(docs.gnc ? (['COT_DOC_TARJETA_GNC'] as const) : []),
  ];
}

/** First prompt of the take-out documents, sent right after a coverage is chosen. */
export function takeOutDocsIntro(docs: TakeOutDocs): string {
  const items = [
    '• *DNI* (frente y dorso)',
    ...(docs.zeroKm === true ? ['• *Certificado de no rodamiento*'] : []),
    ...(docs.zeroKm === false
      ? ['• *Tarjeta verde o azul*', '• *Fotos del vehículo* (de los 4 lados)']
      : []),
    ...(docs.zeroKm === undefined
      ? [
          '• *Tarjeta verde o azul* y *fotos del vehículo* (si es 0 km, el *certificado de no rodamiento*)',
        ]
      : []),
    ...(docs.gnc ? ['• *Tarjeta de GNC*'] : []),
  ];
  return (
    `Para avanzar con la contratación necesito unas fotos 📸:\n${items.join('\n')}\n\n` +
    'Empecemos: mandame una foto del *frente de tu DNI*. (si no la tenés a mano, escribí *no la tengo*)'
  );
}

/**
 * Flow snapshot that opens the take-out documents for the lead the quote model
 * just created (see webhook.service). The lead id and what the vehicle needs
 * travel in the state so each photo lands on that lead; the declared audience is kept.
 */
export function takeOutDocsState(
  prev: FlowState | null,
  leadId: number,
  docs: TakeOutDocs = {},
): FlowState {
  return {
    step: 'COT_DOC_DNI_FRENTE',
    data: {
      leadId,
      ...(docs.zeroKm !== undefined ? { zeroKm: docs.zeroKm } : {}),
      ...(docs.gnc ? { gnc: true } : {}),
    },
    ...(prev?.audience ? { audience: prev.audience } : {}),
  };
}

/** Buttons of the "¿es 0 km?" take-out step. */
const CERO_KM_SI = 'cero_km_si';
const CERO_KM_NO = 'cero_km_no';

function ceroKmQuestion(): OutgoingMessage {
  return {
    kind: 'buttons',
    body: 'Perfecto. ¿El vehículo es *0 km*?',
    buttons: [
      { id: CERO_KM_SI, title: 'Sí, es 0 km' },
      { id: CERO_KM_NO, title: 'No, es usado' },
    ],
  };
}

/** What a take-out step asks for; `last` words it as the final document. */
function takeOutPrompt(step: FlowStep, last: boolean): OutgoingMessage {
  const lead = last ? 'Por último, ' : 'Ahora ';
  switch (step) {
    case 'COT_DOC_DNI_DORSO':
      return {
        kind: 'text',
        body: 'Perfecto. Ahora el *dorso del DNI*. (si no la tenés, escribí *no la tengo*)',
      };
    case 'COT_DOC_CERO_KM':
      return ceroKmQuestion();
    case 'COT_DOC_TARJETA_AZUL':
      return {
        kind: 'text',
        body: `${lead}una foto de la *tarjeta verde o azul* del vehículo. (si no la tenés, escribí *no la tengo*)`,
      };
    case 'COT_DOC_NO_RODAMIENTO':
      return {
        kind: 'text',
        body: `${lead}una foto del *certificado de no rodamiento*. (si no lo tenés, escribí *no lo tengo*)`,
      };
    case 'COT_DOC_FOTOS_VEHICULO':
      return {
        kind: 'text',
        body: `${lead}unas *fotos del vehículo* de los 4 lados (adelante, atrás y los dos costados). Mandalas y cuando termines escribí *listo*.`,
      };
    case 'COT_DOC_TARJETA_GNC':
      return {
        kind: 'text',
        body: `${lead}una foto de la *tarjeta de GNC*. (si no la tenés, escribí *no la tengo*)`,
      };
    default:
      return {
        kind: 'text',
        body: 'Mandame la foto 📷, o escribí *no la tengo* para saltar este paso.',
      };
  }
}

/** Buttons for the "¿hubo un tercero?" step. */
const TERCERO_SI = 'sin_tercero_si';
const TERCERO_NO = 'sin_tercero_no';

/**
 * How many times a step may re-ask before offering a way out. Every step here is
 * deliberately closed to the LLM, so an answer it can't read is re-asked
 * forever — one real conversation sent the same plan picker three times in a row
 * while the client kept asking for a monopatín. At the second miss we stop
 * insisting and offer the menu or a human instead.
 */
const MAX_RETRIES = 2;

/** Slot holding the per-step retry counter inside `FlowState.data`. */
const RETRIES = 'retries';

/** Formats a Date as YYYY-MM-DD in local time (what the API expects). */
function localISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Parses a user-typed incident date. Accepts DD/MM/AAAA, DD-MM-AAAA,
 * AAAA-MM-DD and the words "hoy"/"ayer". Returns null when it can't be read.
 */
function parseFecha(text: string): { iso: string; display: string } | null {
  const t = text.trim().toLowerCase();

  const fromDate = (d: Date) => ({
    iso: localISODate(d),
    display: d.toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }),
  });

  // Accept the keywords anywhere in a longer sentence ("me choqué hoy a la
  // mañana"), not only as the entire message — users rarely send just "hoy".
  if (/\bhoy\b/.test(t)) return fromDate(new Date());
  // Before "ayer": "antes de ayer" contains it, and a real claim was filed a
  // day late because the shorter word matched first.
  if (/\b(anteayer|antes de ayer|antier)\b/.test(t)) {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    return fromDate(d);
  }
  if (/\bayer\b/.test(t)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return fromDate(d);
  }

  // Find a date embedded anywhere in the text. ISO (YYYY-MM-DD) is checked first
  // so it isn't mis-read as DD-MM-YY by the looser day-first pattern.
  let y: number, mo: number, day: number;
  const ymd = t.match(/(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  const dmy = t.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (ymd) {
    y = Number(ymd[1]);
    mo = Number(ymd[2]);
    day = Number(ymd[3]);
  } else if (dmy) {
    day = Number(dmy[1]);
    mo = Number(dmy[2]);
    y = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
  } else {
    return null;
  }

  if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  const d = new Date(y, mo - 1, day);
  if (
    d.getFullYear() !== y ||
    d.getMonth() !== mo - 1 ||
    d.getDate() !== day ||
    d.getTime() > Date.now()
  ) {
    return null; // invalid calendar date or in the future
  }
  return fromDate(d);
}

/**
 * Actions that require an identified client; resumed after IDENTIFY succeeds.
 * 'menu' is the identification asked right after "Sí, soy cliente".
 */
type ClientAction =
  | 'menu'
  | 'pagos'
  | 'documentos'
  | 'cupones'
  | 'siniestro_nueva'
  | 'siniestro_consultar'
  | 'baja_poliza';

/** Extra details of the request that started a client action. */
interface ActionOptions {
  /** Coupons asked for together with the policy papers ("cupón y póliza"). */
  withDocs?: boolean;
  /** What the customer wrote to ask for it, answered along with the data. */
  question?: string;
}

/**
 * Conversation state machine for transactional flows. The model interprets
 * natural language identification and claim details; validation, client lookup
 * and actions remain explicit. LLM_* steps handle quotations and free text.
 */
@Injectable()
export class FlowService {
  private readonly logger = new Logger(FlowService.name);
  private readonly states = new Map<string, { state: FlowState }>();

  private readonly towTruckPhone?: string;

  constructor(
    private readonly api: ApiService,
    config: ConfigService,
    private readonly extractor: SiniestroExtractor,
    private readonly identification: IdentificationInterpreter,
    private readonly intents: IntentInterpreter,
  ) {
    this.towTruckPhone = config.get<string>('TOW_TRUCK_PHONE')?.trim();
  }

  /** Drops a conversation's flow state (used by /reset). */
  reset(key: string): void {
    this.states.delete(key);
  }

  async handle(
    key: string,
    input: UserInput,
    ctx: FlowContext,
  ): Promise<FlowHandleResult> {
    // Rehydrate the scratchpad from the durable snapshot the API loaded (the
    // source of truth), then run the turn and return the new snapshot to persist.
    this.hydrate(key, ctx);
    const result = await this.compute(key, input, ctx);
    const entry = this.states.get(key);
    const state = entry ? entry.state : null;
    // The map is per-turn only; the next message rehydrates from the API.
    this.states.delete(key);
    return { ...result, state };
  }

  /** Loads the persisted snapshot into the scratchpad, or clears it on a fresh start. */
  private hydrate(key: string, ctx: FlowContext): void {
    if (ctx.newSession || !ctx.flowState) {
      this.states.delete(key);
      return;
    }
    this.states.set(key, { state: ctx.flowState });
  }

  private async compute(
    key: string,
    input: UserInput,
    ctx: FlowContext,
  ): Promise<FlowResult> {
    // A message to an office person by name ("Hola Mili, ¿cómo estás?") alerts
    // her, and the bot still works out what the customer needs: handing the
    // chat over would leave every such conversation to the office.
    const prior = this.load(key)?.state;
    const officeThread =
      prior?.officeThread === true || this.answeringOffice(ctx);
    ctx = { ...ctx, officeThread };
    const named = await this.notifyStaff(input, ctx, prior);
    const result = await this.computeTurn(key, input, ctx);
    // Remembered for the session: the API stops reporting that person's reply
    // as soon as the bot answers.
    const entry = this.states.get(key);
    if (officeThread && entry)
      entry.state = { ...entry.state, officeThread: true };
    return named ? withStaffNotice(result, named) : result;
  }

  private async computeTurn(
    key: string,
    input: UserInput,
    ctx: FlowContext,
  ): Promise<FlowResult> {
    const existing = this.load(key);
    const sel = input.selectionId;
    // Payment proofs and missing credits need human review. Policy cancellations
    // keep the dedicated identification, policy selection and confirmation flow.
    // "Es el comprobante de pago" (after a photo) used to open the account
    // status instead: the office has to register the payment.
    if (!sel && PAYMENT_PROOF_RE.test(fold(input.text))) {
      return this.handleAsesorMotivo(input, ctx, key);
    }

    // First contact (no state): answer what the message asks when it asks
    // something, and greet with the menu when it is only a greeting. Inside
    // the same safety net as every other step: the routing can reach the API
    // (identification, policies, account status), and an error there used to
    // leave the customer with no reply at all.
    if (!existing) {
      try {
        return await this.firstContact(input, ctx, key);
      } catch (error) {
        this.logger.error(`Flow error (primer mensaje): ${this.errMsg(error)}`);
        return this.failureReply();
      }
    }

    // Global escape hatch: "menú" / the back option returns to the main menu.
    if (sel === OPT.menu || /^men[uú]$/i.test(input.text.trim())) {
      return this.toMainMenu(key, ctx);
    }

    // Re-tapping a quote category (the old "Auto" button is still on screen)
    // or asking to start over restarts the quote. Before, the tap just reached
    // the quote model as the word "Auto" and it carried on with the previous
    // brand, model and year.
    if (QUOTE_STEPS.has(existing.state.step)) {
      const restart = this.quoteRestartOption(existing.state, input);
      if (restart !== undefined)
        return this.restartCotizacion(restart, ctx, key);
    }

    // The escape offered after a step failed to understand the user twice.
    if (sel === OPT.stuckMenu) {
      return this.toMainMenu(key, ctx);
    }
    if (sel === OPT.stuckAsesor) {
      await this.api.requestHandoff(ctx.conversationId).catch(() => undefined);
      this.setState(
        key,
        existing.state.audience === 'lead' ? 'LEAD_MENU' : 'CLIENT_MENU',
      );
      return {
        messages: [
          {
            kind: 'text',
            body:
              `Listo, tomé nota ✍️. Un asesor te va a contactar a la brevedad (${attentionHoursOf(ctx.attentionHours)}).` +
              (await this.closedNote()),
          },
          existing.state.audience === 'lead' ? leadMenu() : clientMenu(),
        ],
      };
    }

    // Second escape hatch: "cancelar" / "volver". Pickers and capture steps
    // deliberately never leak to the LLM, so without this the only way out is
    // the literal word "menú" — a user who writes "cancelar" stays trapped.
    // SINIESTRO_CONFIRM owns "cancelar" as one of its buttons and handles it
    // itself (it also confirms the denuncia was dropped), so it's excluded.
    if (
      existing.state.step !== 'SINIESTRO_CONFIRM' &&
      existing.state.step !== 'BAJA_CONFIRM' &&
      (sel === OPT.cancelar ||
        /^(cancelar|cancelá|volver|atr[aá]s|olvidalo|dejalo)$/i.test(
          input.text.trim(),
        ))
    ) {
      return this.prepend('Listo, lo dejamos acá.', this.toMainMenu(key, ctx));
    }

    // A standalone greeting mid-session means "take me back to the menu", not a
    // FAQ chat — deterministic and free, and honoring the declared audience.
    // A repeated copy sent within a few seconds while the menu is already open
    // is recorded by the webhook but intentionally receives no second reply.
    // Skipped for taps (selectionId) since those are never typed greetings.
    if (!sel && GREETING_RE.test(input.text.trim())) {
      if (this.isRepeatedGreeting(existing.state, input.text)) {
        this.logger.log('Saludo repetido en menú ignorado');
        return { messages: [] };
      }
      return this.rememberGreeting(
        key,
        input.text,
        this.toMainMenu(key, ctx),
        true,
      );
    }

    // Global "finalizar" command: end the chat from anywhere (button tap sends
    // the title "Finalizar", caught by the same text check). Clears the flow
    // state and resets the API session so the next message starts fresh.
    if (
      sel === OPT.finalizar ||
      /^(finalizar|terminar|salir|chau|chao|adi[oó]s)$/i.test(input.text.trim())
    ) {
      this.states.delete(key);
      await this.api.resetSession(ctx.conversationId).catch(() => undefined);
      return { messages: [{ kind: 'text', body: goodbyeText() }] };
    }

    // Hours questions are answered deterministically from the configured schedule
    // (no LLM, no cost), at any step — except while we're capturing typed data,
    // where the words could be part of the user's answer.
    if (
      !sel &&
      this.isHoursQuestion(input.text) &&
      !this.isCapturingData(existing.state.step)
    ) {
      return this.answerHours();
    }

    // Hard topic guard (deterministic, NO LLM): if the user clearly asks about
    // something off-domain (programming, math, recipes, general chatter), we
    // refuse and steer back to the menu BEFORE any model call. This is the
    // bulletproof "no te vayas por las ramas" — it never reaches the LLM. Only
    // on open steps: mid-flow, the text is the user's answer (see OPEN_STEPS).
    if (
      !sel &&
      OPEN_STEPS.has(existing.state.step) &&
      this.isOffTopic(input.text)
    ) {
      return this.offTopicReply(key, ctx);
    }

    try {
      // Sticky LLM sub-flows (cotización / FAQ free-text) keep routing every
      // message to the model until the user changes topic. A message that
      // clearly names a *different* flow must break out and re-enter the
      // deterministic menu instead of being answered by the wrong prompt
      // (e.g. asking for the grúa once the cotización is done).
      const switched = this.detectFlowSwitch(
        existing.state.step,
        input,
        ctx,
        key,
      );
      if (switched) return await switched;

      return await this.route(existing.state, input, ctx, key);
    } catch (error) {
      this.logger.error(
        `Flow error (${existing.state.step}): ${this.errMsg(error)}`,
      );
      return this.failureReply();
    }
  }

  /** The first message of a session (no flow state yet). */
  private async firstContact(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const sel = input.selectionId;
    // A greeting, or a command word ("menú", "cancelar", "volver") left over from
    // an expired session, gets the welcome as before — never the model, which
    // could read "cancelar" as cancelling a policy.
    const bareGreeting =
      !sel &&
      (GREETING_RE.test(input.text.trim()) ||
        isGreetingOnly(input.text) ||
        OPENING_COMMAND_RE.test(fold(input.text).trim()));
    // The customer is answering a person from the office: no introduction.
    const personRecently = ctx.answeringPerson === true;
    if (ctx.client) {
      const hello = returningGreeting(ctx.client.firstName);
      this.setState(key, 'CLIENT_MENU', {}, 'client');
      // The message that reopened the chat must not be lost. The old menu is
      // still on the user's screen after a session expires, so a returning
      // client taps "Pagos" and used to get only the greeting + the menu
      // again. A tap names a menu option; typed text is read by the model
      // (keywords sent "¿mi póliza cubre cristales?" to Documentación) and
      // only falls back to the keywords when the model is unavailable.
      // Stale ids from a picker (plan_/pol_) aren't menu options, so they
      // correctly fall through to the menu.
      if (!sel && !bareGreeting) {
        const routed = await this.routeOpening(
          input,
          ctx,
          key,
          personRecently ? null : hello,
        );
        if (routed) return routed;
      }
      const opt = sel ?? this.matchClientIntent(input.text);
      if (opt && CLIENT_MENU_OPTS.has(opt)) {
        return this.prepend(
          hello,
          await this.handleClientMenu({ ...input, selectionId: opt }, ctx, key),
        );
      }
      return this.rememberGreeting(
        key,
        input.text,
        { messages: [{ kind: 'text', body: hello }, clientMenu()] },
        bareGreeting,
      );
    }
    this.setState(key, 'ROOT');
    // Same for someone we can't identify: a tap on "Sí, soy cliente" /
    // "Todavía no" still routes instead of being answered with the very
    // question it just answered.
    if (sel && ROOT_OPTS.has(sel)) {
      return this.handleRoot(input, ctx, key);
    }
    const intro: WelcomeIntro = personRecently
      ? 'returning'
      : this.introFor(ctx);
    // Right after our own reply (a loose photo is answered without a flow
    // state) this is the same conversation: no "¡Hola de nuevo!".
    const opener =
      personRecently || this.repliedMomentsAgo(ctx)
        ? null
        : openingLine(intro, ctx.botName);
    // The very first message already asks for a quote ("hola, quiero cotizar
    // mi auto"): a quote doesn't need "¿ya sos cliente?", and every extra
    // round-trip is one more billed message and one more wait. Introduce
    // ourselves in the same message — or let the quote model do it when it
    // answers directly (its prompt introduces itself on a first message).
    if (!sel && QUOTE_INTENT_RE.test(fold(input.text))) {
      const result = await this.enterCotizar(input, ctx, key);
      return result.handoff ? result : this.withOpener(opener, result);
    }
    // A cancellation is a client's request, like the ones routeOpening reads.
    if (this.matchClientIntent(input.text) === OPT.bajaPoliza)
      return this.withOpener(
        opener,
        await this.guardAsClient(ctx, key, 'baja_poliza', {}, input.text),
      );
    if (!sel && ADVISOR_RE.test(fold(input.text).trim()))
      return this.withOpener(
        opener,
        await this.advisorRequest(input, ctx, key),
      );
    // Anything with content — a question, an audio, a request — is answered
    // instead of met with "¿ya sos cliente?". Most first messages are not a
    // bare "hola", and the menu ignored what they said.
    if (!sel && !bareGreeting) {
      const routed = await this.routeOpening(input, ctx, key, opener);
      if (routed) return routed;
    }
    // Only a greeting is left here (anything else was routed above). Someone
    // the office was attending in the last days: "¿ya sos cliente?" read as if
    // nobody knew them.
    if (!sel && ctx.officeThread && !personRecently) {
      this.setState(key, 'ROOT', { officeGreeted: true });
      return this.rememberGreeting(
        key,
        input.text,
        {
          messages: [
            {
              kind: 'text',
              body: '¡Hola! 👋 Contame en qué te ayudo. Si es por lo que venías hablando con la oficina, decime y le aviso.',
            },
          ],
        },
        bareGreeting,
      );
    }
    // A client's own number: "¿hablo con Juan?" instead of "¿ya sos cliente?"
    // and the DNI after it.
    if (!sel) {
      const asked = this.askPhoneMatch(
        ctx,
        key,
        'menu',
        { fromGreeting: true },
        opener,
      );
      if (asked) return asked;
    }
    return this.rememberGreeting(
      key,
      input.text,
      { messages: [welcomeMenu(undefined, ctx.botName, intro)] },
      bareGreeting,
    );
  }

  // ─── Router ───────────────────────────────────────────────

  private route(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> | FlowResult {
    switch (state.step) {
      case 'ROOT':
        return this.handleRoot(input, ctx, key);
      case 'CLIENT_MENU':
        return this.handleClientMenu(input, ctx, key);
      case 'LEAD_MENU':
        return this.handleLeadMenu(input, ctx, key);
      case 'IDENTIFY':
        return this.handleIdentify(state, input, ctx, key);
      case 'BAJA_POLIZA':
        return this.handleBajaPoliza(state, input, key);
      case 'BAJA_CONFIRM':
        return this.handleBajaConfirm(state, input, ctx, key);
      case 'SINIESTRO_TYPE':
        return this.handleSiniestroType(state, input, ctx, key);
      case 'SINIESTRO_POLIZA':
        return this.handleSiniestroPoliza(state, input, ctx, key);
      case 'SINIESTRO_DATOS':
        return this.handleSiniestroDatos(state, input, ctx, key);
      case 'SINIESTRO_FECHA':
        return this.handleSiniestroFecha(state, input, key);
      case 'SINIESTRO_DESC':
        return this.handleSiniestroDesc(state, input, key);
      case 'SINIESTRO_HORA':
      case 'SINIESTRO_LOCALIDAD':
      case 'SINIESTRO_CALLE':
      case 'SINIESTRO_ALTURA':
        return this.handleSiniestroDetalle(state, input, key);
      case 'SINIESTRO_CONFIRM':
        return this.handleSiniestroConfirm(state, input, ctx, key);
      case 'SINIESTRO_FOTO_TARJETA':
        return this.handleSinFotoTarjeta(input, key);
      case 'SINIESTRO_FOTO_CARNET':
        return this.handleSinFotoCarnet(input, key);
      case 'SINIESTRO_TERCERO':
        return this.handleSinTercero(state, input, key);
      case 'SINIESTRO_TERCERO_TARJETA':
        return this.handleSinTerceroTarjeta(input, key);
      case 'SINIESTRO_TERCERO_CARNET':
        return this.handleSinTerceroCarnet(input, key);
      case 'SINIESTRO_FOTO_DANIO':
        return this.handleSinFotoDanio(input, key);
      case 'DOC_POLIZA':
        return this.handleDocPoliza(state, input, ctx, key);
      case 'DOC_TYPE':
        return this.handleDocType(state, input, key);
      case 'CUPON_POLIZA':
        return this.handleCuponPoliza(state, input, ctx, key);
      case 'ASESOR_MOTIVO':
        return this.handleAsesorMotivo(input, ctx, key);
      case 'LEAD_CONTACT':
        return this.handleLeadContact(input, ctx, key);
      case 'COTIZAR_TIPO':
        return this.handleCotizarTipo(input, ctx, key);
      case 'COT_PLAN':
        return this.handleCotPlan(state, input, ctx, key);
      case 'COT_LEAD_FIELDS':
        return this.handleCotLeadFields(state, input, key);
      case 'COT_LEAD_NOMBRE':
        return this.handleCotLeadNombre(state, input, key);
      case 'COT_LEAD_TELEFONO':
        return this.handleCotLeadTelefono(state, input, ctx, key);
      case 'LLM_COTIZACION':
        return this.handleLlm(input, key, 'cotizacion');
      case 'COT_DOC_DNI_FRENTE':
      case 'COT_DOC_DNI_DORSO':
      case 'COT_DOC_TARJETA_AZUL':
      case 'COT_DOC_NO_RODAMIENTO':
      case 'COT_DOC_TARJETA_GNC':
        return this.handleTakeOutDoc(state, input, ctx, key);
      case 'COT_DOC_CERO_KM':
        return this.handleTakeOutCeroKm(state, input, ctx, key);
      case 'COT_DOC_FOTOS_VEHICULO':
        return this.handleTakeOutVehiclePhotos(state, input, ctx, key);
      case 'LLM_FAQ':
        return this.handleLlm(input, key, 'faq');
      default:
        return this.toMainMenu(key, ctx);
    }
  }

  // ─── Root / menus ─────────────────────────────────────────

  private async handleRoot(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const t = input.text.toLowerCase();
    const sel = input.selectionId;

    // ── 1. Client / non-client identification ────────────────
    const isClient =
      sel === OPT.cliente ||
      ((/\b(soy|ya soy|s[ií] soy)\b/.test(t) ||
        /\b(tengo|tenemos)\b.*\b(p[oó]liza|seguro|cobertura)\b/.test(t)) &&
        !/\bno\b/.test(t)) ||
      (/\bcliente\b/.test(t) && !/\bno\b/.test(t));

    const isLead =
      sel === OPT.noCliente ||
      /^(no|todav[ií]a no|a[uú]n no|recién|recien)\b/.test(t) ||
      /\bno\b.*\bcliente\b/.test(t);

    if (isClient) {
      if (ctx.client) {
        this.setState(key, 'CLIENT_MENU', {}, 'client');
        return { messages: [clientMenu()] };
      }
      // Identify up front instead of on the first action that needs it, so every
      // request (an advisor handoff included) reaches the admin tied to the
      // client and its producer code.
      this.setState(key, 'ROOT', {}, 'client');
      const asked = this.askPhoneMatch(ctx, key, 'menu');
      if (asked) return asked;
      this.setState(key, 'IDENTIFY', { pendingAction: 'menu' }, 'client');
      return {
        messages: [
          {
            kind: 'text',
            body: '¡Genial! Para ayudarte necesito identificarte. Pasame el *DNI del titular* (o el *CUIT* si es una empresa) o la *patente* del vehículo asegurado.\n\n_Escribí *menú* para volver o *finalizar* para terminar._',
          },
        ],
      };
    }
    if (isLead) {
      this.setState(key, 'LEAD_MENU', {}, 'lead');
      return { messages: [leadMenu()] };
    }

    // ── 2. Direct intent routing (before asking client/non-client) ──
    // Cotizar doesn't need identification → go straight to the quote flow
    // (jumping to the named category when the message already specifies one).
    if (
      QUOTE_INTENT_RE.test(fold(input.text)) ||
      /\bcotiz|\bpresupuest|\bcu[aá]nto.*seguro|\bprecio.*seguro/.test(t)
    ) {
      return this.enterCotizar(input, ctx, key);
    }

    if (
      /\b(baja|darme de baja|cancelar (mi|el) seguro|cancelar (mi|la) poliza)\b/.test(
        fold(input.text),
      )
    )
      return this.guard(ctx, key, 'baja_poliza', {}, input.text);

    // "Asesor" is what the bot itself tells people to write; here it used to
    // reach the FAQ model, which answered "escribí menú y elegí Cotización".
    if (ADVISOR_RE.test(fold(input.text).trim()))
      return this.advisorRequest(input, ctx, key);

    // ── 3. Read what they want and go there, without asking again ──
    // Typed text only: a tap on a stale button ("CITROEN BERLINGO" from an old
    // policy list) is not a request to interpret.
    if (!sel) {
      const routed = await this.routeOpening(input, ctx, key, null);
      if (routed) return routed;
    }

    // Model unavailable: client-scoped words still get the question, but
    // without introducing the bot a second time.
    if (
      /\bsiniestro|\bdenuncia|\baccidente|\bchoque|\brob|\bp[oó]liza|\bpago|\bcuota|\bdocument|\btarjeta|\bgr[uú]a|\bauxilio|\bcobertura/.test(
        t,
      )
    ) {
      return {
        messages: [
          {
            kind: 'text',
            body: 'Claro, con gusto te ayudo.',
          },
          welcomeMenu(undefined, ctx.botName, 'none'),
        ],
      };
    }

    // ── 4. Last resort: LLM responds naturally (state stays ROOT) ──
    return { messages: [], handoff: 'faq' };
  }

  /**
   * How the welcome introduces the bot on a first message: in full the first
   * time, "¡Hola de nuevo!" for someone who talked to us in the last hours.
   */
  private repliedMomentsAgo(ctx: FlowContext): boolean {
    const last = ctx.previousActivityAt
      ? Date.parse(ctx.previousActivityAt)
      : NaN;
    return Number.isFinite(last) && Date.now() - last <= MID_CONVERSATION_MS;
  }

  private introFor(ctx: FlowContext): WelcomeIntro {
    const last = ctx.previousActivityAt
      ? Date.parse(ctx.previousActivityAt)
      : NaN;
    return Number.isFinite(last) && Date.now() - last <= RETURNING_WINDOW_MS
      ? 'returning'
      : 'full';
  }

  private failureReply(): FlowResult {
    return {
      messages: [
        {
          kind: 'text',
          body:
            'Tuvimos un inconveniente procesando tu pedido. ' +
            'Probá de nuevo en un momento o escribí *asesor* para que te contacte alguien del equipo.',
        },
      ],
    };
  }

  private withOpener(opener: string | null, result: FlowResult): FlowResult {
    return opener ? this.prepend(opener, result) : result;
  }

  /** The model's reading of a message, or null when it can't be had. */
  private async readIntent(
    input: UserInput,
    ctx: FlowContext,
  ): Promise<OpeningIntent | null> {
    if (ctx.llmEnabled === false || ctx.llmRateLimited || !ctx.phoneNumberId)
      return null;
    // The office's last line only helps when the customer is answering it; a
    // reply to the bot's own question must not be read as a follow-up.
    const reply =
      (ctx.answeringPerson || ctx.officeThread) && ctx.lastHumanReply
        ? {
            content: ctx.lastHumanReply.content,
            minutesAgo: Math.round(
              (Date.now() - Date.parse(ctx.lastHumanReply.createdAt)) / 60_000,
            ),
          }
        : null;
    try {
      const intent = await this.intents.interpret({
        text: input.text,
        phoneNumberId: ctx.phoneNumberId,
        identifiedClient: !!ctx.client,
        lastHumanReply: reply,
      });
      this.logger.log(`Mensaje interpretado como "${intent}"`);
      return intent;
    } catch (error) {
      this.logger.warn(
        `No se pudo interpretar el mensaje: ${this.errMsg(error)}`,
      );
      return null;
    }
  }

  /**
   * Takes a message that says what it wants straight to it — with `opener`
   * ("¡Hola! Soy NICO…") in front when this is the first reply. Returns null
   * for a plain greeting or when the model can't read it, so the caller shows
   * its menu as before. A request for one's own policy, payments or a claim
   * implies being a client, so those skip "¿ya sos cliente?" and go straight
   * to identification.
   */
  private async routeOpening(
    input: UserInput,
    ctx: FlowContext,
    key: string,
    opener: string | null,
  ): Promise<FlowResult | null> {
    if (isGreetingOnly(input.text)) return null;
    const intent = await this.readIntent(input, ctx);
    if (
      intent &&
      !['saludo', 'cotizar', 'siniestro', 'grua'].includes(intent) &&
      OFFICE_ONLY_POLICY_RE.test(fold(input.text))
    )
      return this.withOpener(
        opener,
        await this.officeOnlyRequest(input.text, ctx, key),
      );
    switch (intent) {
      case null:
      case 'saludo':
        return null;
      case 'cotizar': {
        const result = await this.enterCotizar(input, ctx, key);
        return result.handoff ? result : this.withOpener(opener, result);
      }
      case 'siniestro': {
        // "Me chocaron" already says it is a new claim: asking "¿denuncia
        // nueva o consultar?" only adds a step.
        const opt = this.matchSiniestroIntent(input.text);
        if (opt)
          return this.withOpener(
            opener,
            await this.guardAsClient(
              ctx,
              key,
              opt === OPT.sinNueva ? 'siniestro_nueva' : 'siniestro_consultar',
              {},
              input.text,
            ),
          );
        this.setState(key, 'SINIESTRO_TYPE', {}, 'client');
        return this.withOpener(opener, { messages: [siniestroTypeMenu()] });
      }
      case 'documentos':
      case 'pagos': {
        // The model files coupons under documentos or pagos; neither path can
        // deliver them. A debit that didn't go through or an installment that
        // "doesn't show up" is answered from the account status, even when
        // the message says "factura" or "cupón".
        const t = fold(input.text);
        const action: ClientAction =
          DEBIT_FAILED_RE.test(t) || INSTALLMENT_MISSING_RE.test(t)
            ? 'pagos'
            : CUPON_RE.test(t)
              ? 'cupones'
              : intent;
        return this.withOpener(
          opener,
          await this.guardAsClient(
            ctx,
            key,
            action,
            { withDocs: DOCS_TOO_RE.test(t) },
            input.text,
          ),
        );
      }
      case 'baja':
        return this.withOpener(
          opener,
          await this.guardAsClient(ctx, key, 'baja_poliza', {}, input.text),
        );
      case 'grua':
        return this.withOpener(opener, {
          messages: [{ kind: 'text', body: this.gruaText() }],
        });
      case 'asesor':
        return this.withOpener(
          opener,
          await this.advisorRequest(input, ctx, key),
        );
      case 'consulta':
        // The FAQ model answers it and introduces itself on a first message.
        return { messages: [], handoff: 'faq' };
      case 'seguimiento':
        return (
          (await this.personFollowUp(input, ctx, key)) ?? {
            messages: [],
            handoff: 'faq',
          }
        );
    }
  }

  /**
   * Alerts the office person a message names (Producer.staffNames) with a
   * pending matter in the inbox. Returns her name so the reply can say so, or
   * null. Left alone inside guided steps (a claim's details, photos) and when
   * a person of the office is already answering this chat.
   */
  private async notifyStaff(
    input: UserInput,
    ctx: FlowContext,
    state: FlowState | undefined,
  ): Promise<string | null> {
    if (input.selectionId || ctx.answeringPerson) return null;
    const text = input.text.trim();
    if (/^men[uú]$/i.test(text)) return null;
    if (state && state.step !== 'ROOT' && !PERSON_MENTION_STEPS.has(state.step))
      return null;
    const name = staffNamed(text, ctx.staffNames ?? [], ctx.botName);
    if (!name) return null;
    await this.api
      .requestHandoff(
        ctx.conversationId,
        `Mensaje para ${name}: "${text.length > 300 ? `${text.slice(0, 300)}…` : text}"`,
      )
      .catch(() => undefined);
    return name;
  }

  /** Runs a client action for someone who has not said they are a client yet. */
  private guardAsClient(
    ctx: FlowContext,
    key: string,
    action: ClientAction,
    opts: ActionOptions = {},
    said?: string,
  ): Promise<FlowResult> {
    if (!ctx.client) {
      const current = this.load(key)?.state;
      this.setState(
        key,
        current?.step ?? 'ROOT',
        current?.data ?? {},
        'client',
      );
    }
    return this.guard(ctx, key, action, opts, said);
  }

  /**
   * A request for a person. With a reason ("quiero hablar con alguien por la
   * cuota") it goes to the office right away; a bare "asesor" asks what for,
   * like the client menu does.
   */
  private async advisorRequest(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    if (BARE_ADVISOR_RE.test(fold(input.text).trim())) {
      this.setState(key, 'ASESOR_MOTIVO');
      return {
        messages: [
          {
            kind: 'text',
            body: `Contame brevemente el motivo y un asesor te contacta a la brevedad (${attentionHoursOf(ctx.attentionHours)}).`,
          },
        ],
      };
    }
    return this.handleAsesorMotivo(input, ctx, key);
  }

  /**
   * The customer is going on with something a person from the office was
   * handling ("ya te mandé las fotos", "estoy en el sanatorio"). The bot stays
   * out of it: the chat is flagged for that person, and the customer only hears
   * from the bot when the office is closed, so they know when to expect an
   * answer. Null when no person wrote recently — then it is just a message.
   */
  private async personFollowUp(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult | null> {
    // Days later the person is no longer in the middle of it: the customer
    // hears that it was passed on.
    // Or right after the bot offered to pass on what they were talking about.
    if (!ctx.answeringPerson)
      return this.answeringOffice(ctx) ||
        this.load(key)?.state.data.officeGreeted === true
        ? this.officeFollowUp(input.text, ctx, key)
        : null;
    // Without a reason on purpose: the API then keeps a single pending matter
    // for the chat however many messages follow. With the text as reason, a
    // customer writing four lines to Mili opened four "Pedido de asesor".
    await this.api.requestHandoff(ctx.conversationId).catch(() => undefined);
    const closed = await this.closedNote();
    if (!closed) return { messages: [] };
    return {
      messages: [
        {
          kind: 'text',
          body: `Le paso tu mensaje a la persona que te venía atendiendo 🙌${closed}`,
        },
      ],
    };
  }

  private async handleClientMenu(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const opt = input.selectionId ?? this.matchClientIntent(input.text);
    const typed = !input.selectionId;

    if (
      typed &&
      OFFICE_ONLY_POLICY_RE.test(fold(input.text)) &&
      opt !== OPT.cotizacion &&
      opt !== OPT.siniestros &&
      opt !== OPT.grua
    )
      return this.officeOnlyRequest(input.text, ctx, key);

    switch (opt) {
      case OPT.siniestros: {
        // "¿Ya está hecha la denuncia?" already says which one it is.
        const sub = typed ? this.matchSiniestroIntent(input.text) : null;
        if (sub)
          return this.guard(
            ctx,
            key,
            sub === OPT.sinNueva ? 'siniestro_nueva' : 'siniestro_consultar',
            {},
            input.text,
          );
        this.setState(key, 'SINIESTRO_TYPE');
        return { messages: [siniestroTypeMenu()] };
      }
      case OPT.cotizacion:
        return this.enterCotizar(input, ctx, key);
      case OPT.pagos:
        return this.guard(ctx, key, 'pagos', {}, input.text);
      case OPT.cambioPago:
        return this.paymentChangeRequest(ctx, key);
      case OPT.bajaPoliza:
        return this.guard(ctx, key, 'baja_poliza', {}, input.text);
      case OPT.documentos:
        return this.guard(ctx, key, 'documentos', {}, input.text);
      case OPT.cupones:
        return this.guard(
          ctx,
          key,
          'cupones',
          { withDocs: DOCS_TOO_RE.test(fold(input.text)) },
          input.text,
        );
      case OPT.grua:
        return {
          messages: [{ kind: 'text', body: this.gruaText() }, clientMenu()],
        };
      case OPT.asesor: {
        // What they already asked ("no me aparece la cuota 4") is offered as
        // the reason: two customers had to type their question again.
        const asked = this.load(key)?.state.data.lastQuestion;
        if (typeof asked === 'string') {
          this.setState(key, 'ASESOR_MOTIVO', { lastQuestion: asked });
          return { messages: [advisorSameQuestion(asked)] };
        }
        this.setState(key, 'ASESOR_MOTIVO');
        return {
          messages: [
            {
              kind: 'text',
              body: `Contame brevemente el motivo y un asesor te contacta a la brevedad (${attentionHoursOf(ctx.attentionHours)}).`,
            },
          ],
        };
      }
      default:
        // Hybrid router: the keyword matcher didn't catch a transactional
        // intent, so instead of a dead-end "no te entendí" we hand this single
        // turn to NICO (the FAQ LLM) for a natural reply. We deliberately do NOT
        // switch to LLM_FAQ state — the user stays in CLIENT_MENU, so the next
        // message is routed deterministically again and there's no LLM lock-in
        // (one model call per unmatched message, which keeps cost bounded).
        return { messages: [], handoff: 'faq' };
    }
  }

  private handleLeadMenu(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): FlowResult | Promise<FlowResult> {
    if (this.matchClientIntent(input.text) === OPT.bajaPoliza)
      return this.guard(ctx, key, 'baja_poliza', {}, input.text);
    const opt = input.selectionId ?? this.matchLeadIntent(input.text);

    switch (opt) {
      case OPT.leadCotizar:
        return this.enterCotizar(input, ctx, key);
      case OPT.leadVendedor:
        this.setState(key, 'LEAD_CONTACT');
        return {
          messages: [
            {
              kind: 'text',
              body: 'Genial. Dejame tu *nombre* y un *horario* de preferencia y un representante te llama.',
            },
          ],
        };
      case OPT.leadConsultas:
        this.setState(key, 'LLM_FAQ');
        return {
          messages: [
            {
              kind: 'text',
              body: 'Contame tu consulta y te ayudo. Escribí *menú* para volver al inicio.',
            },
          ],
        };
      default:
        // Keyword match didn't find intent — LLM responds naturally.
        // State stays LEAD_MENU so the next message tries matching again.
        return { messages: [], handoff: 'faq' };
    }
  }

  // ─── Identification ───────────────────────────────────────

  /**
   * Routes a client action: asks to identify first if needed, else runs it.
   * `said` is the message that asked for it — when it already carries the DNI,
   * CUIT or plate ("quiero dar de baja… dni 40119754") asking again would only
   * cost a round-trip, and people often don't answer it.
   */
  private async guard(
    ctx: FlowContext,
    key: string,
    action: ClientAction,
    opts: ActionOptions = {},
    said?: string,
  ): Promise<FlowResult> {
    const question = questionOf(opts.question ?? said);
    if (question) opts = { ...opts, question };
    // A claim the office took by hand in this chat is not in our records:
    // asking for the DNI to say "no tenés denuncias" helped nobody.
    if (action === 'siniestro_consultar' && ctx.officeThread && !ctx.client)
      return this.officeFollowUp(question ?? '', ctx, key);
    const pending = {
      pendingAction: action,
      ...(opts.withDocs ? { pendingWithDocs: true } : {}),
      ...(question ? { pendingQuestion: question } : {}),
    };
    if (!ctx.client && said) {
      const params = await this.identificationIn(said, action, ctx);
      if (params) {
        const result = await this.identifyAndRun(
          params,
          action,
          ctx,
          key,
          opts,
        );
        if (result) return result;
        this.setState(key, 'IDENTIFY', pending);
        return { messages: [{ kind: 'text', body: NOT_FOUND_TEXT }] };
      }
    }
    if (!ctx.client) {
      const asked = this.askPhoneMatch(ctx, key, action, pending);
      if (asked) return asked;
      this.setState(key, 'IDENTIFY', pending);
      return {
        messages: [
          {
            kind: 'text',
            body: 'Para acceder a tus datos necesito identificarte. Pasame el *DNI del titular* (o el *CUIT* si es una empresa) o la *patente* del vehículo asegurado.\n\n_Escribí *menú* para volver o *finalizar* para terminar._',
          },
        ],
      };
    }
    return this.runAction(action, ctx, key, opts);
  }

  private async handleIdentify(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const raw = input.text.trim();
    if (state.data.phoneConfirm) {
      const t = fold(raw);
      if (
        input.selectionId === OPT.phoneSi ||
        (!input.selectionId &&
          /^(?:si|sip|claro|correcto|exacto|soy yo|el mismo|la misma)\b/.test(
            t,
          ))
      )
        return this.confirmPhoneMatch(state, ctx, key);
      if (input.selectionId === OPT.phoneNo || /^no\b/.test(t))
        return this.declinePhoneMatch(state, ctx, key);
      // Anything else (a DNI, a plate, "asesor") is read as usual.
      const rest = withoutPhoneQuestion(state.data);
      state = { ...state, data: rest };
      this.setState(key, 'IDENTIFY', rest);
    }
    if (!raw) {
      return {
        messages: [
          {
            kind: 'text',
            body: 'Pasame el *DNI del titular* (o el *CUIT* si es una empresa) o la *patente* para identificarte.',
          },
        ],
      };
    }

    // The not-found reply offers "escribí *asesor*": honor it instead of
    // reading the word as a plate.
    if (/^(?:asesor|(?:quiero )?hablar con (?:un )?asesor)[.!]?$/i.test(raw)) {
      return this.handleClientMenu(
        { ...input, selectionId: OPT.asesor },
        ctx,
        key,
      );
    }

    let action = (state.data.pendingAction as IdentificationAction) ?? 'pagos';
    let params: { dni: string } | { plate: string } | null = null;
    // Bare identifiers need no interpretation; natural speech goes to the model.
    const bare =
      /^(?:[\d .-]+|[a-z]{3}[ -]*\d{3}|[a-z]{2}[ -]*\d{3}[ -]*[a-z]{2}|[a-z][ -]*\d{3}[ -]*[a-z]{3})$/i.test(
        raw,
      );
    if (bare || ctx.llmEnabled === false) params = identificationFromText(raw);
    else {
      try {
        const meaning = await this.identification.interpret({
          text: raw,
          pendingAction: action,
          history: ctx.history,
          phoneNumberId: ctx.phoneNumberId ?? '',
        });
        action = meaning.action ?? action;
        state = { ...state, data: { ...state.data, pendingAction: action } };
        if (meaning.clarification || (!meaning.dni && !meaning.plate)) {
          this.setState(key, 'IDENTIFY', state.data);
          return {
            messages: [
              {
                kind: 'text',
                body:
                  meaning.clarification ??
                  'Para continuar, decime el DNI del titular (o el CUIT si es una empresa) o la patente.',
              },
            ],
          };
        }
        params = meaning.dni
          ? { dni: meaning.dni }
          : meaning.plate
            ? { plate: meaning.plate }
            : null;
      } catch {
        this.logger.warn(
          'Interpretación de identificación no disponible; se pide el dato explícito',
        );
        // On a model failure only an explicit numeric/plate input is safe.
        params = bare ? identificationFromText(raw) : null;
      }
    }
    if (!params) {
      return this.retry(key, state, [
        {
          kind: 'text',
          body: 'No pude reconocer el documento o la patente. Decime el DNI completo (7 u 8 números), el CUIT si es una empresa (11 números) o la patente, por ejemplo *AB123CD*.',
        },
      ]);
    }

    const result = await this.identifyAndRun(params, action, ctx, key, {
      withDocs: state.data.pendingWithDocs === true,
      ...(typeof state.data.pendingQuestion === 'string'
        ? { question: state.data.pendingQuestion }
        : {}),
    });
    return (
      result ?? this.retry(key, state, [{ kind: 'text', body: NOT_FOUND_TEXT }])
    );
  }

  /**
   * Links the conversation to the client and runs the pending action, or
   * returns null when nobody matches.
   */
  private async identifyAndRun(
    params: { dni: string } | { plate: string },
    action: ClientAction,
    ctx: FlowContext,
    key: string,
    opts: ActionOptions,
  ): Promise<FlowResult | null> {
    try {
      await this.api.identifyClient(ctx.conversationId, params);
    } catch (error) {
      // 400 = the API rejected the shape (a DNI/plate of the wrong length, e.g.
      // "no me acuerdo"); for the user that's the same as not finding them.
      const status = axios.isAxiosError(error) ? error.response?.status : 0;
      if (status === 404 || status === 400) return null;
      throw error;
    }

    // ctx.client is still null in this request, but identifyClient persisted the
    // link, so the conversation-scoped action calls resolve the client fine.
    return this.prepend(
      '✅ ¡Listo, te identifiqué!',
      await this.runAction(action, ctx, key, opts),
    );
  }

  /**
   * The DNI, CUIT or plate a request already carries, read with the same care
   * as an answer to "pasame tu DNI": the model must quote it from the message,
   * so a policy or phone number isn't taken for a document. Without a model
   * only a single unambiguous document counts. Null when there's none.
   */
  private async identificationIn(
    text: string,
    action: ClientAction,
    ctx: FlowContext,
  ): Promise<{ dni: string } | { plate: string } | null> {
    // Most requests carry nothing that looks like a document: skip the model.
    if (!MAYBE_IDENTIFICATION_RE.test(text)) return null;
    if (ctx.llmEnabled === false) return identificationFromText(text);
    try {
      const meaning = await this.identification.interpret({
        text,
        pendingAction: action,
        history: ctx.history,
        phoneNumberId: ctx.phoneNumberId ?? '',
      });
      if (meaning.clarification) return null;
      return meaning.dni
        ? { dni: meaning.dni }
        : meaning.plate
          ? { plate: meaning.plate }
          : null;
    } catch {
      return null;
    }
  }

  /** Runs a client action assuming the conversation already has a client. */
  private async runAction(
    action: ClientAction,
    ctx: FlowContext,
    key: string,
    opts: ActionOptions = {},
  ): Promise<FlowResult> {
    const repeated = await this.alreadyRequested(action, ctx, key);
    if (repeated) return repeated;
    switch (action) {
      case 'menu':
        this.setState(key, 'CLIENT_MENU');
        return { messages: [clientMenu()] };
      case 'pagos': {
        const estado = await this.api.getEstadoCuenta(ctx.conversationId);
        const question = questionOf(opts.question);
        // Kept so "Hablar con un asesor" can pass it on without retyping.
        this.setState(
          key,
          'CLIENT_MENU',
          question ? { lastQuestion: question } : {},
        );
        const answer = question ? paymentAnswer(estado, question) : null;
        return {
          messages: [
            {
              kind: 'text',
              body:
                formatEstadoCuenta(estado) + (answer ? `\n\n${answer}` : ''),
            },
            estado.length ? pagosMenu() : clientMenu(),
          ],
        };
      }
      case 'siniestro_consultar': {
        const siniestros = await this.api.getSiniestros(ctx.conversationId);
        if (siniestros.length === 0 && ctx.officeThread)
          return this.officeFollowUp(opts.question ?? '', ctx, key);
        this.setState(key, 'CLIENT_MENU');
        return {
          messages: [
            { kind: 'text', body: formatSiniestros(siniestros) },
            clientMenu(),
          ],
        };
      }
      case 'siniestro_nueva': {
        const polizas = await this.api.getPolizas(ctx.conversationId);
        // Often the policy lapsed over a rejected or missed payment: the claim
        // can't go through on its own, but the office has to know about it.
        if (polizas.length === 0)
          return this.siniestroBloqueado(
            key,
            ctx,
            'Denuncia de siniestro no registrada: el cliente no tiene pólizas vigentes.',
            'No encontré pólizas vigentes a tu nombre, así que no puedo registrar la denuncia automáticamente.',
          );
        this.setState(key, 'SINIESTRO_POLIZA', { polizas });
        return {
          messages: [
            polizaPicker(polizas, '¿Sobre qué póliza es la denuncia?'),
          ],
        };
      }
      case 'baja_poliza': {
        const polizas = await this.api.getPolizas(ctx.conversationId);
        if (!polizas.length) return this.noPolizas(key);
        this.setState(key, 'BAJA_POLIZA', { polizas });
        return {
          messages: [
            polizaPicker(polizas, '¿De qué póliza querés solicitar la baja?', {
              otherRow: true,
            }),
          ],
        };
      }
      case 'documentos': {
        const polizas = await this.api.getPolizas(ctx.conversationId);
        if (polizas.length === 0) return this.noPolizas(key);
        this.setState(key, 'DOC_POLIZA', { polizas });
        return {
          messages: [
            polizaPicker(polizas, '¿De qué póliza querés la documentación?', {
              otherRow: true,
            }),
          ],
        };
      }
      case 'cupones': {
        const polizas = await this.api.getPolizas(ctx.conversationId);
        if (polizas.length === 0) return this.noPolizas(key);
        const withDocs = opts.withDocs === true;
        if (polizas.length === 1)
          return this.requestCupones(polizas, false, withDocs, ctx, key);
        this.setState(key, 'CUPON_POLIZA', {
          polizas,
          ...(withDocs ? { withDocs } : {}),
        });
        return {
          messages: [
            polizaPicker(
              polizas,
              withDocs
                ? '¿De qué póliza necesitás los cupones y la documentación?'
                : '¿De qué póliza necesitás los cupones de pago?',
              { allRow: true, otherRow: true },
            ),
          ],
        };
      }
    }
  }

  private async handleCuponPoliza(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const polizas = (state.data.polizas as PolizaSummary[] | undefined) ?? [];
    const withDocs = state.data.withDocs === true;
    const t = fold(input.text);
    const other = this.otherPoliza(input, key);
    if (other) return other;
    if (
      input.selectionId === ALL_POLIZAS_ID ||
      /\b(todas|todos|ambas|ambos|las dos|los dos)\b/.test(t)
    )
      return this.requestCupones(polizas, true, withDocs, ctx, key);

    const id = this.parsePrefId(input.selectionId, POLIZA_PREFIX);
    const poliza =
      polizas.find((p) => p.id === id) ??
      this.matchPolizaByText(input.text, polizas);
    if (poliza) return this.requestCupones([poliza], false, withDocs, ctx, key);

    return this.retry(key, state, [
      polizaPicker(
        polizas,
        'No reconocí esa póliza. Elegí una de la lista, o escribí *menú* para volver.',
        { allRow: true, otherRow: true },
      ),
    ]);
  }

  /**
   * Passes a coupon request to the office, which sends the coupons by hand in
   * this same chat: Triunfo has no service that returns them. Remembered for
   * the rest of the menu visit so asking again is acknowledged, not restarted.
   */
  private async requestCupones(
    polizas: PolizaSummary[],
    all: boolean,
    withDocs: boolean,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const what = withDocs
      ? 'los cupones de pago y la documentación'
      : 'los cupones de pago';
    const which =
      polizas.length === 1
        ? `de su póliza ${polizaMention(polizas[0])}`
        : `de todas sus pólizas: ${polizas.map(polizaMention).join('; ')}`;
    await this.api
      .requestHandoff(
        ctx.conversationId,
        `Pide ${what} ${which}. El bot no puede obtenerlos de Triunfo: enviárselos por este chat.`,
      )
      .catch(() => undefined);

    const label = all
      ? 'todas tus pólizas'
      : polizas.length === 1
        ? `tu ${polizaLabel(polizas[0])}`
        : 'tus pólizas';
    this.setState(key, 'CLIENT_MENU', {
      requested: { action: 'cupones', what, label },
    });
    const papers = withDocs
      ? 'Los cupones de pago y la documentación'
      : 'Los cupones de pago';
    return {
      messages: [
        {
          kind: 'text',
          body:
            `${papers} te los manda la oficina por este chat 🙌 Ya les pasé tu pedido para ${label}. ` +
            `Te los envían en el horario de atención (${attentionHoursOf(ctx.attentionHours)}).` +
            (await this.closedNote()),
        },
        clientMenu(),
      ],
    };
  }

  /**
   * The same request made again right after it went to the office — the loop
   * a customer fell into asking three times for "los 3 cupones": each time the
   * bot asked for the policy again and answered the same thing.
   */
  private async alreadyRequested(
    action: ClientAction,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult | null> {
    const current = this.load(key)?.state;
    const requested =
      current?.step === 'CLIENT_MENU'
        ? (current.data.requested as
            | { action: ClientAction; what: string; label: string }
            | undefined)
        : undefined;
    if (!requested || requested.action !== action) return null;
    return {
      messages: [
        {
          kind: 'text',
          body:
            `Ya le pasé a la oficina tu pedido de ${requested.what} de ${requested.label} 👍 ` +
            `Te los mandan por este chat en el horario de atención (${attentionHoursOf(ctx.attentionHours)}).` +
            (await this.closedNote()) +
            '\n\nSi necesitás otra cosa, escribí *menú*.',
        },
      ],
    };
  }

  private handleBajaPoliza(
    state: FlowState,
    input: UserInput,
    key: string,
  ): FlowResult {
    const polizas = state.data.polizas as PolizaSummary[];
    const other = this.otherPoliza(input, key);
    if (other) return other;
    const id = this.parsePrefId(input.selectionId, POLIZA_PREFIX);
    const poliza =
      polizas.find((p) => p.id === id) ??
      this.matchPolizaByText(input.text, polizas);
    if (!poliza)
      return this.retry(key, state, [
        polizaPicker(polizas, 'Elegí la póliza para solicitar la baja.', {
          otherRow: true,
        }),
      ]);
    this.setState(key, 'BAJA_CONFIRM', { ...state.data, polizaId: poliza.id });
    return { messages: [this.bajaConfirmMessage(poliza)] };
  }

  private bajaConfirmMessage(poliza: PolizaSummary): OutgoingMessage {
    return {
      kind: 'buttons',
      body: `¿Confirmás que querés solicitar la baja de la póliza *${poliza.certificateNumber}*${poliza.vehicle?.licensePlate ? ` (${poliza.vehicle.licensePlate})` : ''}? La oficina recibirá el pedido y te confirmará cuándo queda efectiva.`,
      buttons: [
        { id: OPT.confirmar, title: 'Solicitar baja' },
        { id: OPT.cancelar, title: 'Cancelar' },
      ],
    };
  }

  private async handleBajaConfirm(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const choice = input.selectionId ?? this.matchConfirmIntent(input.text);
    if (choice === OPT.cancelar) {
      this.setState(key, 'CLIENT_MENU');
      return {
        messages: [
          { kind: 'text', body: 'Cancelé el pedido de baja.' },
          clientMenu(),
        ],
      };
    }
    const poliza = (state.data.polizas as PolizaSummary[]).find(
      (p) => p.id === state.data.polizaId,
    )!;
    if (choice !== OPT.confirmar)
      return this.retry(key, state, [this.bajaConfirmMessage(poliza)]);
    await this.api.requestPolicyCancellation(ctx.conversationId, poliza.id);
    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body: `Registré tu solicitud de baja de la póliza *${poliza.certificateNumber}*. La oficina recibió la notificación y te confirmará la gestión. La póliza todavía no fue dada de baja.`,
        },
      ],
    };
  }

  // ─── Siniestros ───────────────────────────────────────────

  private async handleSiniestroType(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const opt = input.selectionId ?? this.matchSiniestroIntent(input.text);
    // A DNI typed on this menu is kept for when they pick an option.
    const said =
      typeof state.data.pendingSaid === 'string'
        ? `${state.data.pendingSaid} ${input.text}`
        : input.text;
    if (opt === OPT.sinNueva)
      return this.guard(ctx, key, 'siniestro_nueva', {}, said);
    if (opt === OPT.sinConsultar)
      return this.guard(ctx, key, 'siniestro_consultar', {}, said);
    // Anything else used to go to the FAQ model, which answered "escribí
    // *menú* y elegí Siniestros" to someone already on this menu.
    this.setState(key, 'SINIESTRO_TYPE', {
      ...state.data,
      ...(MAYBE_IDENTIFICATION_RE.test(input.text)
        ? { pendingSaid: input.text }
        : {}),
    });
    return {
      messages: [
        {
          kind: 'buttons',
          body: 'Para seguir, decime si es una *denuncia nueva* o si querés *consultar* una que ya hiciste.',
          buttons: [
            { id: OPT.sinNueva, title: 'Denuncia nueva' },
            { id: OPT.sinConsultar, title: 'Consultar una' },
          ],
        },
      ],
    };
  }

  private async handleSiniestroPoliza(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const polizas = (state.data.polizas as PolizaSummary[] | undefined) ?? [];
    let polizaId = this.parsePrefId(input.selectionId, POLIZA_PREFIX);

    if (
      (polizaId === null || !polizas.some((p) => p.id === polizaId)) &&
      input.text.trim()
    ) {
      const match = this.matchPolizaByText(input.text, polizas);
      if (match) polizaId = match.id;
    }

    if (polizaId === null || !polizas.some((p) => p.id === polizaId)) {
      // Can't resolve the policy. Re-show the picker instead of leaking to the
      // FAQ model, which doesn't know we're mid-denuncia and would strand the claim.
      return this.retry(key, state, [
        polizaPicker(
          polizas,
          'No reconocí esa póliza. Elegí una de la lista, o escribí *menú* para volver.',
        ),
      ]);
    }

    const poliza = polizas.find((p) => p.id === polizaId)!;
    const pago = poliza.paymentStatus;
    if (pago && !pago.upToDate) {
      // Reason worded so the office files it under siniestros, not pagos
      // (see classifyMatter in the API: payment words take precedence).
      const motivo =
        pago.rejectedInstallments > 0
          ? 'un cobro rechazado'
          : 'saldo vencido impago';
      return this.siniestroBloqueado(
        key,
        ctx,
        `Denuncia de siniestro no registrada: la póliza ${poliza.certificateNumber} figura con ${motivo}.`,
        pago.rejectedInstallments > 0
          ? `La póliza *${poliza.certificateNumber}* registra un *pago rechazado*, así que no puedo tomar la denuncia automáticamente: la cobertura puede estar suspendida hasta regularizarlo.`
          : `La póliza *${poliza.certificateNumber}* registra *cuotas vencidas sin pagar*, así que no puedo tomar la denuncia automáticamente: la cobertura puede estar suspendida hasta regularizarlas.`,
      );
    }

    // Without the model (number over its monthly budget) the claim is asked
    // one question at a time, as before.
    if (ctx.llmEnabled === false)
      return this.askSiniestroFecha(key, state.data, polizaId);

    this.setState(key, 'SINIESTRO_DATOS', {
      ...state.data,
      polizaId,
      datos: SINIESTRO_DATOS_VACIOS,
      pedidos: [],
    });
    return { messages: [siniestroChecklist()] };
  }

  private askSiniestroFecha(
    key: string,
    data: Record<string, unknown>,
    polizaId: number,
  ): FlowResult {
    this.setState(key, 'SINIESTRO_FECHA', { ...data, polizaId });
    return {
      messages: [
        {
          kind: 'text',
          body: '¿Qué día ocurrió el hecho? Escribilo como *DD/MM/AAAA* (o "hoy").',
        },
      ],
    };
  }

  /**
   * The customer's answer to the checklist (or to the follow-up for what was
   * missing). The model only reads the text into fields; this step validates
   * them, asks again for whatever is still missing in a single message, and
   * moves to the usual confirmation once the claim is complete.
   */
  private async handleSiniestroDatos(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const known =
      (state.data.datos as SiniestroDatos | undefined) ??
      SINIESTRO_DATOS_VACIOS;
    const asked = (state.data.pedidos as SiniestroCampo[] | undefined) ?? [];
    const text = input.text.trim();
    if (!text) {
      const faltan = pendientes(known);
      return this.retry(key, state, [
        asked.length ? siniestroFaltantes(faltan) : siniestroChecklist(),
      ]);
    }

    let extracted: Partial<SiniestroDatos>;
    try {
      extracted = await this.extractor.extract({
        text,
        known,
        asked,
        phoneNumberId: ctx.phoneNumberId ?? '',
      });
    } catch (error) {
      this.logger.warn(
        `No se pudieron leer los datos del siniestro con el modelo: ${(error as Error).message} — sigo paso a paso`,
      );
      return this.prepend(
        'Vamos a cargarlo de a un dato por vez.',
        this.askSiniestroFecha(key, state.data, state.data.polizaId as number),
      );
    }

    // Only a real past or present date counts; anything else is asked again.
    if (extracted.fecha && !parseFecha(extracted.fecha)) extracted.fecha = null;
    const datos = mergeDatos(known, extracted);
    const faltan = pendientes(datos);
    const progressed = faltan.length < pendientes(known).length;

    if (faltan.length) {
      const data = {
        ...state.data,
        datos,
        pedidos: faltan.map((f) => f.campo),
      };
      if (!progressed)
        return this.retry(key, { ...state, data }, [
          siniestroFaltantes(faltan),
        ]);
      this.setState(key, 'SINIESTRO_DATOS', { ...data, [RETRIES]: 0 });
      return { messages: [siniestroFaltantes(faltan)] };
    }

    const fecha = parseFecha(datos.fecha!)!;
    const descripcion = siniestroDescripcion(datos);
    this.setState(key, 'SINIESTRO_CONFIRM', {
      ...state.data,
      datos,
      pedidos: [],
      fechaIso: fecha.iso,
      fechaDisplay: fecha.display,
      descripcion,
    });
    const polizas = (state.data.polizas as PolizaSummary[] | undefined) ?? [];
    return {
      messages: [
        siniestroConfirm(
          polizas.find((p) => p.id === state.data.polizaId),
          fecha.display,
          descripcion,
        ),
      ],
    };
  }

  private handleSiniestroFecha(
    state: FlowState,
    input: UserInput,
    key: string,
  ): FlowResult {
    const fecha = parseFecha(input.text);
    if (!fecha) {
      // Couldn't read a date. Re-ask deterministically (staying in this step)
      // instead of handing to the FAQ model, which would derail the denuncia.
      return this.retry(key, state, [
        {
          kind: 'text',
          body: 'No pude leer la fecha 🗓️. Decime *hoy* o *ayer*, o escribila como *DD/MM/AAAA* (por ejemplo 05/06/2026).',
        },
      ]);
    }
    this.setState(key, 'SINIESTRO_DESC', {
      ...state.data,
      fechaIso: fecha.iso,
      fechaDisplay: fecha.display,
    });
    return {
      messages: [
        {
          kind: 'text',
          body: 'Contame cómo ocurrió el hecho. Si fue un choque, ¿cómo fue el choque?',
        },
      ],
    };
  }

  private handleSiniestroDesc(
    state: FlowState,
    input: UserInput,
    key: string,
  ): FlowResult {
    const descripcion = input.text.trim();
    if (descripcion.length < 5) {
      // Too short. Re-ask in-flow rather than leaking to the FAQ model, so the
      // denuncia keeps moving toward confirmation.
      return this.retry(key, state, [
        {
          kind: 'text',
          body: 'Contame un poco más de cómo ocurrió el hecho o cómo fue el choque.',
        },
      ]);
    }

    this.setState(key, 'SINIESTRO_HORA', { ...state.data, descripcion });
    return {
      messages: [
        {
          kind: 'text',
          body: '¿A qué hora ocurrió? Escribí la hora como *HH:MM*, o decime una hora aproximada.',
        },
      ],
    };
  }

  private handleSiniestroDetalle(
    state: FlowState,
    input: UserInput,
    key: string,
  ): FlowResult {
    const fields = {
      SINIESTRO_HORA: {
        field: 'hora',
        next: 'SINIESTRO_LOCALIDAD',
        question: '¿En qué localidad ocurrió el hecho?',
      },
      SINIESTRO_LOCALIDAD: {
        field: 'localidad',
        next: 'SINIESTRO_CALLE',
        question: '¿En qué calle ocurrió?',
      },
      SINIESTRO_CALLE: {
        field: 'calle',
        next: 'SINIESTRO_ALTURA',
        question:
          '¿A qué altura de esa calle? Si no había numeración, indicá la esquina, kilómetro o referencia.',
      },
      SINIESTRO_ALTURA: {
        field: 'altura',
        next: 'SINIESTRO_CONFIRM',
        question: '',
      },
    } as const;
    const detail = fields[state.step as keyof typeof fields];
    const value = input.text.trim();
    if (!value || !/[\p{L}\p{N}]/u.test(value)) {
      return this.retry(key, state, [
        {
          kind: 'text',
          body: 'Necesito ese dato para completar la denuncia. Si no lo sabés, decime que no lo recordás.',
        },
      ]);
    }
    const data = { ...state.data, [detail.field]: value };
    if (detail.next !== 'SINIESTRO_CONFIRM') {
      this.setState(key, detail.next, data);
      return { messages: [{ kind: 'text', body: detail.question }] };
    }
    // Preserve the existing claim contract: details reach the panel and advisor
    // in the description, together with the account of what happened.
    const descripcion = `${String(data.descripcion)}\nHora: ${String(data.hora)}\nLocalidad: ${String(data.localidad)}\nCalle: ${String(data.calle)}\nAltura / referencia: ${value}`;
    this.setState(key, 'SINIESTRO_CONFIRM', { ...data, descripcion });
    const polizas = (data.polizas as PolizaSummary[] | undefined) ?? [];
    return {
      messages: [
        siniestroConfirm(
          polizas.find((p) => p.id === data.polizaId),
          data.fechaDisplay as string,
          descripcion,
        ),
      ],
    };
  }

  private async handleSiniestroConfirm(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const sel = input.selectionId ?? this.matchConfirmIntent(input.text);

    if (sel === OPT.cancelar) {
      this.setState(key, 'CLIENT_MENU');
      return {
        messages: [
          { kind: 'text', body: 'Cancelé la denuncia. ¿Algo más?' },
          clientMenu(),
        ],
      };
    }
    if (sel !== OPT.confirmar) {
      // Anything that isn't a clear yes/no (free text or a stray tap): re-show
      // the confirmation card so the final step never slips into the FAQ model.
      const polizas = (state.data.polizas as PolizaSummary[] | undefined) ?? [];
      const poliza = polizas.find((p) => p.id === state.data.polizaId);
      return this.retry(key, state, [
        siniestroConfirm(
          poliza,
          state.data.fechaDisplay as string,
          state.data.descripcion as string,
        ),
      ]);
    }

    const polizas = (state.data.polizas as PolizaSummary[] | undefined) ?? [];
    const poliza = polizas.find((p) => p.id === state.data.polizaId);

    const siniestro = await this.api.createSiniestro(ctx.conversationId, {
      policyId: state.data.polizaId as number,
      type: this.tipoFromRisk(poliza?.riskType),
      occurredAt: state.data.fechaIso as string,
      description: state.data.descripcion as string,
    });

    // Start the guided photo capture. Each photo the client sends from here is
    // attached to THIS claim and labeled by type (tarjeta verde / carnet / tercero).
    this.setState(key, 'SINIESTRO_FOTO_TARJETA', { siniestroId: siniestro.id });
    return {
      messages: [
        {
          kind: 'text',
          body:
            `✅ Registré tu denuncia (N° interno *${siniestro.id}*).\n` +
            `La oficina la va a cargar en Triunfo Seguros y te vamos a informar el número de siniestro oficial.`,
        },
        {
          kind: 'text',
          body:
            'Ahora sumemos algunas *fotos* a tu reclamo 📎.\n\n' +
            'Mandame una *foto de la tarjeta verde* (cédula del vehículo). ' +
            'Si no la tenés a mano, escribí *no la tengo* y seguimos.',
        },
      ],
    };
  }

  // ─── Siniestro: captura guiada de fotos ───────────────────

  /** True when the user is skipping a photo step or done sending ("no la
   * tengo", "saltar", "listo", and the way people actually type it: "listooo",
   * "ya está", "eso es todo"). */
  private isPhotoSkip(text: string): boolean {
    return /^(no+|nop|no la tengo|no las? tengo|no los? tengo|no tengo|salt(ar|o|a)|omitir|siguiente|despues|list[oa]+|ya (esta|fue|termine)|termine|eso es todo|nada mas|fin)\b/.test(
      fold(text).trim(),
    );
  }

  /** A photo step advances on a received photo (synthetic id) or an explicit skip. */
  private photoAdvances(input: UserInput): boolean {
    return (
      input.selectionId === PHOTO_RECEIVED ||
      (!input.selectionId && this.isPhotoSkip(input.text))
    );
  }

  private askPhoto(key: string, step: FlowStep, body: string): FlowResult {
    this.setState(key, step);
    return { messages: [{ kind: 'text', body }] };
  }

  private retryPhoto(): FlowResult {
    return {
      messages: [
        {
          kind: 'text',
          body: 'Mandame la *foto* 📷, o escribí *no la tengo* para saltar este paso.',
        },
      ],
    };
  }

  private handleSinFotoTarjeta(input: UserInput, key: string): FlowResult {
    if (!this.photoAdvances(input)) return this.retryPhoto();
    return this.askPhoto(
      key,
      'SINIESTRO_FOTO_CARNET',
      'Perfecto. Ahora una *foto de tu carnet de conducir*. (si no la tenés, escribí *no la tengo*)',
    );
  }

  private handleSinFotoCarnet(input: UserInput, key: string): FlowResult {
    if (!this.photoAdvances(input)) return this.retryPhoto();
    this.setState(key, 'SINIESTRO_TERCERO');
    return {
      messages: [
        {
          kind: 'buttons',
          body: '¿Hubo un *tercero involucrado* en el siniestro?',
          buttons: [
            { id: TERCERO_SI, title: 'Sí, hubo' },
            { id: TERCERO_NO, title: 'No' },
          ],
        },
      ],
    };
  }

  private handleSinTercero(
    state: FlowState,
    input: UserInput,
    key: string,
  ): FlowResult {
    const t = input.text.trim().toLowerCase();
    const yes =
      input.selectionId === TERCERO_SI ||
      /^s[ií]\b/.test(t) ||
      /\bhubo\b/.test(t);
    const no = input.selectionId === TERCERO_NO || /^no\b/.test(t);

    if (yes) {
      return this.askPhoto(
        key,
        'SINIESTRO_TERCERO_TARJETA',
        'Mandame la *foto de la tarjeta verde del tercero* (si la tenés). (o *no la tengo*)',
      );
    }
    if (no) return this.askDanio(key);

    return this.retry(key, state, [
      {
        kind: 'buttons',
        body: 'Decime si hubo un tercero involucrado:',
        buttons: [
          { id: TERCERO_SI, title: 'Sí, hubo' },
          { id: TERCERO_NO, title: 'No' },
        ],
      },
    ]);
  }

  private handleSinTerceroTarjeta(input: UserInput, key: string): FlowResult {
    if (!this.photoAdvances(input)) return this.retryPhoto();
    return this.askPhoto(
      key,
      'SINIESTRO_TERCERO_CARNET',
      'Ahora la *foto del carnet de conducir del tercero*. (o *no la tengo*)',
    );
  }

  private handleSinTerceroCarnet(input: UserInput, key: string): FlowResult {
    if (!this.photoAdvances(input)) return this.retryPhoto();
    return this.askDanio(key);
  }

  /** Asks for the incident/damage photos (multiple allowed), the last photo step. */
  private askDanio(key: string): FlowResult {
    this.setState(key, 'SINIESTRO_FOTO_DANIO');
    return {
      messages: [
        {
          kind: 'text',
          body:
            'Por último, mandame *fotos del siniestro* 📸 (los daños del vehículo, el lugar, lo que tengas). ' +
            'Podés enviar varias. Cuando termines, escribí *listo*. Si no tenés, escribí *no tengo*.',
        },
      ],
    };
  }

  private handleSinFotoDanio(input: UserInput, key: string): FlowResult {
    // A photo arrived → attach it (done by the media handler) and stay here so the
    // user can keep sending more of the incident.
    if (input.selectionId === PHOTO_RECEIVED) {
      this.setState(key, 'SINIESTRO_FOTO_DANIO');
      return {
        messages: [
          {
            kind: 'text',
            body: claimPhotoAddedText(),
          },
        ],
      };
    }
    // "listo" / "no tengo" → close the claim capture.
    if (!input.selectionId && this.isPhotoSkip(input.text)) {
      return this.finishSiniestroPhotos(key);
    }
    return {
      messages: [
        {
          kind: 'text',
          body: 'Mandame las *fotos del siniestro* (los daños, el lugar), o escribí *listo* cuando termines.',
        },
      ],
    };
  }

  // ─── Cotización: documentos para contratar ────────────────

  /** One take-out document step: a photo (or "no la tengo") moves to the next. */
  /** A one-photo take-out step: a photo (or "no la tengo") moves to the next one. */
  private async handleTakeOutDoc(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    if (!this.photoAdvances(input)) {
      return this.retry(key, state, this.retryPhoto().messages);
    }
    return this.nextTakeOutStep(state.step, state.data, ctx, key);
  }

  /** "¿Es 0 km?": decides between the certificado de no rodamiento and the tarjeta + photos. */
  private async handleTakeOutCeroKm(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const t = fold(input.text).trim();
    const zeroKm =
      input.selectionId === CERO_KM_SI ||
      /^(si|sip|es 0 ?km|0 ?km|cero ?km|nuevo)\b/.test(t)
        ? true
        : input.selectionId === CERO_KM_NO || /^(no|usad[oa])\b/.test(t)
          ? false
          : undefined;
    if (zeroKm === undefined) return this.retry(key, state, [ceroKmQuestion()]);
    return this.nextTakeOutStep(
      state.step,
      { ...state.data, zeroKm },
      ctx,
      key,
    );
  }

  /** Photos of the vehicle: several, so it waits for "listo" to move on. */
  private async handleTakeOutVehiclePhotos(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    if (input.selectionId === PHOTO_RECEIVED) {
      this.setState(key, state.step, state.data);
      return { messages: [{ kind: 'text', body: vehiclePhotoAddedText() }] };
    }
    if (!input.selectionId && this.isPhotoSkip(input.text))
      return this.nextTakeOutStep(state.step, state.data, ctx, key);
    return this.retry(key, state, [
      {
        kind: 'text',
        body: 'Mandame las *fotos del vehículo* 📷 y cuando termines escribí *listo*. Si no podés ahora, escribí *no tengo*.',
      },
    ]);
  }

  /** Asks for what comes after `current` for this vehicle, or closes the take-out. */
  private async nextTakeOutStep(
    current: FlowStep,
    data: Record<string, unknown>,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const docs: TakeOutDocs = {
      zeroKm: typeof data.zeroKm === 'boolean' ? data.zeroKm : undefined,
      gnc: data.gnc === true,
    };
    const steps = takeOutSteps(docs);
    // Answering "¿es 0 km?" drops that question from the list: carry on after
    // the DNI, which is where it always sits.
    const at = steps.includes(current)
      ? steps.indexOf(current)
      : steps.indexOf('COT_DOC_DNI_DORSO');
    const next = steps[at + 1];
    if (!next) return this.finishTakeOutDocs(ctx, key);
    this.setState(key, next, {
      leadId: data.leadId,
      ...(docs.zeroKm !== undefined ? { zeroKm: docs.zeroKm } : {}),
      ...(docs.gnc ? { gnc: true } : {}),
    });
    const last = next === steps[steps.length - 1];
    return { messages: [takeOutPrompt(next, last)] };
  }

  private async finishTakeOutDocs(
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    return this.prepend(
      '¡Listo! 🙌 Ya tenemos todo para tu contratación. Un asesor te contacta ' +
        `para terminarla (${attentionHoursOf(ctx.attentionHours)}).` +
        (await this.closedNote()),
      this.menuAfterRequest(key, ctx),
    );
  }

  private finishSiniestroPhotos(key: string): FlowResult {
    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body: '¡Listo! 🙌 Sumé todo a tu denuncia. Un asesor le va a dar seguimiento y te contacta a la brevedad. ¿Necesitás algo más?',
        },
        clientMenu(),
      ],
    };
  }

  // ─── Documentación ────────────────────────────────────────

  private async handleDocPoliza(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const polizas = (state.data.polizas as PolizaSummary[] | undefined) ?? [];
    const other = this.otherPoliza(input, key);
    if (other) return other;
    let polizaId = this.parsePrefId(input.selectionId, POLIZA_PREFIX);

    if (
      (polizaId === null || !polizas.some((p) => p.id === polizaId)) &&
      input.text.trim()
    ) {
      const match = this.matchPolizaByText(input.text, polizas);
      if (match) polizaId = match.id;
    }

    if (polizaId === null || !polizas.some((p) => p.id === polizaId)) {
      // "Choferes": the drivers' policy is one we don't have.
      if (!input.selectionId && OFFICE_ONLY_POLICY_RE.test(fold(input.text)))
        return this.officeOnlyRequest(input.text, ctx, key);
      // Can't resolve policy — LLM asks naturally; state stays DOC_POLIZA.
      return { messages: [], handoff: 'faq' };
    }

    const docs = await this.api.getDocumentos(ctx.conversationId, polizaId);
    if (docs.length === 0) {
      // Triunfo does not return policy documents for the cartera yet, so this
      // is the normal outcome today. The request used to end here with a
      // promise nobody heard about; now it reaches the inbox as a handoff so
      // the office sends the tarjeta/certificado/cupón by hand.
      const poliza = polizas.find((p) => p.id === polizaId);
      const reason =
        `Pidió la documentación de su póliza${poliza ? ` ${polizaMention(poliza)}` : ''}. ` +
        'Triunfo no devolvió documentos: enviarle tarjeta, certificado o cupón según corresponda.';
      await this.api
        .requestHandoff(ctx.conversationId, reason)
        .catch(() => undefined);
      this.setState(key, 'CLIENT_MENU', {
        requested: {
          action: 'documentos',
          what: 'la documentación',
          label: poliza ? `tu ${polizaLabel(poliza)}` : 'tu póliza',
        },
      });
      return {
        messages: [
          {
            kind: 'text',
            body:
              'No tengo los documentos de esa póliza para enviarte ahora. Ya le pasé el pedido a un asesor para que te los mande por este chat ' +
              `(${attentionHoursOf(ctx.attentionHours)}).` +
              (await this.closedNote()),
          },
          clientMenu(),
        ],
      };
    }

    this.setState(key, 'DOC_TYPE', { docs });
    return { messages: [docPicker(docs)] };
  }

  private handleDocType(
    state: FlowState,
    input: UserInput,
    key: string,
  ): FlowResult {
    const docs =
      (state.data.docs as
        | { code: string; name: string; url: string }[]
        | undefined) ?? [];
    let codigo = this.parseStringRef(input.selectionId, DOC_PREFIX);

    if (!codigo && input.text.trim()) {
      codigo = this.matchDocByText(input.text, docs);
    }

    const doc = docs.find((d) => d.code === codigo);

    if (!doc) {
      // Can't identify document — LLM asks naturally; state stays DOC_TYPE.
      return { messages: [], handoff: 'faq' };
    }

    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [{ kind: 'text', body: formatDocumento(doc) }, clientMenu()],
    };
  }

  // ─── Asesor / leads ───────────────────────────────────────

  private async handleAsesorMotivo(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const current = this.load(key)?.state;
    const asked =
      current?.step === 'ASESOR_MOTIVO' &&
      typeof current.data.lastQuestion === 'string'
        ? current.data.lastQuestion
        : null;
    if (asked && input.selectionId === OPT.asesorOtra) {
      this.setState(key, 'ASESOR_MOTIVO');
      return {
        messages: [
          {
            kind: 'text',
            body: `Dale, contame brevemente el motivo y un asesor te contacta a la brevedad (${attentionHoursOf(ctx.attentionHours)}).`,
          },
        ],
      };
    }
    const same =
      asked &&
      (input.selectionId === OPT.asesorMisma ||
        (!input.selectionId &&
          /^(?:si|sip|dale|ok|okey|pasala|pasalo|esa|eso)\b/.test(
            fold(input.text).trim(),
          ) &&
          words(input.text).split(' ').length <= 3));
    const reason = same ? asked : input.text;
    // Mark the conversation as pending in the API so it surfaces in the admin
    // inbox. Best-effort: a failed call should not block the bot reply.
    await this.api
      .requestHandoff(ctx.conversationId, reason)
      .catch(() => undefined);
    const note = {
      kind: 'text' as const,
      body:
        `Listo, tomé nota ✍️. Un asesor te va a contactar dentro del horario de atención (${attentionHoursOf(ctx.attentionHours)}).` +
        (await this.closedNote()),
    };
    // Back to the menu of whoever they said they are. Someone who asked for a
    // person on their first message never said, so no menu follows.
    const audience = this.audienceOf(key, ctx);
    if (audience === 'lead') {
      this.setState(key, 'LEAD_MENU');
      return { messages: [note, leadMenu()] };
    }
    if (audience === 'client') {
      this.setState(key, 'CLIENT_MENU');
      return { messages: [note, clientMenu()] };
    }
    this.setState(key, 'ROOT');
    return { messages: [note] };
  }

  private async handleLeadContact(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    // A generic "call me" request (no specific product). Flag the conversation
    // for human attention so it surfaces in the admin inbox/novedades — the
    // product-specific quote leads go through createLead instead. Best-effort:
    // a failed call must not block the reply.
    await this.api
      .requestHandoff(ctx.conversationId, input.text)
      .catch(() => undefined);
    this.setState(key, 'LEAD_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body:
            `¡Gracias! Tomé nota ✍️. Un representante de ventas te va a contactar a la brevedad (${attentionHoursOf(ctx.attentionHours)}).` +
            (await this.closedNote()),
        },
        leadMenu(),
      ],
    };
  }

  // ─── LLM hand-off (cotización / FAQ) ──────────────────────

  private showCotizarMenu(key: string): FlowResult {
    this.setState(key, 'COTIZAR_TIPO');
    return { messages: [cotizarMenu()] };
  }

  /**
   * Entry point into the quote flow from a menu. When the user's message already
   * names a category ("quiero cotizar un hogar", "cotizame el auto"), skip the
   * category list and go straight into that category's sub-flow — they already
   * told us what they want, asking again is friction. Falls back to the category
   * menu only when no category is recognised ("quiero cotizar").
   */
  private enterCotizar(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): FlowResult | Promise<FlowResult> {
    // Only infer the category from typed text. A tap on the generic "Cotización"
    // option carries the row title (e.g. "💰 Cotización"), which names no
    // category, so it correctly falls through to the menu below.
    const category = input.selectionId
      ? null
      : this.matchCotizarCategory(input.text);
    // Auto/moto go straight to the online quote with the typed text intact, so
    // "quiero cotizar mi corsa 2010" reaches the model instead of the canned
    // "decime marca, modelo y año" (routing through the category picker turned
    // the text into a tap and threw the vehicle away).
    if (category === OPT.cotAuto || category === OPT.cotMoto) {
      return this.startCotizacion(
        key,
        category === OPT.cotMoto ? 'moto' : 'auto',
        ctx,
        input,
      );
    }
    if (category) {
      this.setState(key, 'COTIZAR_TIPO');
      return this.handleCotizarTipo(
        { text: input.text, selectionId: category },
        ctx,
        key,
      );
    }
    // No category word but clearly a vehicle ("cotizar mi honda wave 2020"):
    // the quote model works out auto vs moto — showing the category list would
    // make them repeat themselves.
    if (!input.selectionId && this.namesVehicle(input.text)) {
      return this.startCotizacion(key, undefined, ctx, input);
    }
    return this.showCotizarMenu(key);
  }

  /**
   * Routes a quote category. Auto/moto go to the online quote sub-flow (LLM +
   * Triunfo). The fixed-price risks (bolso/hogar) show the admin-configured
   * plans first; the remaining risks go straight to advisor-contact capture.
   * Either way a ContactLead is persisted so the request reaches the panel —
   * same split as the web.
   */
  private async handleCotizarTipo(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const opt = input.selectionId ?? this.matchCotizarCategory(input.text);
    if (!opt || !COTIZAR_LABEL[opt]) {
      // Typed a vehicle instead of picking ("el gol trend 1.6 2015"): quote it.
      if (!input.selectionId && this.namesVehicle(input.text)) {
        return this.startCotizacion(key, undefined, ctx, input);
      }
      // Category not recognised — LLM helps clarify; state stays COTIZAR_TIPO.
      return { messages: [], handoff: 'faq' };
    }

    if (COTIZAR_ONLINE.has(opt)) {
      return this.startCotizacion(
        key,
        opt === OPT.cotMoto ? 'moto' : 'auto',
        ctx,
        input,
      );
    }

    const productType = COTIZAR_PRODUCT_TYPE[opt];

    if (COTIZAR_FIXED.has(opt)) {
      const plans = await this.api
        .getPricing(ctx.conversationId, productType)
        .catch(() => [] as ProductPlanSummary[]);
      if (plans.length > 0) {
        this.setState(key, 'COT_PLAN', {
          productType,
          productLabel: COTIZAR_LABEL[opt],
          plans,
        });
        // Send the full coverage breakdown first (same content as the web), then
        // the interactive picker so the user chooses knowing what each includes.
        return {
          messages: [
            planDetails(COTIZAR_LABEL[opt], plans),
            planPicker(COTIZAR_LABEL[opt], plans),
          ],
        };
      }
      // No plans configured yet — fall back to plain advisor-contact capture.
    }

    return this.startLeadCapture(key, productType, COTIZAR_LABEL[opt]);
  }

  /** Handles the fixed-price plan selection (bolso/hogar). */
  private async handleCotPlan(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const productType = state.data.productType as string;
    const productLabel =
      (state.data.productLabel as string | undefined) ?? 'Planes';
    const plans = (state.data.plans as ProductPlanSummary[] | undefined) ?? [];
    const planId = this.parsePrefId(input.selectionId, PLAN_PREFIX);
    const plan = plans.find((p) => p.id === planId);

    if (!plan) {
      // The user named a *different* risk instead of picking a plan ("quiero un
      // seguro para mi monopatín" while the bolso picker is on screen). Switch
      // to that category — re-showing the same picker traps them in a loop.
      const other = input.selectionId
        ? null
        : this.matchCotizarCategory(input.text);
      if (other && COTIZAR_PRODUCT_TYPE[other] !== productType) {
        this.setState(key, 'COTIZAR_TIPO');
        return this.handleCotizarTipo(
          { text: input.text, selectionId: other },
          ctx,
          key,
        );
      }
      // Couldn't resolve the plan — re-show the picker (never leaking to the
      // FAQ), but say so and offer the way out so it isn't a silent repeat.
      return this.retry(key, state, [
        planPicker(
          productLabel,
          plans,
          'No reconocí ese plan 🙈 Elegilo de la lista, o escribí *menú* para volver.\n\n',
        ),
      ]);
    }

    this.setState(key, 'COT_LEAD_NOMBRE', {
      productType,
      selectedPlanId: plan.id,
      planName: plan.name,
    });
    return {
      messages: [
        {
          kind: 'text',
          body: `Elegiste el plan *${plan.name}*. Para que un asesor lo deje listo, decime tu *nombre y apellido*.`,
        },
      ],
    };
  }

  /**
   * Starts the advisor-contact capture for a lead product. Lead products
   * (bici/comercio/personas/praxis) first collect the same product-specific
   * fields the web form asks — driven by the shared catalog so questions, web
   * form and admin lead detail stay identical — then ask for contact details.
   * Fixed products falling back here (no plans configured) and fieldless products
   * go straight to contact capture, matching the web.
   */
  private async startLeadCapture(
    key: string,
    productType: string,
    productLabel: string,
  ): Promise<FlowResult> {
    const item = await this.getCatalogItem(productType);
    const messages: OutgoingMessage[] = [];
    const coverage = item ? this.coverageLine(item) : null;
    if (coverage) messages.push({ kind: 'text', body: coverage });

    const intro =
      `📝 Genial, te ayudo a cotizar *${productLabel}*. ` +
      'Un asesor te contacta con la propuesta.\n\n';

    // Only lead products run the field capture; fixed/instant products carry no
    // fields, so they fall through to plain contact capture (same as the web).
    const fields = item?.flow === 'lead' ? item.fields : [];
    if (fields.length > 0) {
      this.setState(key, 'COT_LEAD_FIELDS', {
        productType,
        productLabel,
        fields,
        fieldIndex: 0,
        answers: {},
      });
      messages.push(this.fieldMessage(fields[0], intro));
      return { messages };
    }

    this.setState(key, 'COT_LEAD_NOMBRE', { productType });
    messages.push({
      kind: 'text',
      body:
        intro +
        'Para empezar, decime tu *nombre y apellido*.\n' +
        '_Escribí *menú* para volver._',
    });
    return { messages };
  }

  /** The shared catalog entry for a product, or null when it's unavailable. */
  private async getCatalogItem(
    productType: string,
  ): Promise<ProductCatalogItem | null> {
    try {
      return (
        (await this.api.getProducts()).find((p) => p.id === productType) ?? null
      );
    } catch {
      return null;
    }
  }

  /**
   * Price-free "qué cubre" line for a product, from the shared catalog (the same
   * source the web uses). Returns null when the catalog has no coverage list.
   */
  private coverageLine(item: ProductCatalogItem): string | null {
    if (item.includes.length === 0) return null;
    return `🛡️ *${item.label}* — ${item.sub}.\nIncluye: ${item.includes.join(', ')}.`;
  }

  // ─── Product-field capture (shared catalog) ───────────────

  /** Asks one catalog field — a list picker for `select`, plain text otherwise. */
  private fieldMessage(field: CatalogField, intro?: string): OutgoingMessage {
    return field.type === 'select' && (field.options?.length ?? 0) > 0
      ? fieldSelectPicker(field, intro)
      : fieldPrompt(field, intro);
  }

  /**
   * Generic capture loop over the product's catalog fields: validates the answer
   * for the current field, stores it under its label (the payload key the admin
   * sees), then advances to the next field or to contact capture when done.
   */
  private handleCotLeadFields(
    state: FlowState,
    input: UserInput,
    key: string,
  ): FlowResult {
    const fields = (state.data.fields as CatalogField[] | undefined) ?? [];
    const index = (state.data.fieldIndex as number | undefined) ?? 0;
    const answers = {
      ...((state.data.answers as Record<string, string> | undefined) ?? {}),
    };
    const field = fields[index];

    if (!field) {
      // Defensive: no field to capture → go straight to contact.
      this.setState(key, 'COT_LEAD_NOMBRE', {
        productType: state.data.productType,
        answers,
      });
      return this.askContactName();
    }

    const value = this.readFieldValue(field, input);
    if (value === null) {
      // Couldn't read a valid answer — re-ask the same field with a short,
      // kind correction so the user knows what to fix (no FAQ leak).
      const correction =
        field.type === 'select'
          ? 'Elegí una de las opciones de la lista 🙂 '
          : field.numeric
            ? 'Necesito un *número* (sin texto). '
            : 'No te llegué a entender 🙈 ';
      return this.retry(key, state, [this.fieldMessage(field, correction)]);
    }
    answers[field.label] = value;

    const nextIndex = index + 1;
    if (nextIndex < fields.length) {
      // The step doesn't change between fields, so the retry counter has to be
      // cleared by hand — it belongs to the field we just captured, not the next.
      this.setState(key, 'COT_LEAD_FIELDS', {
        ...state.data,
        answers,
        fieldIndex: nextIndex,
        [RETRIES]: 0,
      });
      return { messages: [this.fieldMessage(fields[nextIndex])] };
    }

    // All product fields captured → contact details.
    this.setState(key, 'COT_LEAD_NOMBRE', {
      productType: state.data.productType,
      answers,
    });
    return this.askContactName('Perfecto 🙌. ');
  }

  /**
   * Reads and validates the answer for a field. Returns the canonical value, or
   * null when the answer is invalid (the caller re-asks). For `select` it accepts
   * a tap or a typed option; for numeric it parses a positive amount.
   */
  private readFieldValue(field: CatalogField, input: UserInput): string | null {
    if (field.type === 'select' && (field.options?.length ?? 0) > 0) {
      const opts = field.options ?? [];
      if (input.selectionId?.startsWith(FIELD_OPT_PREFIX)) {
        const i = Number(input.selectionId.slice(FIELD_OPT_PREFIX.length));
        if (Number.isInteger(i) && opts[i]) return opts[i];
      }
      const t = input.text.trim().toLowerCase();
      if (t) {
        const exact = opts.find((o) => o.toLowerCase() === t);
        if (exact) return exact;
        const partial = opts.find(
          (o) => o.toLowerCase().includes(t) || t.includes(o.toLowerCase()),
        );
        if (partial) return partial;
      }
      return null;
    }

    const raw = input.text.trim();
    if (field.numeric) {
      const cleaned = raw
        .replace(/[^0-9.,]/g, '')
        .replace(/\./g, '')
        .replace(',', '.');
      const n = parseFloat(cleaned);
      if (!Number.isFinite(n) || n <= 0) return null;
      return String(Math.round(n));
    }
    if (raw.length < 2) return null;
    return raw;
  }

  private askContactName(prefix = ''): FlowResult {
    return {
      messages: [
        {
          kind: 'text',
          body: `${prefix}Para que el asesor te contacte, decime tu *nombre y apellido*.`,
        },
      ],
    };
  }

  private handleCotLeadNombre(
    state: FlowState,
    input: UserInput,
    key: string,
  ): FlowResult {
    const name = input.text.trim();
    if (name.length < 2) {
      return this.retry(key, state, [
        {
          kind: 'text',
          body: 'Decime tu *nombre y apellido* para que el asesor te ubique.',
        },
      ]);
    }
    this.setState(key, 'COT_LEAD_TELEFONO', {
      ...state.data,
      contactName: name,
    });
    return {
      messages: [
        {
          kind: 'text',
          body: 'Perfecto. Ahora pasame un *teléfono* de contacto donde te podamos llamar.',
        },
      ],
    };
  }

  private async handleCotLeadTelefono(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const phone = input.text.trim();
    if (phone.replace(/\D/g, '').length < 8) {
      return this.retry(key, state, [
        {
          kind: 'text',
          body: 'No reconocí el teléfono. Pasámelo con característica, por ejemplo *341 555-0000*.',
        },
      ]);
    }

    const productType = state.data.productType as string;
    const selectedPlanId = state.data.selectedPlanId as number | undefined;
    const planName = state.data.planName as string | undefined;
    const answers =
      (state.data.answers as Record<string, string> | undefined) ?? {};

    await this.api.createLead(ctx.conversationId, {
      productType,
      contactName: state.data.contactName as string,
      phone,
      payload: { ...answers, ...(planName ? { plan: planName } : {}) },
      ...(selectedPlanId ? { selectedPlanId } : {}),
    });

    const planLine = planName ? ` con el plan *${planName}*` : '';
    return this.prepend(
      `✅ ¡Listo! Registré tu pedido de cotización${planLine}. ` +
        `Un asesor te contacta a la brevedad (${attentionHoursOf(ctx.attentionHours)}).` +
        (await this.closedNote()),
      this.menuAfterRequest(key, ctx),
    );
  }

  /**
   * Opens the conversational quote. `vehiculo` is unknown when the user named
   * a vehicle without saying car or moto; the model then infers it (its prompt
   * covers that case), which is why that path always hands off.
   */
  private startCotizacion(
    key: string,
    vehiculo: 'auto' | 'moto' | undefined,
    ctx: FlowContext,
    input?: UserInput,
  ): FlowResult {
    // quoteStartedAt bounds the history the quote model sees (webhook.service),
    // so a restarted quote does not pick up the previous one's vehicle data.
    // It is the time of the message that opened the quote, so that message
    // ("cotizame mi corsa 2010, cp 2000") stays in the history.
    const quoteStartedAt = ctx.inboundAt ?? new Date().toISOString();
    this.setState(
      key,
      'LLM_COTIZACION',
      vehiculo ? { vehiculo, quoteStartedAt } : { quoteStartedAt },
    );
    if (!vehiculo) return { messages: [], handoff: 'cotizacion' };

    // The user often names the vehicle in the very message that opens the flow
    // ("Auto, tengo un peugeot 308 HDI feline 2020"). Answering with the canned
    // "decime marca, modelo y año" throws that away and reads as if we weren't
    // listening — one real chat replied "Ya te lo dije". When the message
    // carries more than the bare category, hand it straight to the model, which
    // reads it from the history and starts searching.
    if (input && !input.selectionId && this.carriesVehicleData(input.text)) {
      return { messages: [], handoff: 'cotizacion' };
    }

    const noun = vehiculo === 'moto' ? 'tu moto' : 'tu auto';
    return {
      messages: [
        {
          kind: 'text',
          body:
            `💰 Te ayudo a cotizar el seguro de ${noun}. ` +
            `Decime *marca, modelo, año* y *localidad o código postal*.\n` +
            'Escribí *menú* para volver al inicio.',
        },
      ],
    };
  }

  /**
   * The category to restart the quote with: the tapped category, or the one in
   * progress when the user asks to start over (null = unknown, show the list).
   * undefined when the message is not a restart.
   */
  private quoteRestartOption(
    state: FlowState,
    input: UserInput,
  ): string | null | undefined {
    if (input.selectionId) {
      return COTIZAR_LABEL[input.selectionId] ? input.selectionId : undefined;
    }
    if (!RESTART_QUOTE_RE.test(fold(input.text))) return undefined;
    if (state.data.vehiculo === 'auto') return OPT.cotAuto;
    if (state.data.vehiculo === 'moto') return OPT.cotMoto;
    return null;
  }

  private async restartCotizacion(
    opt: string | null,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const restarted = '🔄 Listo, empezamos de nuevo la cotización.';
    if (!opt) return this.prepend(restarted, this.showCotizarMenu(key));
    this.setState(key, 'COTIZAR_TIPO');
    return this.prepend(
      restarted,
      await this.handleCotizarTipo({ text: '', selectionId: opt }, ctx, key),
    );
  }

  /**
   * Whether a message says more than just which category to quote. A digit
   * (year, displacement) or any word beyond the request itself means there is a
   * brand/model in there worth passing to the model; "auto", "una moto" or
   * "quiero cotizar el auto" do not.
   */
  private carriesVehicleData(text: string): boolean {
    const t = fold(text);
    if (/\d/.test(t)) return true;
    return t.split(/[^a-z]+/).some((w) => w.length > 1 && !QUOTE_FILLER.has(w));
  }

  /**
   * Whether text with no category word still clearly describes a vehicle: a
   * model year or a brand that makes both cars and motos. Anything vaguer
   * ("un seguro de caución", "para mi empresa") keeps the category list — the
   * quote model only handles cars and motos.
   */
  private namesVehicle(text: string): boolean {
    const t = fold(text);
    return MODEL_YEAR_RE.test(t) || DUAL_BRAND_RE.test(t);
  }

  /** Keyword routing so typed text (not just taps) reaches a quote category. */
  private matchCotizarCategory(text: string): string | null {
    const t = text.toLowerCase();
    // Checked before auto/moto: a "monopatín eléctrico" must not be read as a
    // moto, and the category row is literally "Bici / Monopatín".
    if (/bici|bicicleta|mtb|rodado|monopat[ií]n|patineta/.test(t))
      return OPT.cotBici;
    if (/auto|coche|veh[ií]culo|camioneta|pick/.test(t)) return OPT.cotAuto;
    if (/moto|scooter|ciclomotor/.test(t)) return OPT.cotMoto;
    if (CAR_BRAND_RE.test(fold(text))) return OPT.cotAuto;
    if (MOTO_BRAND_RE.test(fold(text))) return OPT.cotMoto;
    if (/bolso|cartera|mochila|notebook|celular/.test(t)) return OPT.cotBolso;
    if (/comercio|local|negocio|industria|dep[oó]sito/.test(t))
      return OPT.cotComercio;
    if (/hogar|casa|departamento|vivienda|inmueble/.test(t))
      return OPT.cotHogar;
    if (/persona|vida|accidente|salud|sepelio/.test(t)) return OPT.cotPersonas;
    if (/praxis|profesional|matr[ií]cula|mala praxis/.test(t))
      return OPT.cotPraxis;
    return null;
  }

  private handleLlm(
    input: UserInput,
    key: string,
    handoff: 'cotizacion' | 'faq',
  ): FlowResult {
    // Keep the user in the LLM sub-flow; webhook.service runs the model for this
    // turn. "menú" / a topic change already exited earlier in handle().
    void key;
    void input;
    return { messages: [], handoff };
  }

  /**
   * Breaks the user out of a sticky LLM sub-flow when their message clearly
   * names a *different* flow. Without this the LLM_* states only release on the
   * literal words "menú"/"finalizar", so a user who finishes a cotización and
   * then asks for the grúa keeps getting answered by the quote model. Returns
   * the re-routed result, or null when the message is not a topic change (so
   * genuine quote data / FAQ questions stay with the model).
   */
  private detectFlowSwitch(
    step: FlowStep,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): FlowResult | Promise<FlowResult> | null {
    if (step !== 'LLM_COTIZACION' && step !== 'LLM_FAQ') return null;

    if (this.matchClientIntent(input.text) === OPT.bajaPoliza)
      return this.guard(ctx, key, 'baja_poliza', {}, input.text);
    const intent = this.matchGlobalIntent(input.text, step);
    if (!intent) return null;
    // "cotizar" is the cotización flow itself — not a topic change when we're
    // already in it (e.g. "quiero cotizar otro auto" stays with the model).
    if (step === 'LLM_COTIZACION' && intent === 'cotizar') return null;

    this.logger.log(
      `Cambio de flujo en ${step} → "${intent}"; vuelvo al menú determinístico`,
    );

    // Re-enter the menu for the branch the user already declared, so the matched
    // intent runs without bouncing a known client/lead back to "¿sos cliente?".
    const audience = this.audienceOf(key, ctx);
    if (audience === 'client') {
      this.setState(key, 'CLIENT_MENU', {}, 'client');
      return this.handleClientMenu(input, ctx, key);
    }
    if (audience === 'lead') {
      this.setState(key, 'LEAD_MENU', {}, 'lead');
      return this.handleLeadMenu(input, ctx, key);
    }
    // Audience still unknown (user never declared): the welcome menu asks.
    this.setState(key, 'ROOT');
    return this.handleRoot(input, ctx, key);
  }

  /**
   * Detects a clear top-level flow intent in free text, used only to break out
   * of a sticky LLM sub-flow on a topic change. Patterns are deliberately strong
   * (whole words, action verbs) so ordinary quote data and FAQ phrasing keep
   * being handled by the model; returns null when nothing transactional is named.
   */
  private matchGlobalIntent(
    text: string,
    step: FlowStep,
  ):
    | 'grua'
    | 'siniestro'
    | 'pago'
    | 'documentos'
    | 'asesor'
    | 'cotizar'
    | null {
    const t = fold(text);
    if (step === 'LLM_COTIZACION') return this.matchQuoteExit(t);
    if (/\bgrua\b|\bauxilio\b|\bremolque\b/.test(t)) return 'grua';
    if (
      /\bsiniestro\b|\bdenuncia\b|\bdenunciar\b|\bme chocaron\b|\bme robaron\b/.test(
        t,
      )
    )
      return 'siniestro';
    if (/\bpagar\b|\bpagos?\b|\bcuota\b|\bdeuda\b|\bvencimiento\b/.test(t))
      return 'pago';
    if (
      /\btarjeta\b|\bcertificad|\bcupon(?:es|era|eras)?\b|\bdocumentacion\b|\bdocumentos?\b/.test(
        t,
      )
    )
      return 'documentos';
    if (
      /\basesor\b|\brepresentante\b|\bhablar con (alguien|una persona|un asesor)\b/.test(
        t,
      )
    )
      return 'asesor';
    if (/\bcotizar\b|\bcotizacion\b|\bpresupuest/.test(t)) return 'cotizar';
    return null;
  }

  /**
   * Stricter version of `matchGlobalIntent` for the quote conversation, where
   * cuotas, pagos, tarjeta, grúa or robo are ordinary quote questions ("¿cuánto
   * sale la cuota?", "¿incluye grúa?"). Only an explicit request about the
   * user's own account, documents or a claim leaves the quote. `t` is folded.
   */
  private matchQuoteExit(
    t: string,
  ): ReturnType<FlowService['matchGlobalIntent']> {
    const asksAboutCoverage =
      /\b(incluye|incluyen|cubre|cubren|viene con|trae)\b/.test(t) ||
      /\bque (pasa|hago|sucede) si\b/.test(t) ||
      /\bsi (tengo|tuviera|tuviese|hay|me (roban|chocan|pasa))\b/.test(t) ||
      /\ben caso de\b/.test(t);
    if (!asksAboutCoverage) {
      if (/\bgrua\b|\bauxilio\b|\bremolque\b/.test(t)) return 'grua';
      if (
        /\bsiniestro\b|\bdenuncia\b|\bdenunciar\b|\bme (chocaron|robaron)\b/.test(
          t,
        )
      )
        return 'siniestro';
      if (
        /\b(mis?) (cuotas?|pagos?|deudas?|vencimientos?)\b|\bpagar (mi|mis)\b|\bestado de (cuenta|pagos?)\b|\bcuanto debo\b|\bdeuda\b|\bcupon(?:es)? de pago\b/.test(
          t,
        )
      )
        return 'pago';
      if (
        /\btarjeta (verde|de circulacion|del seguro)\b|\bcertificado de cobertura\b|\b(mis?) (polizas?|documentos?|documentacion|certificados?|cupon(es)?|cuponeras?)\b|\b(necesito|quiero|descargar|bajar|mandame|enviame|pasame) (la|el|mi|mis|los) (poliza|certificado|tarjeta|cupon|cupones|cuponera|documentacion)\b/.test(
          t,
        )
      )
        return 'documentos';
    }
    if (
      /^(un |el |al )?asesor\b/.test(t.trim()) ||
      /\b(hablar|comunic\w*|contact\w*|llam\w*|quiero|queria|necesito|pasame|pasas|derivame)\b.*\b(asesor|representante|humano|persona real)\b/.test(
        t,
      )
    )
      return 'asesor';
    if (/\bcotizar\b|\bcotizacion\b|\bpresupuest/.test(t)) return 'cotizar';
    return null;
  }

  // ─── Shared helpers ───────────────────────────────────────

  private normalizeGreeting(text: string): string {
    return text
      .trim()
      .toLocaleLowerCase('es-AR')
      .replace(/[\s!.,¡¿?]+$/g, '')
      .replace(/\s+/g, ' ');
  }

  private isRepeatedGreeting(state: FlowState, text: string): boolean {
    if (!MENU_STEPS.has(state.step)) return false;
    const previousText = state.data[LAST_GREETING_TEXT];
    const previousAt = state.data[LAST_GREETING_AT];
    return (
      typeof previousText === 'string' &&
      typeof previousAt === 'number' &&
      previousText === this.normalizeGreeting(text) &&
      Date.now() - previousAt <= GREETING_DEBOUNCE_MS
    );
  }

  /** Adds short-lived greeting metadata to the durable menu snapshot. */
  private rememberGreeting(
    key: string,
    text: string,
    result: FlowResult,
    shouldRemember: boolean,
  ): FlowResult {
    if (!shouldRemember) return result;
    const current = this.load(key)?.state;
    if (!current || !MENU_STEPS.has(current.step)) return result;
    this.setState(
      key,
      current.step,
      {
        ...current.data,
        [LAST_GREETING_TEXT]: this.normalizeGreeting(text),
        [LAST_GREETING_AT]: Date.now(),
      },
      current.audience,
    );
    return result;
  }

  /**
   * After a request is registered: the menu of a declared client or lead, or
   * nothing for someone who never said — "¿ya sos cliente nuestro?" right
   * after "¡Listo! Un asesor te contacta" read as starting over.
   */
  private menuAfterRequest(key: string, ctx: FlowContext): FlowResult {
    if (this.audienceOf(key, ctx)) return this.toMainMenu(key, ctx);
    this.setState(key, 'ROOT');
    return { messages: [] };
  }

  /**
   * A person from the office wrote here in the last days and the bot has not
   * said anything since: what the customer writes now goes on with that.
   */
  private answeringOffice(ctx: FlowContext): boolean {
    return (
      !ctx.botSpoke &&
      recentHumanReply(ctx.lastHumanReply, Date.now(), OFFICE_THREAD_MS)
    );
  }

  /**
   * Back to the menu of whoever they said they are, without sending it: the
   * reply already says what happens next.
   */
  private settleAfterRequest(key: string, ctx: FlowContext): OutgoingMessage[] {
    const audience = this.audienceOf(key, ctx);
    if (audience === 'client') {
      this.setState(key, 'CLIENT_MENU');
      return [clientMenu()];
    }
    if (audience === 'lead') {
      this.setState(key, 'LEAD_MENU');
      return [leadMenu()];
    }
    this.setState(key, 'ROOT');
    return [];
  }

  /**
   * The customer asks about something a person from the office was handling
   * in this chat in the last days. That person gets it with the customer's
   * words, and the customer hears so — instead of the DNI and "no tenés
   * denuncias" for a claim the office took by hand.
   */
  private async officeFollowUp(
    text: string,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    await this.api
      .requestHandoff(
        ctx.conversationId,
        text.trim()
          ? `Consulta sobre lo que venía viendo la oficina: "${clip(text.trim())}"`
          : undefined,
      )
      .catch(() => undefined);
    this.settleAfterRequest(key, ctx);
    return {
      messages: [
        {
          kind: 'text',
          body:
            `Le pasé tu consulta a la persona de la oficina que te venía atendiendo 🙌 Te responde por este chat (${attentionHoursOf(ctx.attentionHours)}).` +
            (await this.closedNote()) +
            '\n\nSi necesitás otra cosa, escribí *menú*.',
        },
      ],
    };
  }

  /**
   * A policy we don't have (accidentes personales, a nómina, another insurer, a
   * clause for a third party): the office gets the request as it was written.
   */
  private async officeOnlyRequest(
    text: string,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    await this.api
      .requestHandoff(
        ctx.conversationId,
        `Pedido sobre una póliza que el bot no tiene (accidentes personales, nómina u otra compañía): "${clip(text.trim())}"`,
      )
      .catch(() => undefined);
    const menu = this.settleAfterRequest(key, ctx);
    return {
      messages: [
        {
          kind: 'text',
          body:
            `Los seguros de accidentes personales, las nóminas y las pólizas de otras compañías los maneja directamente la oficina, así que ya le pasé tu pedido 🙌 Te responden por este chat (${attentionHoursOf(ctx.attentionHours)}).` +
            (await this.closedNote()),
        },
        ...menu,
      ],
    };
  }

  /** "Otra póliza" in a picker: the customer describes it and the office takes it. */
  private otherPoliza(input: UserInput, key: string): FlowResult | null {
    if (input.selectionId !== OTHER_POLIZA_ID) return null;
    this.setState(key, 'ASESOR_MOTIVO');
    return { messages: [otherPolizaPrompt()] };
  }

  /** "Cambiar forma de pago": the office asks for the card or CBU itself. */
  private async paymentChangeRequest(
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    await this.api
      .requestHandoff(
        ctx.conversationId,
        'Quiere cambiar la forma de pago (adherir tarjeta o CBU, o pasar a cupón).',
      )
      .catch(() => undefined);
    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body:
            `Listo, le pasé a la oficina tu pedido para cambiar la forma de pago 🙌 Te escriben por este chat para pedirte los datos de la tarjeta o el CBU (${attentionHoursOf(ctx.attentionHours)}).` +
            (await this.closedNote()),
        },
        clientMenu(),
      ],
    };
  }

  /**
   * "¿Hablo con Juan?" when the number writing is one client's phone in the
   * cartera, instead of asking for the DNI. Null when there is no such match
   * (or no usable first name, as with a company), so the caller asks as usual.
   */
  private askPhoneMatch(
    ctx: FlowContext,
    key: string,
    action: ClientAction,
    data: Record<string, unknown> = {},
    opener?: string | null,
  ): FlowResult | null {
    if (ctx.client) return null;
    const name = displayName(ctx.phoneMatch?.firstName);
    if (!name) return null;
    this.setState(key, 'IDENTIFY', {
      ...data,
      pendingAction: action,
      phoneConfirm: true,
    });
    return { messages: [phoneQuestion(name, opener)] };
  }

  private async confirmPhoneMatch(
    state: FlowState,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    try {
      await this.api.identifyByPhone(ctx.conversationId);
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : 0;
      if (status !== 404) throw error;
      return this.askDniInstead(
        state,
        key,
        'No pude confirmarlo con este número.',
      );
    }
    const action = (state.data.pendingAction as ClientAction) ?? 'menu';
    return this.prepend(
      '✅ ¡Listo, te identifiqué!',
      await this.runAction(action, ctx, key, {
        withDocs: state.data.pendingWithDocs === true,
        ...(typeof state.data.pendingQuestion === 'string'
          ? { question: state.data.pendingQuestion }
          : {}),
      }),
    );
  }

  private declinePhoneMatch(
    state: FlowState,
    ctx: FlowContext,
    key: string,
  ): FlowResult {
    // Answered to a greeting: they never said whether they are a client.
    if (state.data.fromGreeting) {
      this.setState(key, 'ROOT');
      return { messages: [welcomeMenu(undefined, ctx.botName, 'none')] };
    }
    return this.askDniInstead(state, key, 'Dale.');
  }

  private askDniInstead(
    state: FlowState,
    key: string,
    lead: string,
  ): FlowResult {
    this.setState(key, 'IDENTIFY', withoutPhoneQuestion(state.data));
    return {
      messages: [
        {
          kind: 'text',
          body: `${lead} Pasame el *DNI del titular* (o el *CUIT* si es una empresa) o la *patente* del vehículo asegurado.\n\n_Escribí *menú* para volver o *finalizar* para terminar._`,
        },
      ],
    };
  }

  private toMainMenu(key: string, ctx: FlowContext): FlowResult {
    // Respect the branch the user already declared so "menú" doesn't bounce a
    // known client/lead back to the "¿sos cliente?" question.
    const audience = this.audienceOf(key, ctx);
    if (audience === 'client') {
      this.setState(key, 'CLIENT_MENU', {}, 'client');
      return { messages: [clientMenu()] };
    }
    if (audience === 'lead') {
      this.setState(key, 'LEAD_MENU', {}, 'lead');
      return { messages: [leadMenu()] };
    }
    this.setState(key, 'ROOT');
    // Shown again later in the chat: the bot already introduced itself.
    return { messages: [welcomeMenu(undefined, ctx.botName, 'none')] };
  }

  /**
   * A claim the bot must not file on its own (no policy in force, or the policy
   * has a rejected / overdue payment). The chat goes to human attention with
   * the reason so an advisor reviews the case instead of the claim stalling.
   */
  private async siniestroBloqueado(
    key: string,
    ctx: FlowContext,
    reason: string,
    explanation: string,
  ): Promise<FlowResult> {
    await this.api
      .requestHandoff(ctx.conversationId, reason)
      .catch(() => undefined);
    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body:
            `⚠️ ${explanation}

` +
            `Ya le avisé a un asesor para que revise tu caso y te contacte a la brevedad (${attentionHoursOf(ctx.attentionHours)}).` +
            (await this.closedNote()),
        },
        clientMenu(),
      ],
    };
  }

  private noPolizas(key: string): FlowResult {
    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body: 'No encontré pólizas vigentes a tu nombre. Si creés que es un error, escribí *asesor* y te ayudamos.',
        },
        clientMenu(),
      ],
    };
  }

  private prepend(text: string, result: FlowResult): FlowResult {
    return {
      ...result,
      messages: [{ kind: 'text', body: text }, ...result.messages],
    };
  }

  private gruaText(): string {
    return this.towTruckPhone
      ? `🆘 *Auxilio / Grúa*\nLlamá directo al ${this.towTruckPhone}, disponible las 24 hs.`
      : '🆘 *Auxilio / Grúa*\nEstamos confirmando el número de asistencia. Mientras tanto, escribí *asesor* y te ayudamos.';
  }

  /** Maps a policy risk type to a siniestro tipo (auto/moto/hogar/otro). */
  private tipoFromRisk(riskType?: string): string {
    switch (riskType) {
      case 'auto':
        return 'auto';
      case 'moto':
        return 'moto';
      case 'home':
        return 'hogar';
      default:
        return 'otro';
    }
  }

  // ─── Intent / keyword helpers ─────────────────────────────

  /**
   * Detects clearly off-domain requests (programming, math, recipes, translations,
   * jokes, general trivia) so the bot refuses deterministically instead of
   * letting the LLM wander. A false positive throws away what the user was
   * doing, so only unambiguous *requests* count — never lone words that also
   * show up in insurance talk: "código" (postal, de seguridad), "integral"
   * (a coverage), "cuento" ("te cuento que…"), "receta" (médica), "capital de"
   * (suma asegurada), "quién es" (el titular), "función", "script", "node".
   * Anything this lets through is still refused by the LLM prompts.
   */
  private isOffTopic(text: string): boolean {
    const t = fold(text);
    return (
      // Programming: an unambiguous language name, or explicitly asking for code.
      /\b(javascript|typescript|python|kotlin|php|html|css|sql|powershell|hello world|console\.log)\b/.test(
        t,
      ) ||
      /\b(programar|programacion|algoritmo|compilar)\b/.test(t) ||
      /\b(escribi|escribime|hace|haceme|arma|armame|pasame|dame)( un| el| este)? (codigo|script|programa) (en|de|que|para)\b/.test(
        t,
      ) ||
      // Math / homework.
      /\b(ecuacion|ecuaciones|derivada|teorema|factoriza\w*)\b/.test(t) ||
      /\bresolve\w* (este|el|esta|la) (calculo|ejercicio|ecuacion)\b/.test(t) ||
      /\bcuanto (es|da) \d+ ?[-+x*/] ?\d+/.test(t) ||
      // Creative / general-assistant requests.
      /\breceta (de|para)\b|\bcomo (se )?cocina/.test(t) ||
      /\b(poema|poesia|chiste|ensayo)\b/.test(t) ||
      /\b(escribi|escribime|contame|inventa|inventame) (un|una) (cuento|historia|cancion)\b/.test(
        t,
      ) ||
      /\b(traduci|traducime|traducir|traduccion)\b/.test(t) ||
      // General trivia.
      /\bcual es la capital de\b|\bquien gano (el|la|los|las)\b/.test(t)
    );
  }

  /** Fixed refusal for off-domain messages + the current menu (no LLM, no cost). */
  private offTopicReply(key: string, ctx: FlowContext): FlowResult {
    const menu = this.toMainMenu(key, ctx);
    return {
      messages: [
        {
          kind: 'text',
          body: 'Disculpá, soy el asistente de *JPMG* y solo puedo ayudarte con *seguros* y trámites de la productora 🙂. ¿Te doy una mano con eso?',
        },
        ...menu.messages,
      ],
    };
  }

  /**
   * Detects a question about opening hours ("¿qué horario tienen?", "¿están
   * abiertos?", "¿a qué hora abren?", "¿atienden los sábados?"). A bare
   * "atienden"/"abren" is not enough — "¿atienden motos?" is about coverage —
   * so those verbs need a time word next to them. Misses fall through to the
   * LLM, which knows the attention hours from its prompt.
   */
  private isHoursQuestion(text: string): boolean {
    const t = fold(text);
    return (
      /\bhorarios?\b/.test(t) ||
      /\b(a|hasta|desde) que hora\b/.test(t) ||
      /\bque hora (abren|cierran|atienden|trabajan)\b/.test(t) ||
      /\bestan? (abiertos?|atendiendo)\b/.test(t) ||
      /\b(abren|cierran|atienden|trabajan) (hoy|manana|ahora|(los|el) (sabados?|domingos?|feriados?|fines? de semana))\b/.test(
        t,
      ) ||
      /\bque dias? (abren|atienden|trabajan)\b/.test(t)
    );
  }

  /** Steps where free text is the user's data — never hijack those for hours. */
  private isCapturingData(step: FlowStep): boolean {
    return (
      step === 'IDENTIFY' ||
      step === 'SINIESTRO_FECHA' ||
      step === 'SINIESTRO_DESC' ||
      step === 'SINIESTRO_HORA' ||
      step === 'SINIESTRO_LOCALIDAD' ||
      step === 'SINIESTRO_CALLE' ||
      step === 'SINIESTRO_ALTURA' ||
      step === 'ASESOR_MOTIVO' ||
      step === 'LEAD_CONTACT' ||
      step === 'COT_LEAD_FIELDS' ||
      step === 'COT_LEAD_NOMBRE' ||
      step === 'COT_LEAD_TELEFONO' ||
      step === 'SINIESTRO_FOTO_TARJETA' ||
      step === 'SINIESTRO_FOTO_CARNET' ||
      step === 'SINIESTRO_TERCERO' ||
      step === 'SINIESTRO_TERCERO_TARJETA' ||
      step === 'SINIESTRO_TERCERO_CARNET' ||
      step === 'SINIESTRO_FOTO_DANIO' ||
      step in LEAD_DOC_TIPO
    );
  }

  /** Deterministic hours answer (no LLM): the ready message from /public/hours. */
  private async answerHours(): Promise<FlowResult> {
    try {
      const status = await this.api.getHours();
      return { messages: [{ kind: 'text', body: status.message }] };
    } catch {
      return {
        messages: [
          {
            kind: 'text',
            body: 'Ahora no puedo consultar el horario. Si es urgente, escribí *asesor* y te ayudamos.',
          },
        ],
      };
    }
  }

  /**
   * Note appended when the bot promises human contact while the office is closed,
   * so it sets the right expectation ("te respondemos al reabrir"). Empty when
   * open or when the status can't be fetched.
   */
  private async closedNote(): Promise<string> {
    try {
      const status = await this.api.getHours();
      return status.closedNote ? `\n${status.closedNote}` : '';
    } catch {
      return '';
    }
  }

  /** Keyword routing so typed text (not just taps) reaches the right flow. */
  private matchClientIntent(text: string): string | null {
    const t = fold(text);
    if (
      !/\bno (?:quiero|deseo|necesito) (?:dar(?:me)? de baja|cancelar)\b/.test(
        t,
      ) &&
      /\bbaja\b|\bbajarme (?:del |de mi )?(?:seguro|poliza)\b|\bcancelar (mi |la |el )?(poliza|seguro)\b/.test(
        t,
      )
    )
      return OPT.bajaPoliza;
    // Quoting first: "cotizar un seguro contra robo" is a quote, not a claim.
    if (/cotiz|presupuest|seguro nuevo|\basegurar\b/.test(t))
      return OPT.cotizacion;
    // Whole-word robo/robaron: a bare "rob" matched "problema" and "aprobado".
    // "accidentes personales" is a product, not an accident.
    if (
      /siniestro|denuncia|choque|\bme chocaron\b|\brob(o|os|aron|ado|ada)\b|\baccidente(?!s? personal)/.test(
        t,
      )
    )
      return OPT.siniestros;
    if (/precio/.test(t)) return OPT.cotizacion;
    // Before pagos: "el cupón de pago" asks for the coupon, not the debt.
    if (CUPON_RE.test(t)) return OPT.cupones;
    if (/pago|cuota|deuda|debito|cobr|rechaz/.test(t)) return OPT.pagos;
    if (/document|poliza|tarjeta|certificado|cupon/.test(t))
      return OPT.documentos;
    if (/grua|auxilio|remolque|asistencia/.test(t)) return OPT.grua;
    if (/asesor|humano|\bpersona\b|hablar|representante/.test(t))
      return OPT.asesor;
    return null;
  }

  private matchLeadIntent(text: string): string | null {
    const t = text.toLowerCase();
    if (
      QUOTE_INTENT_RE.test(fold(text)) ||
      /\bcotiz|\bpresupuest|\bseguro|\bp[oó]liza|\bcobertura/.test(t)
    )
      return OPT.leadCotizar;
    if (
      /\bvendedor|\brepresentante|\bllam[ae]r?\b|\bcontactar|\bcomunic/.test(t)
    )
      return OPT.leadVendedor;
    if (/\bconsult|\bpregunt|\bduda|\binformaci[oó]n|\bsaber|\bayuda/.test(t))
      return OPT.leadConsultas;
    return null;
  }

  private matchSiniestroIntent(text: string): string | null {
    const t = fold(text);
    // Following one up wins over the words of the incident itself: "el estado
    // de mi denuncia" used to start a new claim.
    if (
      /\bconsultar|\bestado\b|\bseguimiento|\bcomo (?:va|sigue)\b|\bya ten[i]a|\bnovedad|\bya (?:esta|estan|fue|la) (?:hecha|hecho|cargada|cargado|presentada|ingresada|hicieron|cargaron|presentaron)|\bse (?:hizo|cargo|presento|ingreso)\b|\bque paso con\b/.test(
        t,
      )
    )
      return OPT.sinConsultar;
    if (NEW_INCIDENT_RE.test(t)) return OPT.sinNueva;
    if (/\bver\b|\bmis\b|\btengo\b/.test(t)) return OPT.sinConsultar;
    return null;
  }

  /**
   * Tries to identify a policy from free text by plate, vehicle brand/model
   * name, or risk-type keyword. Only returns a single unambiguous match.
   */
  private matchPolizaByText(
    text: string,
    polizas: PolizaSummary[],
  ): PolizaSummary | null {
    const t = text.toLowerCase();

    for (const p of polizas) {
      const dom = p.vehicle?.licensePlate;
      if (dom && t.includes(dom.toLowerCase())) return p;
    }

    for (const p of polizas) {
      const v = p.vehicle;
      if (!v) continue;
      const terms = [v.brand, v.model]
        .filter(Boolean)
        .map((s) => s!.toLowerCase());
      if (terms.some((term) => term.length > 2 && t.includes(term))) return p;
    }

    let riskKeyword: string | null = null;
    if (/\bauto\b|\bcoche\b|\bveh[ií]culo\b/.test(t)) riskKeyword = 'auto';
    else if (/\bmoto\b|\bscooter\b/.test(t)) riskKeyword = 'moto';
    else if (/\bhogar\b|\bcasa\b|\bdepartamento\b|\bvivienda\b/.test(t))
      riskKeyword = 'home';
    else if (/\bcomercio\b|\blocal\b|\bnegocio\b/.test(t))
      riskKeyword = 'comercio';
    else if (/\bbici\b/.test(t)) riskKeyword = 'bici';

    if (riskKeyword) {
      const matches = polizas.filter((p) => p.riskType === riskKeyword);
      if (matches.length === 1) return matches[0];
    }

    return null;
  }

  /**
   * Tries to identify a document from free text using significant words from
   * its name (e.g. "tarjeta" matches "Tarjeta de circulación").
   */
  private matchDocByText(
    text: string,
    docs: { code: string; name: string; url: string }[],
  ): string | null {
    const t = text.toLowerCase();
    for (const doc of docs) {
      const words = doc.name
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 4);
      if (words.length > 0 && words.some((w) => t.includes(w))) return doc.code;
    }
    return null;
  }

  /** Detects yes/no intent for button-only confirmation screens. */
  private matchConfirmIntent(text: string): string | null {
    const t = text.toLowerCase().trim();
    if (
      /^(s[ií]|dale|ok|listo|confirm[ao]|adelante|correcto|exacto|v[aá]|bueno)$/.test(
        t,
      ) ||
      /^s[ií][,\s]|^dale[,\s]/.test(t)
    )
      return OPT.confirmar;
    if (
      /^(no|cancel[ao]|salir|olvid[aá]|para|paro)$/.test(t) ||
      /^no[,\s]|^cancel/.test(t)
    )
      return OPT.cancelar;
    return null;
  }

  private parsePrefId(
    selectionId: string | undefined,
    prefix: string,
  ): number | null {
    if (!selectionId || !selectionId.startsWith(prefix)) return null;
    const n = Number(selectionId.slice(prefix.length));
    return Number.isInteger(n) ? n : null;
  }

  private parseStringRef(
    selectionId: string | undefined,
    prefix: string,
  ): string | null {
    if (!selectionId || !selectionId.startsWith(prefix)) return null;
    return selectionId.slice(prefix.length);
  }

  private errMsg(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as
        | { message?: string | string[] }
        | undefined;
      const msg = Array.isArray(data?.message)
        ? data.message.join('; ')
        : data?.message;
      return msg ?? error.message;
    }
    return (error as Error).message;
  }

  // ─── State store ──────────────────────────────────────────

  private load(key: string): { state: FlowState } | undefined {
    return this.states.get(key);
  }

  private setState(
    key: string,
    step: FlowStep,
    data: Record<string, unknown> = {},
    audience?: 'client' | 'lead',
  ): void {
    // Carry the declared audience forward unless this call sets a new one, so it
    // survives every step transition without having to be threaded explicitly.
    const prev = this.states.get(key)?.state;
    // Moving on means the user was understood: the retry counter belongs to the
    // step we're leaving, and several handlers spread `...state.data` forward.
    const next = { ...data };
    if (prev?.step !== step) delete next[RETRIES];
    this.states.set(key, {
      state: { step, data: next, audience: audience ?? prev?.audience },
    });
  }

  /**
   * Re-asks the current step, counting the attempt. On the second consecutive
   * miss it stops repeating and offers the escape buttons instead — the step is
   * kept, so a user who ignores them and answers properly still moves on.
   */
  private retry(
    key: string,
    state: FlowState,
    messages: OutgoingMessage[],
  ): FlowResult {
    const attempts = ((state.data[RETRIES] as number | undefined) ?? 0) + 1;
    this.setState(
      key,
      state.step,
      { ...state.data, [RETRIES]: attempts },
      state.audience,
    );
    return { messages: attempts >= MAX_RETRIES ? [stuckMenu()] : messages };
  }

  /**
   * Whether the user should be treated as a client or a lead: a DB-identified
   * client always counts as 'client'; otherwise we use the branch they declared
   * earlier ("Sí, soy cliente" / "Todavía no"), persisted in the flow state.
   */
  private audienceOf(
    key: string,
    ctx: FlowContext,
  ): 'client' | 'lead' | undefined {
    if (ctx.client) return 'client';
    return this.load(key)?.state.audience;
  }
}
