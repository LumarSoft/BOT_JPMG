import {
  IdentificationInterpreter,
  type IdentificationAction,
} from './identification-interpreter.service';
import { bareIdentification, identificationFromText } from './identification';
import {
  IntentInterpreter,
  type OpeningIntent,
} from './intent-interpreter.service';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ApiService } from '../../api/api.service';
import type {
  EstadoCuentaPoliza,
  PolizaDocumento,
  PolizaSummary,
} from '../../api/api.types';
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
  BAJA_MOTIVO_OTRO_ID,
  bajaCheck,
  bajaMotivoLabels,
  bajaMotivoPicker,
  LEAD_MENU_OPTS,
  claimPhotoAddedText,
  vehiclePhotoAddedText,
  clientMenu,
  CLIENT_MENU_OPTS,
  cotizarMenu,
  DEBIT_FAILED_RE,
  debitNotDone,
  transferOffer,
  type TransferInfo,
  CLAIM_COPY_ID,
  CLAIM_COPY_RE,
  CLAIMS_PHONE_RE,
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
  ALL_DOCS_ID,
  docPicker,
  DOC_PREFIX,
  FIELD_OPT_PREFIX,
  fieldPrompt,
  fieldSelectPicker,
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
  claimOrAdvisorButtons,
  coverageSummary,
  toWhatsAppMarkdown,
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
import {
  attentionHoursOf,
  TRIUNFO_CLAIMS_PHONE,
  TRIUNFO_TRANSFER,
} from '../constants/business';
import { isCloser, recentHumanReply } from '../closers';
import { fold } from '../text';
import { SiniestroExtractor } from './siniestro-extractor.service';
import {
  CoverageAnswerer,
  hasCoverageFacts,
} from './coverage-answerer.service';
import {
  BIEN_DATOS_VACIOS,
  BIEN_TIPO_LABEL,
  SINIESTRO_DATOS_VACIOS,
  bienChecklist,
  bienDescripcion,
  bienTipoLabel,
  matchBienDanio,
  matchBienTipo,
  mergeBienDatos,
  mergeDatos,
  pendientes,
  pendientesBien,
  siniestroChecklist,
  siniestroDescripcion,
  siniestroFaltantes,
  type BienCampo,
  type BienDanio,
  type BienDatos,
  type BienTipo,
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

/** "La constancia de pago": a policy document, not the account status. Folded. */
const PAYMENT_CERTIFICATE_RE = /\b(?:constancia|certificado) de pago\b/;

/** Triunfo codes of the documents the bot asks for by name (see the API's document-types). */
const DOC_CODE = {
  tarjeta: '1050',
  certificado: '1000',
  constancia: '1040',
  cuponera: '1060',
  poliza: '1020',
} as const;

/** Documents a customer names ("la tarjeta verde", "la constancia de pago"). */
function wantedDocs(text: string | undefined): string[] {
  const t = fold(text ?? '');
  const codes: string[] = [];
  if (/\btarjeta\b|\btarjetita\b|\bmercosur\b/.test(t))
    codes.push(DOC_CODE.tarjeta);
  if (/\bcertificado\b(?! de pago)|\bconstancia de cobertura\b/.test(t))
    codes.push(DOC_CODE.certificado);
  if (PAYMENT_CERTIFICATE_RE.test(t)) codes.push(DOC_CODE.constancia);
  if (/\bpoliza (?:completa|en pdf)\b|\bpdf de (?:la|mi) poliza\b/.test(t))
    codes.push(DOC_CODE.poliza);
  return codes;
}

/** How the customer calls each document, to ask "¿De qué póliza querés la tarjeta verde?". */
const DOC_SPOKEN: Record<string, string> = {
  [DOC_CODE.tarjeta]: 'la tarjeta verde',
  [DOC_CODE.certificado]: 'el certificado de cobertura',
  [DOC_CODE.constancia]: 'la constancia de pago',
  [DOC_CODE.poliza]: 'la póliza',
};

/**
 * "Quiero de otra póliza", "es de otra patente": not the policy on screen.
 * Folded. "Quiero de otra poliza" used to send the Póliza PDF of the same one.
 */
const OTHER_POLICY_RE =
  /\botr[ao]s? (?:poliza|patente|auto|vehiculo|moto|camioneta|seguro|dominio|riesgo)\b|\bde otr[ao]\b|\bno es (?:esa|ese|esta|este)\b/;

/** ["A", "B", "C"] → "A, B y C". */
function joinNames(names: string[]): string {
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`
    : (names[0] ?? '');
}

/** Policy papers asked for together with the coupons. Folded text. */
/** A payment receipt being sent, or a payment that did not register. Folded. */
const PAYMENT_PROOF_RE =
  /\b(ya pague|(?:envio|adjunto|mando|paso|te (?:mando|paso|envio)|aca (?:esta|va|tenes)|este es|es) (?:el |un |mi )?comprobante|comprobante (?:de (?:la )?(?:pago|transferencia))|no (?:se )?(?:acredito|acredita) (?:mi |el )?pago)\b/;

/**
 * A payment talked about right after a photo or a file: "Pago de septiembre de
 * la patente…" with the receipt above. Folded. The bot showed the account
 * status and the office applied the payment three days later (#86, 16/10).
 */
const PAID_RE =
  /\b(?:pago|pague|pagado|pagamos|abone|abonado|abono|transferi|transferencia|deposite|deposito|comprobante|recibo)\b/;

/** Asking how or where to pay is not a receipt. Folded. */
const HOW_TO_PAY_RE = /\?|\b(?:como|donde|cuando|cuanto|puedo|tengo que)\b/;

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

/** "Ya soy cliente", "soy cliente", "tengo póliza con ustedes". Folded text. */
const SAYS_CLIENT_RE =
  /^(?:(?:si|ya|pero)[, ]+)?(?:ya )?soy cliente\b|\b(?:tengo|tenemos) (?:la |mi |una )?(?:poliza|seguro) con ustedes\b/;

/** What "Otra póliza" was picked for, worded so the office files it right. */
const OTHER_POLIZA_REQUEST: Partial<Record<FlowStep, string>> = {
  BAJA_POLIZA: 'Quiere dar de baja otra póliza',
  BAJA_CONFIRM: 'Quiere dar de baja otra póliza',
  DOC_POLIZA: 'Pide la documentación de otra póliza',
  CUPON_POLIZA: 'Pide los cupones de pago de otra póliza',
};

/** Selection ids of the home / shop claim pickers. */
const BIEN_TIPO_PREFIX = 'bt_';
const BIEN_DANIO_PREFIX = 'bd_';

/** Auto and moto claims ask about the road; everything else is a "bien". */
function isVehiclePolicy(p: PolizaSummary): boolean {
  return p.riskType === 'auto' || p.riskType === 'moto';
}

function bienTipoPicker(
  poliza: PolizaSummary | undefined,
  body?: string,
): OutgoingMessage {
  return {
    kind: 'list',
    body:
      body ??
      `¿Qué pasó${poliza ? ` en tu ${polizaLabel(poliza).toLowerCase()}` : ''}? Elegí el tipo de siniestro:`,
    button: 'Elegir tipo',
    rows: [
      { id: `${BIEN_TIPO_PREFIX}robo`, title: BIEN_TIPO_LABEL.robo },
      { id: `${BIEN_TIPO_PREFIX}incendio`, title: BIEN_TIPO_LABEL.incendio },
      {
        id: `${BIEN_TIPO_PREFIX}danios`,
        title: BIEN_TIPO_LABEL.danios,
        description: 'Cristales, electrodomésticos o la propiedad',
      },
      {
        id: `${BIEN_TIPO_PREFIX}responsabilidad_civil`,
        title: BIEN_TIPO_LABEL.responsabilidad_civil,
        description: 'Daños a un tercero',
      },
    ],
  };
}

function bienDanioButtons(body = '¿Qué se dañó?'): OutgoingMessage {
  return {
    kind: 'buttons',
    body,
    buttons: [
      { id: `${BIEN_DANIO_PREFIX}cristales`, title: 'Cristales' },
      {
        id: `${BIEN_DANIO_PREFIX}electrodomesticos`,
        title: 'Electrodomésticos',
      },
      { id: `${BIEN_DANIO_PREFIX}propiedad`, title: 'La propiedad' },
    ],
  };
}

/**
 * Steps with something filled in that a bare greeting must not throw away. The
 * pickers that start a flow are left out: nothing is lost going back there.
 */
const IN_PROGRESS_STEPS = new Set<FlowStep>([
  'SINIESTRO_DATOS',
  'SINIESTRO_BIEN_DANIO',
  'SINIESTRO_BIEN_DATOS',
  'SINIESTRO_DOMICILIO',
  'SINIESTRO_FECHA',
  'SINIESTRO_DESC',
  'SINIESTRO_HORA',
  'SINIESTRO_LOCALIDAD',
  'SINIESTRO_CALLE',
  'SINIESTRO_ALTURA',
  'SINIESTRO_CONFIRM',
  'SINIESTRO_FOTO_TARJETA',
  'SINIESTRO_FOTO_TARJETA_DORSO',
  'SINIESTRO_FOTO_CARNET',
  'SINIESTRO_FOTO_CARNET_DORSO',
  'SINIESTRO_TERCERO',
  'SINIESTRO_TERCERO_TARJETA',
  'SINIESTRO_TERCERO_TARJETA_DORSO',
  'SINIESTRO_TERCERO_CARNET',
  'SINIESTRO_TERCERO_CARNET_DORSO',
  'SINIESTRO_FOTO_DANIO',
  'BAJA_CONFIRM',
  'BAJA_MOTIVO',
  'COT_LEAD_FIELDS',
  'COT_LEAD_NOMBRE',
  'COT_LEAD_TELEFONO',
  'COT_DOC_DNI_FRENTE',
  'COT_DOC_DNI_DORSO',
  'COT_DOC_CERO_KM',
  'COT_DOC_TARJETA_AZUL',
  'COT_DOC_NO_RODAMIENTO',
  'COT_DOC_FOTOS_VEHICULO',
  'COT_DOC_TARJETA_GNC',
]);

/**
 * What the customer was doing at a step, for the office ("Venía con la
 * denuncia del siniestro") and for picking up where they left off. Null where
 * there is nothing in progress.
 */
export function stepTopic(step: FlowStep): string | null {
  if (step === 'SINIESTRO_TYPE') return 'siniestros';
  if (step.startsWith('SINIESTRO_')) return 'la denuncia del siniestro';
  if (step.startsWith('BAJA_')) return 'el pedido de baja';
  if (step.startsWith('DOC_')) return 'el pedido de documentación';
  if (step === 'CUPON_POLIZA') return 'el pedido de cupones de pago';
  if (step.startsWith('COT_DOC_'))
    return 'los documentos para contratar el seguro';
  if (
    step === 'COTIZAR_TIPO' ||
    step === 'LLM_COTIZACION' ||
    step.startsWith('COT_')
  )
    return 'la cotización';
  return null;
}

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
 * Asking about one's own debt or installments ("¿cuánto debo de mi seguro?",
 * "mis cuotas"). Wins over the loose "cuánto…seguro" quote match, which used
 * to open Cotización for it. "¿Cuánto sale la cuota?" is still a quote.
 * Folded text.
 */
const OWN_DEBT_RE =
  /\b(cuanto|lo que) (debo|adeudo|tengo que pagar|me falta pagar)\b|\bdeuda\b|\badeud|\b(mis?) (cuotas?|pagos?|vencimientos?)\b|\bestado de (cuenta|pagos?)\b|\bpagar (mi|mis)\b/;

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
  SINIESTRO_FOTO_TARJETA_DORSO: 'tarjeta_verde_dorso',
  SINIESTRO_FOTO_CARNET: 'carnet',
  SINIESTRO_FOTO_CARNET_DORSO: 'carnet_dorso',
  SINIESTRO_TERCERO_TARJETA: 'tarjeta_verde_tercero',
  SINIESTRO_TERCERO_TARJETA_DORSO: 'tarjeta_verde_tercero_dorso',
  SINIESTRO_TERCERO_CARNET: 'carnet_tercero',
  SINIESTRO_TERCERO_CARNET_DORSO: 'carnet_tercero_dorso',
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
  | 'baja_poliza'
  | 'cobertura';

/** Extra details of the request that started a client action. */
interface ActionOptions {
  /** Coupons asked for together with the policy papers ("cupón y póliza"). */
  withDocs?: boolean;
  /** What the customer wrote to ask for it, answered along with the data. */
  question?: string;
  /** Documents named in the request (Triunfo codes), sent without a picker. */
  docs?: string[];
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
  /** The company's claims line, given when someone asks for it. */
  private readonly claimsPhone?: string;
  /** Where a customer can transfer an installment (empty = not offered). */
  private readonly transfer: TransferInfo;

  constructor(
    private readonly api: ApiService,
    config: ConfigService,
    private readonly extractor: SiniestroExtractor,
    private readonly identification: IdentificationInterpreter,
    private readonly intents: IntentInterpreter,
    private readonly coverage: CoverageAnswerer,
  ) {
    this.towTruckPhone = config.get<string>('TOW_TRUCK_PHONE')?.trim();
    this.claimsPhone =
      config.get<string>('CLAIMS_PHONE')?.trim() || TRIUNFO_CLAIMS_PHONE;
    const setting = (name: string) =>
      config.get<string>(name)?.trim() || undefined;
    this.transfer = {
      alias: setting('TRANSFER_ALIAS') ?? TRIUNFO_TRANSFER.alias,
      cbu: setting('TRANSFER_CBU') ?? TRIUNFO_TRANSFER.cbu,
      holder: setting('TRANSFER_HOLDER') ?? TRIUNFO_TRANSFER.holder,
      bank: setting('TRANSFER_BANK') ?? TRIUNFO_TRANSFER.bank,
    };
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
    if (
      !sel &&
      PAID_RE.test(fold(input.text)) &&
      !HOW_TO_PAY_RE.test(fold(input.text)) &&
      this.sentFileJustBefore(ctx)
    )
      return this.paymentProof(input.text, ctx, key);
    // The model read a request only the office can do ("agregar a una persona
    // a la póliza"): it reaches the office with what was asked. It used to
    // answer "tocá *Hablar con un asesor*", one more step for the customer.
    if (sel === OPT.pedidoOficina) {
      const current = existing?.state;
      // Asked mid-quote ("¿por mi trabajo tengo descuento?"): the office hears
      // it and the quote goes on where it was.
      if (current && QUOTE_STEPS.has(current.step)) {
        await this.api
          .requestHandoff(ctx.conversationId, input.text)
          .catch(() => undefined);
        return {
          messages: [
            {
              kind: 'text',
              body:
                `Le pasé tu consulta a la oficina ✍️ Un asesor te responde por este chat (${attentionHoursOf(ctx.attentionHours)}).` +
                (await this.closedNote()) +
                '\n\nMientras, si querés, seguimos con la cotización.',
            },
          ],
        };
      }
      if (!(current?.step === 'ASESOR_MOTIVO' && current.data.alerted === true))
        this.backToMenuState(key, ctx);
      return this.handleAsesorMotivo({ text: input.text }, ctx, key);
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
    if (sel === OPT.stuckAsesor) return this.startAdvisor(ctx, key);

    // A menu option tapped from a menu still on screen (or shown under a
    // model's answer) is what the customer wants now, whatever step this is.
    const step = existing.state.step;
    const advisorAlerted =
      step === 'ASESOR_MOTIVO' && existing.state.data.alerted === true;
    if (
      sel &&
      (CLIENT_MENU_OPTS.has(sel) || sel === OPT.bajaNo) &&
      step !== 'CLIENT_MENU' &&
      !advisorAlerted
    ) {
      this.setState(key, 'CLIENT_MENU');
      return this.handleClientMenu(input, ctx, key);
    }
    if (
      sel &&
      LEAD_MENU_OPTS.has(sel) &&
      step !== 'LEAD_MENU' &&
      step !== 'ROOT' &&
      !advisorAlerted
    ) {
      this.setState(key, 'LEAD_MENU');
      return this.handleLeadMenu(input, ctx, key);
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

    // "Asesor" works from any step, like "menú": with the claim buttons on
    // screen it got "decime si es una denuncia nueva…" again.
    if (
      !sel &&
      existing.state.step !== 'ASESOR_MOTIVO' &&
      existing.state.step !== 'LEAD_CONTACT' &&
      ADVISOR_RE.test(fold(input.text).trim())
    )
      return this.advisorRequest(input, ctx, key);

    // A standalone greeting mid-session means "take me back to the menu", not a
    // FAQ chat — deterministic and free, and honoring the declared audience.
    // A repeated copy sent within a few seconds while the menu is already open
    // is recorded by the webhook but intentionally receives no second reply.
    // Skipped for taps (selectionId) since those are never typed greetings.
    if (!sel && GREETING_RE.test(input.text.trim())) {
      // Halfway through a claim, a cancellation or the papers for a policy, a
      // "Buenas" before the answer used to throw away what was filled in.
      const topic = stepTopic(existing.state.step);
      if (topic && IN_PROGRESS_STEPS.has(existing.state.step))
        return {
          messages: [
            {
              kind: 'text',
              body: `¡Hola! 👋 Seguimos con ${topic} donde lo dejamos. Si querés empezar de nuevo, escribí *menú*.`,
            },
          ],
        };
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
      const hello = returningGreeting(ctx.client.firstName, ctx.contactName);
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
    // Only a plate or a DNI ("ZZX987"): who they are, so identify them.
    const typedId = sel ? null : bareIdentification(input.text);
    if (typedId)
      return this.withOpener(
        opener,
        await this.identifyTyped(typedId, ctx, key),
      );
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
      case 'BAJA_MOTIVO':
        return this.handleBajaMotivo(state, input, ctx, key);
      case 'SINIESTRO_TYPE':
        return this.handleSiniestroType(state, input, ctx, key);
      case 'COBERTURA_POLIZA':
        return this.handleCoberturaPoliza(state, input, ctx, key);
      case 'SINIESTRO_POLIZA':
        return this.handleSiniestroPoliza(state, input, ctx, key);
      case 'SINIESTRO_DATOS':
        return this.handleSiniestroDatos(state, input, ctx, key);
      case 'SINIESTRO_BIEN_TIPO':
        return this.handleSiniestroBienTipo(state, input, ctx, key);
      case 'SINIESTRO_BIEN_DANIO':
        return this.handleSiniestroBienDanio(state, input, ctx, key);
      case 'SINIESTRO_BIEN_DATOS':
        return this.handleSiniestroBienDatos(state, input, ctx, key);
      case 'SINIESTRO_FECHA':
        return this.handleSiniestroFecha(state, input, key);
      case 'SINIESTRO_DESC':
        return this.handleSiniestroDesc(state, input, key);
      case 'SINIESTRO_HORA':
      case 'SINIESTRO_LOCALIDAD':
      case 'SINIESTRO_CALLE':
      case 'SINIESTRO_ALTURA':
      case 'SINIESTRO_DOMICILIO':
        return this.handleSiniestroDetalle(state, input, key);
      case 'SINIESTRO_CONFIRM':
        return this.handleSiniestroConfirm(state, input, ctx, key);
      case 'SINIESTRO_FOTO_TARJETA':
        return this.handleSinFotoTarjeta(input, key);
      case 'SINIESTRO_FOTO_TARJETA_DORSO':
        return this.handleSinFotoTarjetaDorso(input, key);
      case 'SINIESTRO_FOTO_CARNET_DORSO':
        return this.handleSinFotoCarnetDorso(input, key);
      case 'SINIESTRO_TERCERO_TARJETA_DORSO':
        return this.handleSinTerceroTarjetaDorso(input, key);
      case 'SINIESTRO_TERCERO_CARNET_DORSO':
        return this.handleSinTerceroCarnetDorso(input, key);
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
        return this.handleDocType(state, input, ctx, key);
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

  /**
   * "Sí, soy cliente": identify up front instead of on the first action that
   * needs it, so every request (an advisor handoff included) reaches the
   * admin tied to the client and its producer code.
   */
  private startClientIdentification(ctx: FlowContext, key: string): FlowResult {
    if (ctx.client) {
      this.setState(key, 'CLIENT_MENU', {}, 'client');
      return { messages: [clientMenu()] };
    }
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

  private async handleRoot(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const t = input.text.toLowerCase();
    const sel = input.selectionId;

    // A plate or DNI typed as the answer to "¿ya sos cliente?" says yes and
    // who: it got the menu, and "¿Hablo con…?" again on the next request.
    const typedId = sel ? null : bareIdentification(input.text);
    if (typedId && !ctx.client) return this.identifyTyped(typedId, ctx, key);

    // ── 1. Client / non-client identification ────────────────
    const isClient =
      sel === OPT.cliente ||
      ((/\b(soy|ya soy|s[ií] soy)\b/.test(t) ||
        /\b(tengo|tenemos)\b.*\b(p[oó]liza|seguro|cobertura)\b/.test(t)) &&
        !/\bno\b/.test(t)) ||
      (/\bcliente\b/.test(t) && !/\bno\b/.test(t));

    // "No, gracias" to "¿algo más?" is a goodbye, not "no soy cliente": it
    // used to leave a client in the non-client menu.
    const closing =
      !sel && isCloser(input.text) && /\b(gracias|nada|todo)\b/.test(fold(t));
    if (closing)
      return {
        messages: [
          {
            kind: 'text',
            body: '¡Gracias a vos! 🙌 Cuando necesites algo, escribime por acá.',
          },
        ],
      };

    const isLead =
      sel === OPT.noCliente ||
      /^(no|todav[ií]a no|a[uú]n no|recién|recien)\b/.test(t) ||
      /\bno\b.*\bcliente\b/.test(t);

    if (isClient) return this.startClientIdentification(ctx, key);
    if (isLead) {
      this.setState(key, 'LEAD_MENU', {}, 'lead');
      return { messages: [leadMenu()] };
    }

    // ── 2. Direct intent routing (before asking client/non-client) ──
    // A question about their own debt is a client's request, not a quote,
    // even when it says "cuánto… seguro".
    const folded = fold(input.text);
    if (
      !sel &&
      OWN_DEBT_RE.test(folded) &&
      !/\bcotiz|\bpresupuest/.test(folded)
    ) {
      const routed = await this.routeOpening(input, ctx, key, null, 'pagos');
      if (routed) return routed;
    }

    // Cotizar doesn't need identification → go straight to the quote flow
    // (jumping to the named category when the message already specifies one).
    if (
      QUOTE_INTENT_RE.test(folded) ||
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
    /** Already read by the caller, to avoid a second call to the model. */
    known?: OpeningIntent | null,
  ): Promise<FlowResult | null> {
    if (isGreetingOnly(input.text)) return null;
    // Written right after a person from the office wrote here (nothing from
    // the bot since): it goes on with that, to that person, instead of
    // opening a flow of its own. "¿Este no se realizó por débito?" about the
    // coupon the office had just sent got the account status (#242). The tow
    // truck is the one thing that can't wait for the office.
    if (
      this.answeringOffice(ctx) &&
      !/\bgrua\b|\bauxilio\b|\bremolque\b/.test(fold(input.text))
    ) {
      // In the last hours the person is still at it: the chat is flagged and
      // the bot keeps quiet while the office is open. Days later, the
      // customer hears that it was passed on.
      if (ctx.answeringPerson) {
        const followed = await this.personFollowUp(input, ctx, key);
        if (followed) return followed;
      }
      return this.withOpener(
        opener,
        await this.officeFollowUp(input.text, ctx, key),
      );
    }
    const intent =
      known !== undefined ? known : await this.readIntent(input, ctx);
    if (
      intent &&
      !['saludo', 'cotizar', 'siniestro', 'grua'].includes(intent) &&
      OFFICE_ONLY_POLICY_RE.test(fold(input.text))
    )
      return this.withOpener(
        opener,
        await this.officeOnlyRequest(input.text, ctx, key),
      );
    const said = fold(input.text);
    if (CLAIM_COPY_RE.test(said))
      return this.withOpener(
        opener,
        await this.claimCopyRequest(input.text, ctx, key),
      );
    if (CLAIMS_PHONE_RE.test(said))
      return this.withOpener(opener, this.claimsPhoneReply(key));
    switch (intent) {
      case null:
      case 'saludo':
        return null;
      case 'cotizar': {
        // A client asking for "una póliza" / "otra póliza con otro DNI" wants
        // the paper of one they have, not a new quote (#87, #201).
        if (this.asksForPolicyPaper(input.text, ctx, key))
          return this.withOpener(
            opener,
            await this.guardAsClient(ctx, key, 'documentos', {}, input.text),
          );
        const result = await this.enterCotizar(input, ctx, key);
        return result.handoff ? result : this.withOpener(opener, result);
      }
      case 'cobertura':
        // "¿Tengo cubiertos los cristales?" is answered from the policy, not
        // with the claim checklist (#87 asked four times).
        return this.withOpener(
          opener,
          await this.guardAsClient(ctx, key, 'cobertura', {}, input.text),
        );
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
            : PAYMENT_CERTIFICATE_RE.test(t)
              ? 'documentos'
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
        // Only when they say it: "necesito el descuento de la cuota" was read
        // as a cancellation and the customer got lost ("¿quién sos?").
        if (this.matchClientIntent(input.text) !== OPT.bajaPoliza) {
          const current = this.load(key)?.state;
          this.setState(key, 'CLIENT_MENU', {}, current?.audience ?? 'client');
          return this.withOpener(opener, { messages: [bajaCheck()] });
        }
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
      case 'tramite':
        // Only the office can do it: it gets the request as written. The
        // menu used to send "cambiar la orden de parabrisas" to a new claim.
        if (this.load(key)?.state.step !== 'ASESOR_MOTIVO')
          this.backToMenuState(key, ctx);
        return this.withOpener(
          opener,
          await this.handleAsesorMotivo(input, ctx, key),
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
   * "Quiero una póliza", "necesito otra póliza con otro DNI" from a client:
   * the paper of a policy, read as a quote by the model. Someone who never
   * said they are a client may well want a new one, so only for clients.
   */
  private asksForPolicyPaper(
    text: string,
    ctx: FlowContext,
    key: string,
  ): boolean {
    const t = fold(text);
    const client = !!ctx.client || this.load(key)?.state.audience === 'client';
    return (
      client &&
      /\b(?:polizas?|patente|dominio|papeles)\b/.test(t) &&
      !QUOTE_INTENT_RE.test(t) &&
      !/\b(?:nueva|contratar|sacar|hacer|cuanto|precio)\b/.test(t)
    );
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

  /**
   * The client action a request reads as, when it needs the client
   * identified (their payments, papers, coupons, a claim, a cancellation).
   * Null for anything else, which needs no identification.
   */
  private clientActionFor(
    intent: OpeningIntent,
    text: string,
  ): { action: ClientAction; withDocs: boolean } | null {
    const t = fold(text);
    switch (intent) {
      case 'siniestro': {
        const opt = this.matchSiniestroIntent(text);
        if (!opt) return null;
        return {
          action:
            opt === OPT.sinNueva ? 'siniestro_nueva' : 'siniestro_consultar',
          withDocs: false,
        };
      }
      case 'documentos':
      case 'pagos':
        return {
          action:
            DEBIT_FAILED_RE.test(t) || INSTALLMENT_MISSING_RE.test(t)
              ? 'pagos'
              : PAYMENT_CERTIFICATE_RE.test(t)
                ? 'documentos'
                : CUPON_RE.test(t)
                  ? 'cupones'
                  : intent,
          withDocs: DOCS_TOO_RE.test(t),
        };
      case 'baja':
        return this.matchClientIntent(text) === OPT.bajaPoliza
          ? { action: 'baja_poliza', withDocs: false }
          : null;
      case 'cobertura':
        return { action: 'cobertura', withDocs: false };
      default:
        return null;
    }
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
    if (BARE_ADVISOR_RE.test(fold(input.text).trim()))
      return this.startAdvisor(ctx, key);
    return this.handleAsesorMotivo(input, ctx, key);
  }

  /**
   * The customer asked for a person. The office hears about it right away,
   * with what they were doing or asking: waiting for the reason first left
   * requests nobody heard of when the customer never typed it and the chat
   * closed. What they add next joins that same alert (the API keeps one open
   * matter per chat).
   */
  private async startAdvisor(
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const prior = this.load(key)?.state;
    const asked =
      typeof prior?.data.lastQuestion === 'string'
        ? prior.data.lastQuestion
        : null;
    const topic = prior ? stepTopic(prior.step) : null;
    const reason = [
      'Pidió hablar con un asesor.',
      asked ? `Su consulta: "${clip(asked)}".` : 'Todavía no contó el motivo.',
      topic ? `Venía con ${topic}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    await this.api
      .requestHandoff(ctx.conversationId, reason)
      .catch(() => undefined);
    this.setState(key, 'ASESOR_MOTIVO', {
      alerted: true,
      ...(asked ? { lastQuestion: asked } : {}),
    });
    const hours = attentionHoursOf(ctx.attentionHours);
    if (asked) return { messages: [advisorSameQuestion(asked)] };
    return {
      messages: [
        {
          kind: 'text',
          body:
            `Listo, ya le avisé a la oficina 🙌 Un asesor te contacta por este chat (${hours}).` +
            (await this.closedNote()) +
            '\n\nPara que llegue con todo, contame brevemente el motivo.',
        },
      ],
    };
  }

  /**
   * What the customer says after the office was alerted: the reason joins the
   * alert, the menu option they tap is what they want now, and a "gracias" is
   * not a reason (it reached the office as one).
   */
  private async addAdvisorReason(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const sel = input.selectionId;
    const hours = attentionHoursOf(ctx.attentionHours);
    const asked =
      typeof state.data.lastQuestion === 'string'
        ? state.data.lastQuestion
        : null;
    if (sel === OPT.asesorOtra) {
      this.setState(key, 'ASESOR_MOTIVO', { alerted: true });
      return {
        messages: [
          {
            kind: 'text',
            body: 'Dale, contame brevemente el motivo y se lo sumo al aviso.',
          },
        ],
      };
    }
    const same =
      !!asked &&
      (sel === OPT.asesorMisma ||
        (!sel &&
          /^(?:si|sip|dale|ok|okey|pasala|pasalo|esa|eso)\b/.test(
            fold(input.text).trim(),
          ) &&
          words(input.text).split(' ').length <= 3));
    if (
      (sel && sel !== OPT.asesor && CLIENT_MENU_OPTS.has(sel)) ||
      (!sel && MENU_TITLES.has(words(input.text)))
    ) {
      const audience = this.audienceOf(key, ctx);
      if (audience === 'lead') {
        this.setState(key, 'LEAD_MENU');
        return this.handleLeadMenu(input, ctx, key);
      }
      this.setState(key, 'CLIENT_MENU');
      return this.handleClientMenu(input, ctx, key);
    }
    if (!same && !sel && isCloser(input.text)) {
      this.backToMenuState(key, ctx);
      return {
        messages: [
          {
            kind: 'text',
            body: `👍 El aviso ya está en la oficina: un asesor te escribe por este chat (${hours}).`,
          },
        ],
      };
    }
    if (!same && input.text.trim())
      await this.api
        .requestHandoff(ctx.conversationId, `Motivo: ${input.text.trim()}`)
        .catch(() => undefined);
    return this.advisorNoted(ctx, key);
  }

  /** Leaves the advisor step for the menu of whoever the customer said they are. */
  private backToMenuState(
    key: string,
    ctx: FlowContext,
  ): 'client' | 'lead' | undefined {
    const audience = this.audienceOf(key, ctx);
    this.setState(
      key,
      audience === 'lead'
        ? 'LEAD_MENU'
        : audience === 'client'
          ? 'CLIENT_MENU'
          : 'ROOT',
    );
    return audience;
  }

  /** "Listo, tomé nota", then the menu of whoever the customer said they are. */
  private async advisorNoted(
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const note = {
      kind: 'text' as const,
      body:
        `Listo, tomé nota ✍️. Un asesor te va a contactar dentro del horario de atención (${attentionHoursOf(ctx.attentionHours)}).` +
        (await this.closedNote()),
    };
    // Someone who asked for a person on their first message never said, so
    // no menu follows.
    const audience = this.backToMenuState(key, ctx);
    if (audience === 'lead') return { messages: [note, leadMenu()] };
    if (audience === 'client') return { messages: [note, clientMenu()] };
    return { messages: [note] };
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
    const typed = !input.selectionId;
    if (input.selectionId === OPT.bajaNo)
      return {
        messages: [
          {
            kind: 'text',
            body: 'Perdón, te entendí mal 🙏 Contame de nuevo qué necesitás, o elegí una opción:',
          },
          clientMenu(),
        ],
      };
    // Only thanks, a goodbye or emojis: "dale" or "ok" may be the answer to
    // something the bot just offered.
    if (
      typed &&
      isCloser(input.text) &&
      (!/[\p{L}\p{N}]/u.test(input.text) ||
        /\b(?:gracias|grax|gcs|chau|adios|saludos|abrazo)\b/.test(
          fold(input.text),
        ))
    )
      return this.closerReply(key, input.text);
    // A request in the customer's own words is read like a first message:
    // keywords sent "¿mi póliza cubre granizo?" to the papers and "¿por qué
    // aumentó el precio?" to a new quote.
    if (typed && questionOf(input.text)) {
      const routed = await this.routeOpening(input, ctx, key, null);
      if (routed) return routed;
    }
    const opt = input.selectionId ?? this.matchClientIntent(input.text);

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
        // "¿Ya está hecha la denuncia?" already says which one it is, typed or
        // passed along with the option the model opened.
        const sub = input.text.trim()
          ? this.matchSiniestroIntent(input.text)
          : null;
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
      case OPT.cobertura:
        return this.guard(ctx, key, 'cobertura', {}, input.text);
      case OPT.asesor:
        // What they already asked ("no me aparece la cuota 4") goes with the
        // alert: two customers had to type their question again.
        return this.startAdvisor(ctx, key);
      default:
        // Hybrid router: the keyword matcher didn't catch a transactional
        // intent, so instead of a dead-end "no te entendí" we hand this single
        // turn to NICO (the FAQ LLM) for a natural reply. We deliberately do NOT
        // switch to LLM_FAQ state — the user stays in CLIENT_MENU, so the next
        // message is routed deterministically again and there's no LLM lock-in
        // (one model call per unmatched message, which keeps cost bounded).
        // The question stays for "Hablar con un asesor".
        if (questionOf(input.text)) {
          const current = this.load(key)?.state;
          this.setState(key, 'CLIENT_MENU', {
            ...(current?.step === 'CLIENT_MENU' ? current.data : {}),
            lastQuestion: questionOf(input.text),
          });
        }
        return { messages: [], handoff: 'faq' };
    }
  }

  /**
   * "Gracias", "ok", "👍" at a menu: one short reply, then silence. Each 👍
   * after a request got its own "¡De nada!" from the model (#224, 16/10), and
   * a bare emoji needs no answer at all.
   */
  private closerReply(key: string, text: string): FlowResult {
    const state = this.load(key)?.state;
    if (!state || state.data.thanked === true) return { messages: [] };
    if (!/[\p{L}\p{N}]/u.test(text)) return { messages: [] };
    this.setState(key, state.step, { ...state.data, thanked: true });
    return {
      messages: [
        {
          kind: 'text',
          body: '¡De nada! 🙌 Cuando necesites algo, escribime por acá.',
        },
      ],
    };
  }

  private async handleLeadMenu(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const typed = !input.selectionId;
    // Someone who tapped "Todavía no" by mistake, or who is a client after
    // all: they used to be stuck with quotes and questions, with no way to
    // their claims, payments or papers.
    if (
      input.selectionId === OPT.cliente ||
      (typed && SAYS_CLIENT_RE.test(fold(input.text)))
    )
      return this.startClientIdentification(ctx, key);
    if (this.matchClientIntent(input.text) === OPT.bajaPoliza)
      return this.guard(ctx, key, 'baja_poliza', {}, input.text);
    // A request in their own words: their claim, payments or papers make
    // them a client (identification follows); a question goes to the model.
    if (typed && questionOf(input.text)) {
      const routed = await this.routeOpening(input, ctx, key, null);
      if (routed) return routed;
    }
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
    if (
      (action === 'documentos' || action === 'siniestro_nueva') &&
      said &&
      CLAIM_COPY_RE.test(fold(said))
    )
      return this.claimCopyRequest(said, ctx, key);
    const named = action === 'documentos' ? wantedDocs(said) : [];
    if (named.length) opts = { ...opts, docs: named };
    // A claim the office took by hand in this chat is not in our records:
    // asking for the DNI to say "no tenés denuncias" helped nobody.
    if (action === 'siniestro_consultar' && ctx.officeThread && !ctx.client)
      return this.officeFollowUp(question ?? '', ctx, key);
    const pending = {
      pendingAction: action,
      ...(opts.withDocs ? { pendingWithDocs: true } : {}),
      ...(question ? { pendingQuestion: question } : {}),
      ...(opts.docs ? { pendingDocs: opts.docs } : {}),
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
      // A request typed instead of the answer ("¿me podrías enviar la
      // cuponera?"): it is what they want once identified, so the question
      // comes back with it remembered. The bot used to drop the question and
      // ask for the DNI twice.
      const asked = await this.phoneMatchRequest(state, input, ctx, key);
      if (asked) return asked;
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

    // "Necesito asegurar otro auto" where the DNI was asked: a quote needs
    // no identification. It got "pasame el DNI" again.
    if (
      !input.selectionId &&
      QUOTE_INTENT_RE.test(fold(raw)) &&
      !MAYBE_IDENTIFICATION_RE.test(raw)
    )
      return this.enterCotizar(input, ctx, key);

    let action = (state.data.pendingAction as IdentificationAction) ?? 'pagos';
    let params: { dni: string } | { plate: string } | null =
      bareIdentification(raw);
    // Bare identifiers need no interpretation; natural speech goes to the model.
    const bare =
      !!params ||
      /^(?:[\d .-]+|[a-z]{3}[ -]*\d{3}|[a-z]{2}[ -]*\d{3}[ -]*[a-z]{2}|[a-z][ -]*\d{3}[ -]*[a-z]{3})$/i.test(
        raw,
      );
    if (params) {
      // Read already, without the model.
    } else if (bare || ctx.llmEnabled === false)
      params = identificationFromText(raw);
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
      ...(Array.isArray(state.data.pendingDocs)
        ? { docs: state.data.pendingDocs as string[] }
        : {}),
    });
    return result ?? this.notFound(key, state.data);
  }

  /**
   * Nobody has that DNI, CUIT or plate. Said as such every time: counted as
   * a misunderstanding, the second one answered "no te estoy entendiendo" to
   * a customer who had sent a perfectly clear plate. From the second one on,
   * a person is offered too.
   */
  private notFound(key: string, data: Record<string, unknown>): FlowResult {
    const misses = ((data.notFound as number | undefined) ?? 0) + 1;
    this.setState(key, 'IDENTIFY', {
      ...withoutPhoneQuestion(data),
      notFound: misses,
    });
    if (misses < 2)
      return { messages: [{ kind: 'text', body: NOT_FOUND_TEXT }] };
    return {
      messages: [
        {
          kind: 'buttons',
          body: 'Tampoco encontré ese dato 😕. Puede que la póliza esté a nombre de otra persona o con otro documento. Mandame otro DNI, CUIT o patente, o pedí que te ayude un asesor.',
          buttons: [{ id: OPT.stuckAsesor, title: 'Hablar con un asesor' }],
        },
      ],
    };
  }

  /**
   * A DNI, CUIT or plate sent on its own, outside the identification step:
   * identifies them and shows the menu, or says it wasn't found and waits for
   * another one in the identification step.
   */
  private async identifyTyped(
    params: { dni: string } | { plate: string },
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const found = await this.identifyAndRun(params, 'menu', ctx, key, {});
    if (found) return found;
    const prior = this.load(key)?.state;
    return this.notFound(key, {
      pendingAction: 'menu',
      ...(prior?.step === 'IDENTIFY' ? prior.data : {}),
    });
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
    const result = await this.runActionStep(action, ctx, key, opts);
    // What they asked stays for "Hablar con un asesor", wherever the action
    // left them at the menu: two customers had to type it again (#211, #226).
    const question = questionOf(opts.question);
    const state = this.load(key)?.state;
    if (
      question &&
      state?.step === 'CLIENT_MENU' &&
      typeof state.data.lastQuestion !== 'string'
    )
      this.setState(key, 'CLIENT_MENU', {
        ...state.data,
        lastQuestion: question,
      });
    return result;
  }

  private async runActionStep(
    action: ClientAction,
    ctx: FlowContext,
    key: string,
    opts: ActionOptions,
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
        if (estado.length === 0)
          return this.noPolizas(key, ctx, 'su estado de cuenta', opts.question);
        // Kept so "Hablar con un asesor" can pass it on without retyping.
        this.setState(
          key,
          'CLIENT_MENU',
          question ? { lastQuestion: question } : {},
        );
        const answer = question
          ? paymentAnswer(estado, question, this.transfer)
          : null;
        // "Un asesor te va a contactar" about a rejected debit: now the office
        // actually hears about it (the API keeps one alert per chat and matter).
        const rejected = estado.filter((p) => p.hasRejectedInstallments);
        // The customer says the debit did not go through and we have no
        // rejection on record: the office hears it with their words instead
        // of the bot promising "se debita en estos días" (#242, #172).
        const debitFailed = !!question && DEBIT_FAILED_RE.test(fold(question));
        const notDone = debitFailed ? debitNotDone(estado) : [];
        // A rejected or failed debit is paid by transfer to Triunfo, which is
        // what the office sends with the coupon (John, 20/10).
        const offer =
          rejected.length || notDone.length
            ? transferOffer([...rejected, ...notDone], this.transfer, true)
            : null;
        const sentTransfer = offer
          ? ' Se le pasaron los datos para transferir: si manda el comprobante, aplicar el pago.'
          : '';
        // "Un asesor te va a contactar" about a rejected debit: now the office
        // actually hears about it (the API keeps one alert per chat and matter).
        if (rejected.length)
          await this.api
            .requestHandoff(
              ctx.conversationId,
              `Rechazo de débito en ${rejected.map(polizaMention).join('; ')}: regularizar el pago con el cliente.${sentTransfer}`,
            )
            .catch(() => undefined);
        if (notDone.length)
          await this.api
            .requestHandoff(
              ctx.conversationId,
              `Dice que el débito no se realizó en ${notDone.map(polizaMention).join('; ')}: "${clip(question!)}". Regularizar el pago con el cliente (cupón o transferencia).${sentTransfer}`,
            )
            .catch(() => undefined);
        return {
          messages: [
            {
              kind: 'text',
              body:
                formatEstadoCuenta(estado, { debitFailed }) +
                (rejected.length || notDone.length
                  ? await this.closedNote()
                  : '') +
                (answer ? `\n\n${answer}` : ''),
            },
            ...(offer ? [{ kind: 'text' as const, body: offer }] : []),
            estado.length ? pagosMenu() : clientMenu(),
          ],
        };
      }
      case 'cobertura': {
        const polizas = await this.api.getPolizas(ctx.conversationId);
        const question = questionOf(opts.question) ?? '';
        if (polizas.length === 0)
          return this.noPolizas(key, ctx, 'qué cubre su póliza', opts.question);
        const poliza =
          polizas.length === 1
            ? polizas[0]
            : question
              ? this.matchPolizaByText(question, polizas)
              : null;
        if (poliza) return this.answerCoverage(question, poliza, ctx, key);
        this.setState(key, 'COBERTURA_POLIZA', { polizas, question });
        return {
          messages: [
            polizaPicker(polizas, '¿Sobre qué póliza es la consulta?'),
          ],
        };
      }
      case 'siniestro_consultar': {
        const siniestros = await this.api.getSiniestros(ctx.conversationId);
        if (siniestros.length === 0 && ctx.officeThread)
          return this.officeFollowUp(opts.question ?? '', ctx, key);
        // A question about a claim ("¿habrá problema si denuncio los vidrios
        // si pagué tarde?") got only "no tenés denuncias": the office answers it.
        const question = questionOf(opts.question);
        if (siniestros.length === 0 && question) {
          await this.api
            .requestHandoff(
              ctx.conversationId,
              `Consulta sobre un siniestro (no tiene denuncias cargadas en el bot): "${clip(question)}"`,
            )
            .catch(() => undefined);
          this.setState(key, 'CLIENT_MENU', { lastQuestion: question });
          return {
            messages: [
              {
                kind: 'text',
                body:
                  `No tengo denuncias tuyas registradas, así que le pasé tu consulta a la oficina para que te responda por este chat (${attentionHoursOf(ctx.attentionHours)}).` +
                  (await this.closedNote()) +
                  '\n\nSi querés hacer la denuncia ahora, elegí *Siniestros* y después *Denuncia nueva*.',
              },
              clientMenu(),
            ],
          };
        }
        if (siniestros.length === 0) {
          this.setState(key, 'CLIENT_MENU', {
            lastQuestion:
              'Quiere saber cómo va una denuncia que no figura en el bot (la habrá hecho con la oficina o con la compañía).',
          });
          return {
            messages: [
              { kind: 'text', body: formatSiniestros(siniestros) },
              claimOrAdvisorButtons(),
            ],
          };
        }
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
        // One policy: no list to pick from, just say which one it is.
        if (polizas.length === 1)
          return this.prepend(
            `La denuncia es sobre tu ${polizaMention(polizas[0])}.`,
            await this.handleSiniestroPoliza(
              this.load(key)!.state,
              { text: '', selectionId: `${POLIZA_PREFIX}${polizas[0].id}` },
              ctx,
              key,
            ),
          );
        return {
          messages: [
            polizaPicker(polizas, '¿Sobre qué póliza es la denuncia?'),
          ],
        };
      }
      case 'baja_poliza': {
        const polizas = await this.api.getPolizas(ctx.conversationId);
        if (!polizas.length)
          return this.noPolizas(
            key,
            ctx,
            'la baja de su póliza',
            opts.question,
          );
        // One policy: straight to the confirmation, which still offers "Es
        // otra póliza" for one the bot can't see.
        if (polizas.length === 1) {
          this.setState(key, 'BAJA_CONFIRM', {
            polizas,
            polizaId: polizas[0].id,
            single: true,
          });
          return { messages: [this.bajaConfirmMessage(polizas[0], true)] };
        }
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
        if (polizas.length === 0)
          return this.noPolizas(
            key,
            ctx,
            'la documentación de su póliza',
            opts.question,
          );
        this.setState(key, 'DOC_POLIZA', {
          polizas,
          ...(opts.docs?.length ? { wanted: opts.docs } : {}),
        });
        if (polizas.length === 1) {
          const result = await this.handleDocPoliza(
            this.load(key)!.state,
            { text: '', selectionId: `${POLIZA_PREFIX}${polizas[0].id}` },
            ctx,
            key,
          );
          // Sent documents already say which policy they are from.
          return result.messages[0]?.kind === 'document'
            ? result
            : this.prepend(`Es sobre tu ${polizaMention(polizas[0])}.`, result);
        }
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
        if (polizas.length === 0)
          return this.noPolizas(key, ctx, 'los cupones de pago', opts.question);
        const withDocs = opts.withDocs === true;
        // "No se pudo debitar, mandame el cupón": the transfer is offered
        // even for an installment the cartera still shows as being debited.
        const debitFailed = DEBIT_FAILED_RE.test(fold(opts.question ?? ''));
        if (polizas.length === 1)
          return this.requestCupones(polizas, false, withDocs, ctx, key, {
            debitFailed,
          });
        this.setState(key, 'CUPON_POLIZA', {
          polizas,
          ...(withDocs ? { withDocs } : {}),
          ...(debitFailed ? { debitFailed } : {}),
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
      return this.requestCupones(polizas, true, withDocs, ctx, key, {
        debitFailed: state.data.debitFailed === true,
      });

    const id = this.parsePrefId(input.selectionId, POLIZA_PREFIX);
    const poliza =
      polizas.find((p) => p.id === id) ??
      this.matchPolizaByText(input.text, polizas);
    if (poliza)
      return this.requestCupones([poliza], false, withDocs, ctx, key, {
        debitFailed: state.data.debitFailed === true,
      });

    if (!input.selectionId && input.text.trim())
      return {
        messages: [],
        handoff: 'faq',
        onScreen: polizaPicker(
          polizas,
          withDocs
            ? '¿De qué póliza necesitás los cupones y la documentación?'
            : '¿De qué póliza necesitás los cupones de pago?',
          { allRow: true, otherRow: true },
        ),
      };
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
    opts: { debitFailed?: boolean } = {},
  ): Promise<FlowResult> {
    // Triunfo hands over the cuponera of some Plan de Pago policies only, never
    // Convenio ones: the bot sends what it gets and the office the rest.
    const files: OutgoingMessage[] = [];
    const missing: PolizaSummary[] = [];
    for (const poliza of polizas) {
      const file = await this.cuponeraOf(poliza, ctx);
      if (file) files.push(file);
      else missing.push(poliza);
    }
    const sentNote = files.length
      ? `Ahí te mandé la cuponera de pago de ${joinNames(
          polizas
            .filter((p) => !missing.includes(p))
            .map((p) => `tu ${polizaLabel(p)}`),
        )}`
      : '';
    // With one policy the bot sends the papers itself, after the coupons, when
    // Triunfo has them; otherwise the office gets one request for everything.
    const docsToo =
      withDocs &&
      polizas.length === 1 &&
      (await this.hasPapers(polizas[0], ctx));
    const thenDocs = async (head: OutgoingMessage[]): Promise<FlowResult> => {
      this.setState(key, 'DOC_POLIZA', { polizas });
      const docs = await this.handleDocPoliza(
        this.load(key)!.state,
        { text: '', selectionId: `${POLIZA_PREFIX}${polizas[0].id}` },
        ctx,
        key,
      );
      return { ...docs, messages: [...head, ...docs.messages] };
    };

    if (missing.length === 0) {
      const head: OutgoingMessage[] = [
        ...files,
        { kind: 'text', body: `${sentNote} 🙌` },
      ];
      if (docsToo) return thenDocs(head);
      this.setState(key, 'CLIENT_MENU');
      return { messages: [...head, clientMenu()] };
    }

    const what =
      withDocs && !docsToo
        ? 'los cupones de pago y la documentación'
        : 'los cupones de pago';
    const which =
      missing.length === 1
        ? `de su póliza ${polizaMention(missing[0])}`
        : `de todas sus pólizas: ${missing.map(polizaMention).join('; ')}`;
    // Until the coupon arrives, the installment and the account to transfer
    // to: what the office sent by hand at night or on weekends (John, 20/10).
    const offer = await this.transferOfferFor(
      missing,
      ctx,
      opts.debitFailed === true,
    );
    await this.api
      .requestHandoff(
        ctx.conversationId,
        `Pide ${what} ${which}. El bot no puede obtenerlos de Triunfo: enviárselos por este chat.` +
          (offer
            ? ' Se le pasaron los datos para transferir: si manda el comprobante, aplicar el pago.'
            : ''),
      )
      .catch(() => undefined);

    const label =
      all && files.length === 0
        ? 'todas tus pólizas'
        : missing.length === 1
          ? `tu ${polizaLabel(missing[0])}`
          : 'tus pólizas';
    this.setState(key, 'CLIENT_MENU', {
      requested: { action: 'cupones', what, label },
    });
    const papers =
      withDocs && !docsToo
        ? 'Los cupones de pago y la documentación'
        : 'Los cupones de pago';
    const head: OutgoingMessage[] = [
      ...files,
      {
        kind: 'text',
        body:
          (sentNote ? `${sentNote}.\n\n` : '') +
          `${papers} te los manda la oficina por este chat 🙌 Ya les pasé tu pedido para ${label}. ` +
          `Te los envían en el horario de atención (${attentionHoursOf(ctx.attentionHours)}).` +
          (await this.closedNote()),
      },
      ...(offer ? [{ kind: 'text' as const, body: offer }] : []),
    ];
    if (docsToo) return thenDocs(head);
    return { messages: [...head, clientMenu()] };
  }

  /** The transfer offer for these policies' next installments, if any. */
  private async transferOfferFor(
    polizas: PolizaSummary[],
    ctx: FlowContext,
    debitFailed: boolean,
  ): Promise<string | null> {
    if (!this.transfer.alias && !this.transfer.cbu) return null;
    const ids = new Set(polizas.map((p) => p.id));
    const estado = await this.api
      .getEstadoCuenta(ctx.conversationId)
      .catch((): EstadoCuentaPoliza[] => []);
    return transferOffer(
      estado.filter((p) => ids.has(p.id)),
      this.transfer,
      debitFailed,
    );
  }

  /** Whether Triunfo has any document of the policy other than the cuponera. */
  private async hasPapers(
    poliza: PolizaSummary,
    ctx: FlowContext,
  ): Promise<boolean> {
    const docs = await this.api
      .getDocumentos(ctx.conversationId, poliza.id)
      .catch((): PolizaDocumento[] => []);
    return docs.some((d) => d.code !== DOC_CODE.cuponera);
  }

  /** The cuponera of a policy as a PDF to send, when Triunfo has it. */
  private async cuponeraOf(
    poliza: PolizaSummary,
    ctx: FlowContext,
  ): Promise<OutgoingMessage | null> {
    try {
      const docs = await this.api.getDocumentos(ctx.conversationId, poliza.id);
      if (!docs.some((d) => d.code === DOC_CODE.cuponera)) return null;
      const file = await this.api.getDocumentoPdf(
        ctx.conversationId,
        poliza.id,
        DOC_CODE.cuponera,
      );
      return { kind: 'document', body: '', ...file };
    } catch (error) {
      this.logger.warn(
        `No se pudo bajar la cuponera de la póliza ${poliza.id}: ${(error as Error).message}`,
      );
      return null;
    }
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

  private bajaConfirmMessage(
    poliza: PolizaSummary,
    otherOption = false,
  ): OutgoingMessage {
    return {
      kind: 'buttons',
      body: otherOption
        ? `¿Confirmás que querés solicitar la baja de tu ${polizaMention(poliza)}? La oficina recibirá el pedido y te confirmará cuándo queda efectiva.`
        : `¿Confirmás que querés solicitar la baja de la póliza *${poliza.certificateNumber}*${poliza.vehicle?.licensePlate ? ` (${poliza.vehicle.licensePlate})` : ''}? La oficina recibirá el pedido y te confirmará cuándo queda efectiva.`,
      buttons: [
        { id: OPT.confirmar, title: 'Solicitar baja' },
        ...(otherOption
          ? [{ id: OTHER_POLIZA_ID, title: 'Es otra póliza' }]
          : []),
        { id: OPT.cancelar, title: 'Cancelar' },
      ],
    };
  }

  private handleBajaConfirm(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): FlowResult {
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
    const other = this.otherPoliza(input, key);
    if (other) return other;
    const poliza = (state.data.polizas as PolizaSummary[]).find(
      (p) => p.id === state.data.polizaId,
    )!;
    if (choice !== OPT.confirmar)
      return this.retry(key, state, [
        this.bajaConfirmMessage(poliza, state.data.single === true),
      ]);
    // The office asks "¿por qué motivo?" before anything else (John, 21/10):
    // collect it here so the request arrives complete.
    this.setState(key, 'BAJA_MOTIVO', { ...state.data });
    return { messages: [bajaMotivoPicker(isVehiclePolicy(poliza))] };
  }

  /**
   * The reason behind the cancellation: one of the listed motives, or what
   * the client writes after "Otro motivo" (or instead of picking).
   */
  private async handleBajaMotivo(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const poliza = (state.data.polizas as PolizaSummary[]).find(
      (p) => p.id === state.data.polizaId,
    )!;
    const vehicle = isVehiclePolicy(poliza);
    if (input.selectionId === BAJA_MOTIVO_OTRO_ID) {
      this.setState(key, 'BAJA_MOTIVO', { ...state.data, askedOther: true });
      return {
        messages: [
          {
            kind: 'text',
            body: 'Dale, contame brevemente el motivo de la baja.',
          },
        ],
      };
    }
    const labeled = input.selectionId
      ? bajaMotivoLabels(vehicle)[input.selectionId]
      : undefined;
    const typed = input.text.trim();
    const reason = labeled ?? (typed.length >= 3 ? typed : undefined);
    if (!reason) return this.retry(key, state, [bajaMotivoPicker(vehicle)]);
    return this.submitBaja(poliza, reason, ctx, key);
  }

  private async submitBaja(
    poliza: PolizaSummary,
    reason: string,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    await this.api.requestPolicyCancellation(
      ctx.conversationId,
      poliza.id,
      reason,
    );
    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body:
            `Registré tu solicitud de baja de la póliza *${poliza.certificateNumber}* (motivo: ${reason}). La oficina recibió la notificación y te confirmará la gestión por este chat. La póliza todavía no fue dada de baja.` +
            (await this.closedNote()),
        },
        clientMenu(),
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
    if (!input.selectionId) {
      const said = fold(input.text);
      if (CLAIM_COPY_RE.test(said))
        return this.claimCopyRequest(input.text, ctx, key);
      if (CLAIMS_PHONE_RE.test(said)) return this.claimsPhoneReply(key);
    }
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

    // Home, shop, life and other policies: there is no street, direction or
    // passengers to ask about. The office wants the kind of event, then date,
    // time, the address and what happened (#242: a burnt TV got asked "hacia
    // dónde circulabas" twice and the customer gave up).
    if (!isVehiclePolicy(poliza))
      return this.startSiniestroBien(key, state.data, poliza, ctx);

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

  // ─── Cobertura: "¿mi póliza cubre X?" ────────────────────

  private async handleCoberturaPoliza(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const polizas = (state.data.polizas as PolizaSummary[] | undefined) ?? [];
    let polizaId = this.parsePrefId(input.selectionId, POLIZA_PREFIX);
    if (polizaId === null && input.text.trim())
      polizaId = this.matchPolizaByText(input.text, polizas)?.id ?? null;
    const poliza = polizas.find((p) => p.id === polizaId);
    if (!poliza)
      return this.retry(key, state, [
        polizaPicker(
          polizas,
          'No reconocí esa póliza. Elegí una de la lista, o escribí *menú* para volver.',
        ),
      ]);
    return this.answerCoverage(
      (state.data.question as string | undefined) ?? '',
      poliza,
      ctx,
      key,
    );
  }

  /**
   * The answer from the policy's own coverage, with the claim and the office a
   * tap away. What the detail does not settle goes to the office with the
   * question, which is what it answered by hand before.
   */
  private async answerCoverage(
    question: string,
    poliza: PolizaSummary,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const mention = polizaMention(poliza);
    this.setState(
      key,
      'CLIENT_MENU',
      question ? { lastQuestion: question } : {},
    );
    const askOffice = async (body: string): Promise<FlowResult> => {
      await this.api
        .requestHandoff(
          ctx.conversationId,
          `Pregunta qué cubre su ${mention}${question ? `: "${clip(question)}"` : ''}. El bot no lo pudo confirmar con el detalle de la póliza.`,
        )
        .catch(() => undefined);
      return {
        messages: [
          {
            kind: 'text',
            body:
              `${body} Le pasé tu consulta a la oficina para que te lo confirme por este chat (${attentionHoursOf(ctx.attentionHours)}).` +
              (await this.closedNote()),
          },
          claimOrAdvisorButtons(),
        ],
      };
    };
    if (!hasCoverageFacts(poliza))
      return askOffice(
        `No tengo el detalle de la cobertura de tu ${polizaLabel(poliza)}.`,
      );
    if (!question || ctx.llmEnabled === false || !ctx.phoneNumberId)
      return {
        messages: [
          { kind: 'text', body: coverageSummary(poliza) },
          claimOrAdvisorButtons(),
        ],
      };
    try {
      const answer = await this.coverage.answer({
        question,
        poliza,
        phoneNumberId: ctx.phoneNumberId,
      });
      if (answer.certeza === 'no_figura') return askOffice(answer.respuesta);
      return {
        messages: [
          { kind: 'text', body: toWhatsAppMarkdown(answer.respuesta) },
          claimOrAdvisorButtons(),
        ],
      };
    } catch (error) {
      this.logger.warn(
        `No se pudo responder la cobertura con el modelo: ${this.errMsg(error)}`,
      );
      return {
        messages: [
          { kind: 'text', body: coverageSummary(poliza) },
          claimOrAdvisorButtons(),
        ],
      };
    }
  }

  // ─── Siniestro: pólizas que no son un vehículo (hogar, comercio…) ───

  /**
   * A home or shop claim starts by its kind (robo, incendio, daños,
   * responsabilidad civil); life and other policies go straight to the data.
   */
  private startSiniestroBien(
    key: string,
    data: Record<string, unknown>,
    poliza: PolizaSummary,
    ctx: FlowContext,
  ): FlowResult {
    const base = { ...data, polizaId: poliza.id, bien: true };
    if (poliza.riskType !== 'home' && poliza.riskType !== 'commercial')
      return this.askSiniestroBienDatos(key, base, null, null, ctx);
    this.setState(key, 'SINIESTRO_BIEN_TIPO', base);
    return { messages: [bienTipoPicker(poliza)] };
  }

  private handleSiniestroBienTipo(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): FlowResult {
    const polizas = (state.data.polizas as PolizaSummary[] | undefined) ?? [];
    const poliza = polizas.find((p) => p.id === state.data.polizaId);
    const folded = fold(input.text);
    const tipo =
      this.parsePrefixed<BienTipo>(input.selectionId, BIEN_TIPO_PREFIX) ??
      matchBienTipo(folded);
    if (!tipo)
      return this.retry(key, state, [
        bienTipoPicker(
          poliza,
          'No reconocí el tipo de siniestro. Elegí una opción de la lista, o escribí *menú* para volver.',
        ),
      ]);
    if (tipo !== 'danios')
      return this.askSiniestroBienDatos(key, state.data, tipo, null, ctx);
    // "se rajó el vidrio" already says what got damaged: no need to ask.
    const danio = input.selectionId ? null : matchBienDanio(folded);
    if (danio)
      return this.askSiniestroBienDatos(key, state.data, tipo, danio, ctx);
    this.setState(key, 'SINIESTRO_BIEN_DANIO', {
      ...state.data,
      bienTipo: tipo,
    });
    return { messages: [bienDanioButtons()] };
  }

  private handleSiniestroBienDanio(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): FlowResult {
    const danio =
      this.parsePrefixed<BienDanio>(input.selectionId, BIEN_DANIO_PREFIX) ??
      matchBienDanio(fold(input.text));
    if (!danio)
      return this.retry(key, state, [
        bienDanioButtons('Decime qué se dañó: elegí una opción.'),
      ]);
    return this.askSiniestroBienDatos(key, state.data, 'danios', danio, ctx);
  }

  /** The one-message checklist, or one question at a time without the model. */
  private askSiniestroBienDatos(
    key: string,
    data: Record<string, unknown>,
    tipo: BienTipo | null,
    danio: BienDanio | null,
    ctx: FlowContext,
  ): FlowResult {
    const label = bienTipoLabel(tipo, danio);
    const base = {
      ...data,
      bien: true,
      bienTipo: tipo,
      bienDanio: danio,
      bienLabel: label,
    };
    if (ctx.llmEnabled === false)
      return this.askSiniestroFecha(key, base, data.polizaId as number);
    this.setState(key, 'SINIESTRO_BIEN_DATOS', {
      ...base,
      bienDatos: BIEN_DATOS_VACIOS,
      pedidos: [],
      [RETRIES]: 0,
    });
    return { messages: [bienChecklist(label)] };
  }

  private async handleSiniestroBienDatos(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const known =
      (state.data.bienDatos as BienDatos | undefined) ?? BIEN_DATOS_VACIOS;
    const asked = (state.data.pedidos as BienCampo[] | undefined) ?? [];
    const label = (state.data.bienLabel as string | null | undefined) ?? null;
    const text = input.text.trim();
    if (!text) {
      const faltan = pendientesBien(known);
      return this.retry(key, state, [
        asked.length ? siniestroFaltantes(faltan) : bienChecklist(label),
      ]);
    }

    let extracted: Partial<BienDatos>;
    try {
      extracted = await this.extractor.extractBien({
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

    if (extracted.fecha && !parseFecha(extracted.fecha)) extracted.fecha = null;
    const datos = mergeBienDatos(known, extracted);
    const faltan = pendientesBien(datos);
    const progressed = faltan.length < pendientesBien(known).length;

    if (faltan.length) {
      const data = {
        ...state.data,
        bienDatos: datos,
        pedidos: faltan.map((f) => f.campo),
      };
      if (!progressed)
        return this.retry(key, { ...state, data }, [
          siniestroFaltantes(faltan),
        ]);
      this.setState(key, 'SINIESTRO_BIEN_DATOS', { ...data, [RETRIES]: 0 });
      return { messages: [siniestroFaltantes(faltan)] };
    }

    const fecha = parseFecha(datos.fecha!)!;
    const descripcion = bienDescripcion(label, datos);
    this.setState(key, 'SINIESTRO_CONFIRM', {
      ...state.data,
      bienDatos: datos,
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

  /** `prefix_value` selection ids → value, or null. */
  private parsePrefixed<T extends string>(
    selectionId: string | undefined,
    prefix: string,
  ): T | null {
    if (!selectionId || !selectionId.startsWith(prefix)) return null;
    return selectionId.slice(prefix.length) as T;
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
    // The street number is asked once: "cerca de San Martín" after being
    // asked is the place, and asking again made a customer cancel the claim.
    const opts = { alturaYaPedida: asked.includes('altura') };
    const faltan = pendientes(datos, opts);
    const progressed = faltan.length < pendientes(known, opts).length;

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
          body: state.data.bien
            ? 'Contame qué pasó, con tus palabras.'
            : 'Contame cómo ocurrió el hecho. Si fue un choque, ¿cómo fue el choque?',
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
          body: state.data.bien
            ? 'Contame un poco más de qué pasó.'
            : 'Contame un poco más de cómo ocurrió el hecho o cómo fue el choque.',
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
    const bien = state.data.bien === true;
    const fields = {
      SINIESTRO_HORA: bien
        ? {
            field: 'hora',
            next: 'SINIESTRO_DOMICILIO' as FlowStep,
            question:
              '¿En qué domicilio ocurrió? Calle y número, y localidad (aunque sea el de la póliza).',
          }
        : {
            field: 'hora',
            next: 'SINIESTRO_LOCALIDAD' as FlowStep,
            question: '¿En qué localidad ocurrió el hecho?',
          },
      SINIESTRO_DOMICILIO: {
        field: 'domicilio',
        next: 'SINIESTRO_CONFIRM',
        question: '',
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
    const descripcion = bien
      ? bienDescripcion((data.bienLabel as string | null | undefined) ?? null, {
          fecha: data.fechaIso as string,
          hora: String(data.hora),
          domicilio: String(data.domicilio),
          relato: String(data.descripcion),
        })
      : `${String(data.descripcion)}\nHora: ${String(data.hora)}\nLocalidad: ${String(data.localidad)}\nCalle: ${String(data.calle)}\nAltura / referencia: ${value}`;
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

    // The coverages of a home or shop policy are optional: the office checks
    // whether this one covers the event before filing it.
    const registered = {
      kind: 'text' as const,
      body:
        `✅ Registré tu denuncia (N° interno *${siniestro.id}*).\n` +
        (state.data.bien === true
          ? 'La oficina revisa la cobertura de tu póliza, la carga en Triunfo Seguros y te informa el número de siniestro oficial.'
          : 'La oficina la va a cargar en Triunfo Seguros y te vamos a informar el número de siniestro oficial.'),
    };
    // A home or shop claim has no green card or licence: only photos of the
    // damage, if there are any.
    if (state.data.bien === true) {
      this.setState(key, 'SINIESTRO_FOTO_DANIO', {
        siniestroId: siniestro.id,
        bien: true,
      });
      return {
        messages: [
          registered,
          {
            kind: 'text',
            body:
              'Si tenés *fotos* de lo dañado o de lo que pasó 📸, mandámelas ahora: podés enviar varias. ' +
              'Cuando termines, escribí *listo*. Si no tenés, escribí *no tengo*.',
          },
        ],
      };
    }

    // Start the guided photo capture. Each photo the client sends from here is
    // attached to THIS claim and labeled by type (tarjeta verde / carnet / tercero).
    // Whether another vehicle was involved is already in the checklist:
    // the photo steps don't ask it again.
    const otroVehiculo = (state.data.datos as SiniestroDatos | undefined)
      ?.otroVehiculo;
    this.setState(key, 'SINIESTRO_FOTO_TARJETA', {
      siniestroId: siniestro.id,
      ...(typeof otroVehiculo === 'boolean' ? { otroVehiculo } : {}),
    });
    return {
      messages: [
        registered,
        {
          kind: 'text',
          body:
            'Ahora sumemos algunas *fotos* a tu reclamo 📎.\n\n' +
            'Mandame la *tarjeta verde* (cédula del vehículo): una foto del *frente* y otra del *dorso*. ' +
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
    // The claim's data (siniestroId, otroVehiculo) goes along the photo steps.
    this.setState(key, step, this.load(key)?.state.data ?? {});
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

  /**
   * Front and back of each card: the office asked again for the back of the
   * tarjeta verde and the licence on every claim (#92, #196, #227). A photo
   * of the front asks for its back; "no la tengo" skips the whole card.
   */
  private handleSinFotoTarjeta(input: UserInput, key: string): FlowResult {
    if (!this.photoAdvances(input)) return this.retryPhoto();
    if (input.selectionId === PHOTO_RECEIVED)
      return this.askPhoto(
        key,
        'SINIESTRO_FOTO_TARJETA_DORSO',
        'Ahora el *dorso* de la tarjeta verde.',
      );
    return this.askCarnet(key);
  }

  private handleSinFotoTarjetaDorso(input: UserInput, key: string): FlowResult {
    if (!this.photoAdvances(input)) return this.retryPhoto();
    return this.askCarnet(key);
  }

  private askCarnet(key: string): FlowResult {
    return this.askPhoto(
      key,
      'SINIESTRO_FOTO_CARNET',
      'Perfecto. Ahora tu *carnet de conducir*: el *frente* y el *dorso*. (si no lo tenés, escribí *no la tengo*)',
    );
  }

  private handleSinFotoCarnet(input: UserInput, key: string): FlowResult {
    if (!this.photoAdvances(input)) return this.retryPhoto();
    if (input.selectionId === PHOTO_RECEIVED)
      return this.askPhoto(
        key,
        'SINIESTRO_FOTO_CARNET_DORSO',
        'Ahora el *dorso* del carnet.',
      );
    return this.afterOwnPhotos(key);
  }

  private handleSinFotoCarnetDorso(input: UserInput, key: string): FlowResult {
    if (!this.photoAdvances(input)) return this.retryPhoto();
    return this.afterOwnPhotos(key);
  }

  private afterOwnPhotos(key: string): FlowResult {
    const otroVehiculo = this.load(key)?.state.data.otroVehiculo;
    if (otroVehiculo === false) return this.askDanio(key);
    if (otroVehiculo === true) return this.askTerceroTarjeta(key);
    this.setState(key, 'SINIESTRO_TERCERO', this.load(key)?.state.data ?? {});
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

    if (yes) return this.askTerceroTarjeta(key);
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

  private askTerceroTarjeta(key: string): FlowResult {
    return this.askPhoto(
      key,
      'SINIESTRO_TERCERO_TARJETA',
      'Mandame la *tarjeta verde del tercero*, frente y dorso (si la tenés). (o *no la tengo*)',
    );
  }

  private handleSinTerceroTarjeta(input: UserInput, key: string): FlowResult {
    if (!this.photoAdvances(input)) return this.retryPhoto();
    if (input.selectionId === PHOTO_RECEIVED)
      return this.askPhoto(
        key,
        'SINIESTRO_TERCERO_TARJETA_DORSO',
        'Ahora el *dorso* de la tarjeta verde del tercero.',
      );
    return this.askTerceroCarnet(key);
  }

  private handleSinTerceroTarjetaDorso(
    input: UserInput,
    key: string,
  ): FlowResult {
    if (!this.photoAdvances(input)) return this.retryPhoto();
    return this.askTerceroCarnet(key);
  }

  private askTerceroCarnet(key: string): FlowResult {
    return this.askPhoto(
      key,
      'SINIESTRO_TERCERO_CARNET',
      'Ahora el *carnet de conducir del tercero*, frente y dorso. (o *no la tengo*)',
    );
  }

  private handleSinTerceroCarnet(input: UserInput, key: string): FlowResult {
    if (!this.photoAdvances(input)) return this.retryPhoto();
    if (input.selectionId === PHOTO_RECEIVED)
      return this.askPhoto(
        key,
        'SINIESTRO_TERCERO_CARNET_DORSO',
        'Ahora el *dorso* del carnet del tercero.',
      );
    return this.askDanio(key);
  }

  private handleSinTerceroCarnetDorso(
    input: UserInput,
    key: string,
  ): FlowResult {
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

  private async handleSinFotoDanio(
    input: UserInput,
    key: string,
  ): Promise<FlowResult> {
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
          body: 'Mandame las *fotos* de lo que pasó (los daños, el lugar), o escribí *listo* cuando termines.',
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

  private async finishSiniestroPhotos(key: string): Promise<FlowResult> {
    this.setState(key, 'CLIENT_MENU');
    // Outside office hours "a la brevedad" promised what nobody could do
    // until the next morning: the closed note says when.
    return {
      messages: [
        {
          kind: 'text',
          body:
            '¡Listo! 🙌 Sumé todo a tu denuncia. Un asesor le va a dar seguimiento y te escribe por este chat.' +
            (await this.closedNote()) +
            '\n\n¿Necesitás algo más?',
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
    if (!input.selectionId && CLAIM_COPY_RE.test(fold(input.text)))
      return this.claimCopyRequest(input.text, ctx, key);
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
      if (!input.selectionId) {
        const typed = await this.docRequestTyped(input, ctx, key, polizas);
        if (typed) return typed;
      }
      // Anything else is read by the model, which can pick the policy, open
      // what they ask for or answer a question; state stays DOC_POLIZA.
      return {
        messages: [],
        handoff: 'faq',
        onScreen: polizaPicker(
          polizas,
          '¿De qué póliza querés la documentación?',
          { otherRow: true },
        ),
      };
    }

    const poliza = polizas.find((p) => p.id === polizaId);
    const docs = await this.api
      .getDocumentos(ctx.conversationId, polizaId)
      .catch((error: Error): PolizaDocumento[] => {
        this.logger.warn(
          `No se pudieron listar los documentos de la póliza ${polizaId}: ${error.message}`,
        );
        return [];
      });
    if (docs.length === 0) {
      // Triunfo has nothing for this policy (or did not answer): the request
      // reaches the inbox so the office sends the papers by hand.
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

    // What the customer named ("la tarjeta verde") goes straight to the chat.
    const wanted = (state.data.wanted as string[] | undefined) ?? [];
    const asked = docs.filter((d) => wanted.includes(d.code));
    if (asked.length > 0 || docs.length === 1)
      return this.sendDocs(
        asked.length > 0 ? asked : docs,
        polizaId,
        poliza,
        ctx,
        key,
      );

    this.setState(key, 'DOC_TYPE', {
      docs,
      polizaId,
      ...(poliza ? { poliza } : {}),
      ...(polizas.length > 1 ? { polizas } : {}),
    });
    return {
      messages: [
        docPicker(
          docs,
          wanted.length > 0
            ? '📄 No tengo ese documento de esta póliza, pero sí estos. ¿Cuál te mando?'
            : undefined,
        ),
      ],
    };
  }

  private async handleDocType(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const docs = (state.data.docs as PolizaDocumento[] | undefined) ?? [];
    const polizaId = state.data.polizaId as number | undefined;
    const t = fold(input.text);
    const poliza = state.data.poliza as PolizaSummary | undefined;

    if (
      input.selectionId === CLAIM_COPY_ID ||
      (!input.selectionId && CLAIM_COPY_RE.test(t))
    )
      return this.claimCopyRequest(
        input.selectionId === CLAIM_COPY_ID ? '' : input.text,
        ctx,
        key,
        poliza,
      );
    if (!input.selectionId && input.text.trim()) {
      // "Cupón": the coupons of this same policy, which the office sends.
      if (CUPON_RE.test(t))
        return poliza
          ? this.requestCupones([poliza], false, false, ctx, key, {
              debitFailed: DEBIT_FAILED_RE.test(t),
            })
          : this.guard(ctx, key, 'cupones', {}, input.text);
      if (OTHER_POLICY_RE.test(t)) return this.otherPolicyDocs(state, key);
    }

    let chosen: PolizaDocumento[] = [];
    if (
      input.selectionId === ALL_DOCS_ID ||
      (!input.selectionId && /\b(todos|todas|todo)\b/.test(t))
    ) {
      chosen = docs;
    } else {
      const codigo = this.parseStringRef(input.selectionId, DOC_PREFIX);
      const named = codigo ? [codigo] : wantedDocs(input.text);
      chosen = docs.filter((d) => named.includes(d.code));
      if (chosen.length === 0 && !codigo && input.text.trim()) {
        const match = this.matchDocByText(input.text, docs);
        chosen = docs.filter((d) => d.code === match);
      }
    }

    if (chosen.length === 0 || polizaId === undefined) {
      // The model reads it: it can pick the document, open what they ask for
      // or answer a question; state stays DOC_TYPE.
      return { messages: [], handoff: 'faq', onScreen: docPicker(docs) };
    }
    return this.sendDocs(
      chosen,
      polizaId,
      state.data.poliza as PolizaSummary | undefined,
      ctx,
      key,
    );
  }

  /**
   * Sends policy documents as PDFs in the chat. A document Triunfo does not
   * hand over goes to the office, as every document did before RESTDocumentosV2.
   */
  /**
   * A request typed where the bot asked which policy: the coupons go to the
   * office and a named paper ("la tarjeta verde") is kept for the policy they
   * pick next. Null for anything else.
   */
  private async docRequestTyped(
    input: UserInput,
    ctx: FlowContext,
    key: string,
    polizas: PolizaSummary[],
  ): Promise<FlowResult | null> {
    const t = fold(input.text);
    if (CUPON_RE.test(t))
      return this.guard(
        ctx,
        key,
        'cupones',
        { withDocs: DOCS_TOO_RE.test(t.replace(CUPON_RE, '')) },
        input.text,
      );
    const named = wantedDocs(input.text);
    if (named.length === 0) return null;
    const state = this.load(key)?.state;
    this.setState(key, 'DOC_POLIZA', {
      ...(state?.data ?? {}),
      polizas,
      wanted: named,
    });
    const what = joinNames(
      named.map((code) => DOC_SPOKEN[code] ?? 'ese papel'),
    );
    return {
      messages: [
        polizaPicker(polizas, `¿De qué póliza querés ${what}?`, {
          otherRow: true,
        }),
      ],
    };
  }

  /**
   * "Quiero de otra póliza" with the documents of one on screen: back to the
   * list of their policies, or, when they only have that one, to the office
   * with what they need.
   */
  private otherPolicyDocs(state: FlowState, key: string): FlowResult {
    const polizas = (state.data.polizas as PolizaSummary[] | undefined) ?? [];
    if (polizas.length > 1) {
      this.setState(key, 'DOC_POLIZA', { polizas });
      return {
        messages: [
          polizaPicker(polizas, '¿De qué póliza querés la documentación?', {
            otherRow: true,
          }),
        ],
      };
    }
    this.setState(key, 'DOC_POLIZA', { polizas });
    return (
      this.otherPoliza({ text: '', selectionId: OTHER_POLIZA_ID }, key) ?? {
        messages: [],
      }
    );
  }

  private async sendDocs(
    docs: PolizaDocumento[],
    polizaId: number,
    poliza: PolizaSummary | undefined,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const files: OutgoingMessage[] = [];
    const sent: PolizaDocumento[] = [];
    const failed: PolizaDocumento[] = [];
    for (const doc of docs) {
      try {
        const file = await this.api.getDocumentoPdf(
          ctx.conversationId,
          polizaId,
          doc.code,
        );
        files.push({ kind: 'document', body: '', ...file });
        sent.push(doc);
      } catch (error) {
        this.logger.warn(
          `No se pudo bajar ${doc.name} de la póliza ${polizaId}: ${(error as Error).message}`,
        );
        failed.push(doc);
      }
    }

    const of = poliza ? ` de tu ${polizaMention(poliza)}` : '';
    const lines: string[] = [];
    if (sent.length > 0) {
      lines.push(
        `Ahí te mandé ${joinNames(sent.map((d) => `*${d.name}*`))}${of} 🙌`,
      );
      if (
        sent.some(
          (d) => d.code === DOC_CODE.tarjeta || d.code === DOC_CODE.certificado,
        )
      )
        lines.push(
          sent.length === 1
            ? 'Lo podés mostrar desde el celular, no hace falta imprimirlo.'
            : 'Los podés mostrar desde el celular, no hace falta imprimirlos.',
        );
      // "No la del Mercosur, la de circular por la ciudad": it is the same
      // paper, and the customer got it twice with no word about it (#220).
      if (sent.some((d) => d.code === DOC_CODE.tarjeta))
        lines.push(
          'La *tarjeta verde (Mercosur)* es tu tarjeta de circulación: es la que mostrás si te paran, en Argentina y en los países del Mercosur.',
        );
    }
    if (failed.length > 0) {
      await this.api
        .requestHandoff(
          ctx.conversationId,
          `Pidió ${failed.map((d) => d.name).join(', ')}${poliza ? ` de su póliza ${polizaMention(poliza)}` : ''}. ` +
            'El bot no pudo bajarlo de Triunfo: enviárselo por este chat.',
        )
        .catch(() => undefined);
      lines.push(
        `No pude bajar ${joinNames(failed.map((d) => `*${d.name}*`))} ahora. Ya le pasé el pedido a la oficina para que te lo mande por este chat ` +
          `(${attentionHoursOf(ctx.attentionHours)}).` +
          (await this.closedNote()),
      );
    }

    this.setState(
      key,
      'CLIENT_MENU',
      failed.length > 0
        ? {
            requested: {
              action: 'documentos',
              what: 'la documentación',
              label: poliza ? `tu ${polizaLabel(poliza)}` : 'tu póliza',
            },
          }
        : {},
    );
    return {
      messages: [
        ...files,
        { kind: 'text', body: lines.join('\n') },
        clientMenu(),
      ],
    };
  }

  // ─── Asesor / leads ───────────────────────────────────────

  private async handleAsesorMotivo(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const current = this.load(key)?.state;
    if (current?.step === 'ASESOR_MOTIVO' && current.data.alerted === true)
      return this.addAdvisorReason(current, input, ctx, key);
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
    const otherFor =
      current?.step === 'ASESOR_MOTIVO' &&
      typeof current.data.otherPoliza === 'string'
        ? current.data.otherPoliza
        : null;
    const reason = same
      ? asked
      : otherFor
        ? `${otherFor} (no figura en el bot): ${input.text}`
        : input.text;
    // Mark the conversation as pending in the API so it surfaces in the admin
    // inbox. Best-effort: a failed call should not block the bot reply.
    await this.api
      .requestHandoff(ctx.conversationId, reason)
      .catch(() => undefined);
    return this.advisorNoted(ctx, key);
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
      // Not a category ("no, que me mandes la póliza que ya tengo"): the model
      // reads it and can pick the category or open what they ask for.
      return { messages: [], handoff: 'faq', onScreen: cotizarMenu() };
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
      if (!input.selectionId && input.text.trim()) {
        // "La Plus" picks it; "¿me explicás bien el bolso plus?" is a
        // question, which the model answers with the list still on screen.
        // Both got "No reconocí ese plan" (#202, 15/10).
        const t = fold(input.text);
        const named = plans.filter((p) => t.includes(fold(p.name)));
        const asking =
          /\?|\b(?:explic|que (?:incluye|cubre|tiene)|como|requisit|present|diferencia|cubre)/.test(
            t,
          );
        if (named.length === 1 && !asking)
          return this.handleCotPlan(
            state,
            { text: '', selectionId: `${PLAN_PREFIX}${named[0].id}` },
            ctx,
            key,
          );
        if (ctx.llmEnabled !== false && !ctx.llmRateLimited)
          return {
            messages: [],
            handoff: 'faq',
            onScreen: planPicker(productLabel, plans),
          };
      }
      // A stale tap, or no model to read it: re-show the picker, saying so,
      // with the way out.
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
    if (PAYMENT_CERTIFICATE_RE.test(t)) return 'documentos';
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
        /\btarjeta (verde|de circulacion|del seguro)\b|\bcertificado de cobertura\b|\bconstancia de (pago|cobertura)\b|\b(mis?) (polizas?|documentos?|documentacion|certificados?|cupon(es)?|cuponeras?)\b|\b(necesito|quiero|descargar|bajar|mandame|enviame|pasame) (la|el|mi|mis|los) (poliza|certificado|tarjeta|cupon|cupones|cuponera|documentacion)\b/.test(
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
    // What the customer was asking for goes with the description, or the
    // office reads "la del seguro de vida" without knowing it is a cancellation.
    const asking = OTHER_POLIZA_REQUEST[this.load(key)?.state.step ?? 'ROOT'];
    this.setState(key, 'ASESOR_MOTIVO', asking ? { otherPoliza: asking } : {});
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
    if (ctx.client || this.load(key)?.state.phoneDeclined) return null;
    const name = displayName(ctx.phoneMatch?.firstName, ctx.contactName);
    if (!name) return null;
    this.setState(key, 'IDENTIFY', {
      ...data,
      pendingAction: action,
      phoneConfirm: true,
    });
    return { messages: [phoneQuestion(name, opener)] };
  }

  private async phoneMatchRequest(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult | null> {
    const raw = input.text.trim();
    const name = state.phoneDeclined
      ? null
      : displayName(ctx.phoneMatch?.firstName, ctx.contactName);
    if (input.selectionId || !name || MAYBE_IDENTIFICATION_RE.test(raw))
      return null;
    const intent = await this.readIntent(input, ctx);
    if (!intent || intent === 'saludo' || intent === 'seguimiento') return null;
    const wanted = this.clientActionFor(intent, raw);
    if (wanted) {
      const question = questionOf(raw);
      this.setState(key, 'IDENTIFY', {
        ...withoutPhoneQuestion(state.data),
        pendingAction: wanted.action,
        ...(wanted.withDocs ? { pendingWithDocs: true } : {}),
        ...(question ? { pendingQuestion: question } : {}),
        ...(wanted.action === 'documentos' && wantedDocs(raw).length
          ? { pendingDocs: wantedDocs(raw) }
          : {}),
        phoneConfirm: true,
      });
      return {
        messages: [
          phoneQuestion(name, 'Dale, te ayudo con eso. Antes confirmame:'),
        ],
      };
    }
    // Something that needs no identification: a quote, a question, the tow truck.
    this.setState(key, 'ROOT', withoutPhoneQuestion(state.data));
    return this.routeOpening(input, ctx, key, null, intent);
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
        ...(Array.isArray(state.data.pendingDocs)
          ? { docs: state.data.pendingDocs as string[] }
          : {}),
      }),
    );
  }

  private declinePhoneMatch(
    state: FlowState,
    ctx: FlowContext,
    key: string,
  ): FlowResult {
    let result: FlowResult;
    // Answered to a greeting: they never said whether they are a client.
    if (state.data.fromGreeting) {
      this.setState(key, 'ROOT');
      result = { messages: [welcomeMenu(undefined, ctx.botName, 'none')] };
    } else result = this.askDniInstead(state, key, 'Dale.');
    // Asked again after "Sí, soy cliente", two people said "No" twice.
    const entry = this.states.get(key);
    if (entry) entry.state = { ...entry.state, phoneDeclined: true };
    return result;
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

  /**
   * A payment receipt: the office has to apply it, so it hears about it with
   * what the customer wrote, and the customer hears that it was passed on.
   */
  private async paymentProof(
    text: string,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    await this.api
      .requestHandoff(
        ctx.conversationId,
        `Envió un comprobante de pago para registrar: "${clip(text.trim())}".`,
      )
      .catch(() => undefined);
    const note = {
      kind: 'text' as const,
      body:
        `¡Gracias! 🙌 Le pasé el comprobante a la oficina para que registre el pago. Si falta algo, te escriben por este chat (${attentionHoursOf(ctx.attentionHours)}).` +
        (await this.closedNote()),
    };
    const audience = this.backToMenuState(key, ctx);
    if (audience === 'lead') return { messages: [note, leadMenu()] };
    if (audience === 'client') return { messages: [note, clientMenu()] };
    return { messages: [note] };
  }

  /** The customer's last messages before this one include a photo or a file. */
  private sentFileJustBefore(ctx: FlowContext): boolean {
    return (ctx.history ?? [])
      .slice(-4)
      .some(
        (m) =>
          m.role === 'user' &&
          /^\[El cliente envió (?:una foto|un archivo)/.test(m.content),
      );
  }

  /**
   * An identified client with no policy in force: often one that lapsed over
   * a missed payment, which nobody had told them about (#226 paid three months
   * with no cover). The office hears what they asked for and checks it.
   */
  private async noPolizas(
    key: string,
    ctx: FlowContext,
    what: string,
    asked?: string,
  ): Promise<FlowResult> {
    const question = questionOf(asked);
    await this.api
      .requestHandoff(
        ctx.conversationId,
        `Pidió ${what}${question ? ` ("${clip(question)}")` : ''}, pero no tiene pólizas vigentes en el sistema: puede estar anulada o suspendida por falta de pago, o a nombre de otra persona. Revisarlo con el cliente.`,
      )
      .catch(() => undefined);
    this.setState(
      key,
      'CLIENT_MENU',
      question ? { lastQuestion: question } : {},
    );
    return {
      messages: [
        {
          kind: 'text',
          body:
            'No encontré pólizas vigentes a tu nombre. Puede que esté vencida o suspendida, o a nombre de otra persona: ya le pasé tu consulta a la oficina para que la revise y te escriba por este chat ' +
            `(${attentionHoursOf(ctx.attentionHours)}).` +
            (await this.closedNote()),
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

  /**
   * "¿Cuál es el 0800 para denunciar?" (#148 got the claim checklist instead).
   * The company's line when it is configured; the claim can be made here too.
   */
  private claimsPhoneReply(key: string): FlowResult {
    this.setState(key, 'SINIESTRO_TYPE', {}, 'client');
    return {
      messages: [
        {
          kind: 'text',
          body: this.claimsPhone
            ? `📞 Para denunciar por teléfono a Triunfo Seguros: *${this.claimsPhone}* (es el mismo de asistencia: al entrar, elegí la opción de siniestros).\nTambién la podés hacer por acá y la oficina la carga en la compañía.`
            : 'La denuncia la podés hacer por acá: la oficina la carga en Triunfo Seguros y te pasa el número de siniestro.',
        },
        siniestroTypeMenu(),
      ],
    };
  }

  /**
   * A copy of a claim already filed: Triunfo does not give it to the bot, so
   * the office sends it (#205, #209), with the customer's words.
   */
  private async claimCopyRequest(
    text: string,
    ctx: FlowContext,
    key: string,
    poliza?: PolizaSummary,
  ): Promise<FlowResult> {
    const said = text.trim();
    await this.api
      .requestHandoff(
        ctx.conversationId,
        `Pide copia de la denuncia de siniestro${poliza ? ` de su ${polizaMention(poliza)}` : ''}${said ? `: "${clip(said)}"` : ''}.`,
      )
      .catch(() => undefined);
    const menu = this.settleAfterRequest(key, ctx);
    return {
      messages: [
        {
          kind: 'text',
          body:
            `La copia de la denuncia te la manda la oficina por este chat: ya les pasé tu pedido 🙌 (${attentionHoursOf(ctx.attentionHours)}).` +
            (await this.closedNote()),
        },
        ...menu,
      ],
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
      step === 'SINIESTRO_FOTO_TARJETA_DORSO' ||
      step === 'SINIESTRO_FOTO_CARNET' ||
      step === 'SINIESTRO_FOTO_CARNET_DORSO' ||
      step === 'SINIESTRO_TERCERO' ||
      step === 'SINIESTRO_TERCERO_TARJETA' ||
      step === 'SINIESTRO_TERCERO_TARJETA_DORSO' ||
      step === 'SINIESTRO_TERCERO_CARNET' ||
      step === 'SINIESTRO_TERCERO_CARNET_DORSO' ||
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
    // Before pagos: "el cupón de pago" asks for the coupon, not the debt, and
    // "la constancia de pago" for a document.
    if (CUPON_RE.test(t)) return OPT.cupones;
    if (PAYMENT_CERTIFICATE_RE.test(t)) return OPT.documentos;
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

    // A non-vehicle policy by its name ("la bicicleta", "el sepelio").
    const named = polizas.filter((p) => {
      const product = p.product ? fold(p.product).replace(/\./g, '') : '';
      const word = product.split(/\s+/)[0];
      return word.length > 3 && fold(t).includes(word.slice(0, 5));
    });
    if (named.length === 1) return named[0];

    let riskKeyword: string | null = null;
    if (/\bauto\b|\bcoche\b|\bveh[ií]culo\b/.test(t)) riskKeyword = 'auto';
    else if (/\bmoto\b|\bscooter\b/.test(t)) riskKeyword = 'moto';
    else if (/\bhogar\b|\bcasa\b|\bdepartamento\b|\bvivienda\b/.test(t))
      riskKeyword = 'home';
    else if (/\bcomercio\b|\blocal\b|\bnegocio\b/.test(t))
      riskKeyword = 'commercial';

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
  private matchDocByText(text: string, docs: PolizaDocumento[]): string | null {
    const t = fold(text);
    for (const doc of docs) {
      const words = fold(doc.name)
        .replace(/[()]/g, '')
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
      state: {
        step,
        data: next,
        audience: audience ?? prev?.audience,
        ...(prev?.phoneDeclined ? { phoneDeclined: true } : {}),
      },
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
