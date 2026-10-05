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
  botIntro,
  clientMenu,
  CLIENT_MENU_OPTS,
  cotizarMenu,
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
  OPT,
  PLAN_PREFIX,
  planDetails,
  planPicker,
  POLIZA_PREFIX,
  polizaPicker,
  returningGreeting,
  ROOT_OPTS,
  siniestroConfirm,
  siniestroTypeMenu,
  stuckMenu,
  welcomeMenu,
} from './flow.messages';
import type {
  CatalogField,
  ProductCatalogItem,
  ProductPlanSummary,
} from '../../api/api.types';
import { attentionHoursOf } from '../constants/business';
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

/** A message that asks for a quote. Run against folded text (see `fold`). */
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
  COT_DOC_TARJETA_AZUL: 'tarjeta_azul',
};

/** First prompt of the take-out documents, sent right after a coverage is chosen. */
export const TAKE_OUT_DOCS_INTRO =
  'Para avanzar con la contratación necesito unas fotos 📸:\n' +
  '• *DNI* (frente y dorso)\n' +
  '• *Tarjeta azul*\n\n' +
  'Empecemos: mandame una foto del *frente de tu DNI*. (si no la tenés a mano, escribí *no la tengo*)';

/**
 * Flow snapshot that opens the take-out documents for the lead the quote model
 * just created (see webhook.service). The lead id travels in the state so each
 * photo lands on that lead; the declared audience is kept.
 */
export function takeOutDocsState(
  prev: FlowState | null,
  leadId: number,
): FlowState {
  return {
    step: 'COT_DOC_DNI_FRENTE',
    data: { leadId },
    ...(prev?.audience ? { audience: prev.audience } : {}),
  };
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
  | 'siniestro_nueva'
  | 'siniestro_consultar'
  | 'baja_poliza';

/**
 * Deterministic conversation engine. The bot's transactional flows (menus,
 * identification, siniestros, pagos, documentos) are driven entirely by this
 * state machine — fixed copy, stable option ids, no LLM. The model is only
 * reached through the LLM_* steps (cotización and free-text questions), where
 * natural language actually adds value. The one exception is reading the
 * claim checklist (SINIESTRO_DATOS, see SiniestroExtractor): the flow still
 * validates, asks for what is missing and confirms before filing.
 *
 * State is durable: the API persists the `{ step, data }` snapshot per
 * conversation and hands it back on the next message. `handle` rehydrates from
 * it and returns the new snapshot to persist, so the bot is effectively
 * stateless and resumes the exact step after a restart or deploy. Session expiry
 * is owned solely by the API (SESSION_TIMEOUT_MINUTES); the in-memory `states`
 * map is just a per-turn scratchpad (filled on hydrate, cleared after handle).
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
    const existing = this.load(key);
    const sel = input.selectionId;
    // Payment proofs and missing credits need human review. Policy cancellations
    // keep the dedicated identification, policy selection and confirmation flow.
    if (
      !sel &&
      /\b(ya pague|envio (?:el |un )?comprobante|adjunto (?:el |un )?comprobante|no (?:se )?(?:acredito|acredita) (?:mi |el )?pago)\b/.test(
        fold(input.text),
      )
    ) {
      return this.handleAsesorMotivo(input, ctx, key);
    }

    // First contact (no state): greet and branch on whether they're a client.
    if (!existing) {
      if (ctx.client) {
        const hello = returningGreeting(ctx.client.firstName);
        this.setState(key, 'CLIENT_MENU', {}, 'client');
        // The message that reopened the chat must not be lost. The old menu is
        // still on the user's screen after a session expires, so a returning
        // client taps "Pagos" and used to get only the greeting + the menu
        // again. If the tap (or the text) names a menu option, answer it in the
        // same turn. Stale ids from a picker (plan_/pol_) aren't menu options,
        // so they correctly fall through to the menu.
        const opt = sel ?? this.matchClientIntent(input.text);
        if (opt && CLIENT_MENU_OPTS.has(opt)) {
          return this.prepend(
            hello,
            await this.handleClientMenu(
              { ...input, selectionId: opt },
              ctx,
              key,
            ),
          );
        }
        return this.rememberGreeting(
          key,
          input.text,
          { messages: [{ kind: 'text', body: hello }, clientMenu()] },
          !sel && GREETING_RE.test(input.text.trim()),
        );
      }
      this.setState(key, 'ROOT');
      // Same for someone we can't identify: a tap on "Sí, soy cliente" /
      // "Todavía no" still routes instead of being answered with the very
      // question it just answered.
      if (sel && ROOT_OPTS.has(sel)) {
        return this.handleRoot(input, ctx, key);
      }
      // The very first message already asks for a quote ("hola, quiero cotizar
      // mi auto"): a quote doesn't need "¿ya sos cliente?", and every extra
      // round-trip is one more billed message and one more wait. Introduce
      // ourselves in the same message — or let the quote model do it when it
      // answers directly (its prompt introduces itself on a first message).
      if (!sel && QUOTE_INTENT_RE.test(fold(input.text))) {
        const result = await this.enterCotizar(input, ctx, key);
        return result.handoff
          ? result
          : this.prepend(`¡Hola! ${botIntro(ctx.botName)} 👋`, result);
      }
      if (this.matchClientIntent(input.text) === OPT.bajaPoliza)
        return this.guard(ctx, key, 'baja_poliza');
      return this.rememberGreeting(
        key,
        input.text,
        { messages: [welcomeMenu(undefined, ctx.botName)] },
        !sel && GREETING_RE.test(input.text.trim()),
      );
    }

    // Global escape hatch: "menú" / the back option returns to the main menu.
    if (sel === OPT.menu || /^men[uú]$/i.test(input.text.trim())) {
      return this.toMainMenu(key, ctx);
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
        return this.handleSiniestroType(input, ctx, key);
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
        return this.handleTakeOutDoc(state, input, key, {
          next: 'COT_DOC_DNI_DORSO',
          ask: 'Perfecto. Ahora el *dorso del DNI*. (si no la tenés, escribí *no la tengo*)',
        });
      case 'COT_DOC_DNI_DORSO':
        return this.handleTakeOutDoc(state, input, key, {
          next: 'COT_DOC_TARJETA_AZUL',
          ask: 'Genial. Por último, una foto de la *tarjeta azul*. (si no la tenés, escribí *no la tengo*)',
        });
      case 'COT_DOC_TARJETA_AZUL':
        return this.finishTakeOutDocs(state, input, ctx, key);
      case 'LLM_FAQ':
        return this.handleLlm(input, key, 'faq');
      default:
        return this.toMainMenu(key, ctx);
    }
  }

  // ─── Root / menus ─────────────────────────────────────────

  private handleRoot(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): FlowResult | Promise<FlowResult> {
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
      this.setState(key, 'IDENTIFY', { pendingAction: 'menu' }, 'client');
      return {
        messages: [
          {
            kind: 'text',
            body: '¡Genial! Para ayudarte necesito identificarte. Pasame el *DNI del titular* o la *patente* del vehículo asegurado.\n\n_Escribí *menú* para volver o *finalizar* para terminar._',
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
      return this.guard(ctx, key, 'baja_poliza');

    // Client-scoped intents → acknowledge + re-ask with the welcome menu buttons.
    if (
      /\bsiniestro|\bdenuncia|\baccidente|\bchoque|\brob|\bp[oó]liza|\bpago|\bcuota|\bdocument|\btarjeta|\bgr[uú]a|\bauxilio|\bcobertura/.test(
        t,
      )
    ) {
      return {
        messages: [
          {
            kind: 'text',
            body: 'Claro, con gusto te ayudo. Para eso primero necesito saber si ya sos cliente nuestro:',
          },
          welcomeMenu(ctx.client?.firstName, ctx.botName),
        ],
      };
    }

    // ── 3. Last resort: LLM responds naturally (state stays ROOT) ──
    return { messages: [], handoff: 'faq' };
  }

  private async handleClientMenu(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const opt = input.selectionId ?? this.matchClientIntent(input.text);

    switch (opt) {
      case OPT.siniestros:
        this.setState(key, 'SINIESTRO_TYPE');
        return { messages: [siniestroTypeMenu()] };
      case OPT.cotizacion:
        return this.enterCotizar(input, ctx, key);
      case OPT.pagos:
        return this.guard(ctx, key, 'pagos');
      case OPT.bajaPoliza:
        return this.guard(ctx, key, 'baja_poliza');
      case OPT.documentos:
        return this.guard(ctx, key, 'documentos');
      case OPT.grua:
        return {
          messages: [{ kind: 'text', body: this.gruaText() }, clientMenu()],
        };
      case OPT.asesor:
        this.setState(key, 'ASESOR_MOTIVO');
        return {
          messages: [
            {
              kind: 'text',
              body: `Contame brevemente el motivo y un asesor te contacta a la brevedad (${attentionHoursOf(ctx.attentionHours)}).`,
            },
          ],
        };
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
      return this.guard(ctx, key, 'baja_poliza');
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

  /** Routes a client action: asks to identify first if needed, else runs it. */
  private async guard(
    ctx: FlowContext,
    key: string,
    action: ClientAction,
  ): Promise<FlowResult> {
    if (!ctx.client) {
      this.setState(key, 'IDENTIFY', { pendingAction: action });
      return {
        messages: [
          {
            kind: 'text',
            body: 'Para acceder a tus datos necesito identificarte. Pasame el *DNI del titular* o la *patente* del vehículo asegurado.\n\n_Escribí *menú* para volver o *finalizar* para terminar._',
          },
        ],
      };
    }
    return this.runAction(action, ctx, key);
  }

  private async handleIdentify(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const raw = input.text.trim();
    if (!raw) {
      return {
        messages: [
          {
            kind: 'text',
            body: 'Pasame el *DNI del titular* o la *patente* para identificarte.',
          },
        ],
      };
    }

    // The not-found reply offers "escribí *asesor*": honor it instead of
    // reading the word as a plate.
    if (/\basesor/i.test(raw)) {
      return this.handleClientMenu(
        { ...input, selectionId: OPT.asesor },
        ctx,
        key,
      );
    }

    const cleaned = raw.replace(/[\s.-]/g, '');
    const params = /[a-zA-Z]/.test(cleaned)
      ? { plate: cleaned.toUpperCase() }
      : { dni: cleaned.replace(/\D/g, '') };

    try {
      await this.api.identifyClient(ctx.conversationId, params);
    } catch (error) {
      // 400 = the API rejected the shape (a DNI/plate of the wrong length, e.g.
      // "no me acuerdo"); for the user that's the same as not finding them.
      const status = axios.isAxiosError(error) ? error.response?.status : 0;
      if (status === 404 || status === 400) {
        return this.retry(key, state, [
          {
            kind: 'text',
            body: 'No encontré ningún cliente con ese dato. Verificá el DNI o la patente y mandámelo de nuevo, o escribí *asesor* si preferís que te contacten.',
          },
        ]);
      }
      throw error;
    }

    const action = (state.data.pendingAction as ClientAction) ?? 'pagos';
    // ctx.client is still null in this request, but identifyClient persisted the
    // link, so the conversation-scoped action calls resolve the client fine.
    return this.prepend(
      '✅ ¡Listo, te identifiqué!',
      await this.runAction(action, ctx, key),
    );
  }

  /** Runs a client action assuming the conversation already has a client. */
  private async runAction(
    action: ClientAction,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    switch (action) {
      case 'menu':
        this.setState(key, 'CLIENT_MENU');
        return { messages: [clientMenu()] };
      case 'pagos': {
        const estado = await this.api.getEstadoCuenta(ctx.conversationId);
        this.setState(key, 'CLIENT_MENU');
        return {
          messages: [
            { kind: 'text', body: formatEstadoCuenta(estado) },
            clientMenu(),
          ],
        };
      }
      case 'siniestro_consultar': {
        const siniestros = await this.api.getSiniestros(ctx.conversationId);
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
            polizaPicker(polizas, '¿De qué póliza querés solicitar la baja?'),
          ],
        };
      }
      case 'documentos': {
        const polizas = await this.api.getPolizas(ctx.conversationId);
        if (polizas.length === 0) return this.noPolizas(key);
        this.setState(key, 'DOC_POLIZA', { polizas });
        return {
          messages: [
            polizaPicker(polizas, '¿De qué póliza querés la documentación?'),
          ],
        };
      }
    }
  }

  private handleBajaPoliza(
    state: FlowState,
    input: UserInput,
    key: string,
  ): FlowResult {
    const polizas = state.data.polizas as PolizaSummary[];
    const id = this.parsePrefId(input.selectionId, POLIZA_PREFIX);
    const poliza =
      polizas.find((p) => p.id === id) ??
      this.matchPolizaByText(input.text, polizas);
    if (!poliza)
      return this.retry(key, state, [
        polizaPicker(polizas, 'Elegí la póliza para solicitar la baja.'),
      ]);
    this.setState(key, 'BAJA_CONFIRM', { ...state.data, polizaId: poliza.id });
    return { messages: [this.bajaConfirmMessage(poliza)] };
  }

  private bajaConfirmMessage(poliza: PolizaSummary): OutgoingMessage {
    return {
      kind: 'buttons',
      body: `¿Confirmás que querés solicitar la baja de la póliza *${poliza.certificado}*${poliza.vehiculo?.dominio ? ` (${poliza.vehiculo.dominio})` : ''}? La oficina recibirá el pedido y te confirmará cuándo queda efectiva.`,
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
          body: `Registré tu solicitud de baja de la póliza *${poliza.certificado}*. La oficina recibió la notificación y te confirmará la gestión. La póliza todavía no fue dada de baja.`,
        },
      ],
    };
  }

  // ─── Siniestros ───────────────────────────────────────────

  private async handleSiniestroType(
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    const opt = input.selectionId ?? this.matchSiniestroIntent(input.text);
    if (opt === OPT.sinNueva) return this.guard(ctx, key, 'siniestro_nueva');
    if (opt === OPT.sinConsultar)
      return this.guard(ctx, key, 'siniestro_consultar');
    return { messages: [], handoff: 'faq' };
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
    const pago = poliza.estadoPago;
    if (pago && !pago.alDia) {
      // Reason worded so the office files it under siniestros, not pagos
      // (see classifyMatter in the API: payment words take precedence).
      const motivo =
        pago.cuotasRechazadas > 0
          ? 'un cobro rechazado'
          : 'saldo vencido impago';
      return this.siniestroBloqueado(
        key,
        ctx,
        `Denuncia de siniestro no registrada: la póliza ${poliza.certificado} figura con ${motivo}.`,
        pago.cuotasRechazadas > 0
          ? `La póliza *${poliza.certificado}* registra un *pago rechazado*, así que no puedo tomar la denuncia automáticamente: la cobertura puede estar suspendida hasta regularizarlo.`
          : `La póliza *${poliza.certificado}* registra *cuotas vencidas sin pagar*, así que no puedo tomar la denuncia automáticamente: la cobertura puede estar suspendida hasta regularizarlas.`,
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
      polizaId: state.data.polizaId as number,
      tipo: this.tipoFromRisk(poliza?.riskType),
      fecha: state.data.fechaIso as string,
      descripcion: state.data.descripcion as string,
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
    return /^(no+|nop|no la tengo|no las? tengo|no tengo|salt(ar|o|a)|omitir|siguiente|despues|list[oa]+|ya (esta|fue|termine)|termine|eso es todo|nada mas|fin)\b/.test(
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
      'Y por último, la *foto del carnet de conducir del tercero*. (o *no la tengo*)',
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
            body: '📎 Recibí la foto y la sumé a tu denuncia. Si tenés *más fotos del siniestro*, mandámelas. Cuando termines, escribí *listo*.',
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
  private handleTakeOutDoc(
    state: FlowState,
    input: UserInput,
    key: string,
    step: { next: FlowStep; ask: string },
  ): FlowResult {
    if (!this.photoAdvances(input)) {
      return this.retry(key, state, this.retryPhoto().messages);
    }
    this.setState(key, step.next, { leadId: state.data.leadId });
    return { messages: [{ kind: 'text', body: step.ask }] };
  }

  private async finishTakeOutDocs(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): Promise<FlowResult> {
    if (!this.photoAdvances(input)) {
      return this.retry(key, state, this.retryPhoto().messages);
    }
    return this.prepend(
      '¡Listo! 🙌 Ya tenemos todo para tu contratación. Un asesor te contacta ' +
        `para terminarla (${attentionHoursOf(ctx.attentionHours)}).` +
        (await this.closedNote()),
      this.toMainMenu(key, ctx),
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
    let polizaId = this.parsePrefId(input.selectionId, POLIZA_PREFIX);

    if (
      (polizaId === null || !polizas.some((p) => p.id === polizaId)) &&
      input.text.trim()
    ) {
      const match = this.matchPolizaByText(input.text, polizas);
      if (match) polizaId = match.id;
    }

    if (polizaId === null || !polizas.some((p) => p.id === polizaId)) {
      // Can't resolve policy — LLM asks naturally; state stays DOC_POLIZA.
      return { messages: [], handoff: 'faq' };
    }

    const docs = await this.api.getDocumentos(ctx.conversationId, polizaId);
    if (docs.length === 0) {
      this.setState(key, 'CLIENT_MENU');
      return {
        messages: [
          {
            kind: 'text',
            body: 'No encontré documentos disponibles para esa póliza. Te derivo con un asesor para que te los gestione.',
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
        | { codigo: string; nombre: string; url: string }[]
        | undefined) ?? [];
    let codigo = this.parseStringRef(input.selectionId, DOC_PREFIX);

    if (!codigo && input.text.trim()) {
      codigo = this.matchDocByText(input.text, docs);
    }

    const doc = docs.find((d) => d.codigo === codigo);

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
    // Mark the conversation as pending in the API so it surfaces in the admin
    // inbox. Best-effort: a failed call should not block the bot reply.
    await this.api
      .requestHandoff(ctx.conversationId, input.text)
      .catch(() => undefined);
    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body:
            `Listo, tomé nota ✍️. Un asesor te va a contactar dentro del horario de atención (${attentionHoursOf(ctx.attentionHours)}).` +
            (await this.closedNote()),
        },
        clientMenu(),
      ],
    };
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
      return this.startCotizacion(key, undefined, input);
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
        return this.startCotizacion(key, undefined, input);
      }
      // Category not recognised — LLM helps clarify; state stays COTIZAR_TIPO.
      return { messages: [], handoff: 'faq' };
    }

    if (COTIZAR_ONLINE.has(opt)) {
      return this.startCotizacion(
        key,
        opt === OPT.cotMoto ? 'moto' : 'auto',
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
      this.toMainMenu(key, ctx),
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
    input?: UserInput,
  ): FlowResult {
    this.setState(key, 'LLM_COTIZACION', vehiculo ? { vehiculo } : {});
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
      return this.guard(ctx, key, 'baja_poliza');
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
      /\btarjeta\b|\bcertificad|\bcupon\b|\bdocumentacion\b|\bdocumentos?\b/.test(
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
        /\b(mis?) (cuotas?|pagos?|deudas?|vencimientos?)\b|\bpagar (mi|mis)\b|\bestado de (cuenta|pagos?)\b|\bcuanto debo\b|\bdeuda\b|\bcupon de pago\b/.test(
          t,
        )
      )
        return 'pago';
      if (
        /\btarjeta (verde|de circulacion|del seguro)\b|\bcertificado de cobertura\b|\b(mis?) (polizas?|documentos?|documentacion|certificados?|cupon(es)?)\b|\b(necesito|quiero|descargar|bajar|mandame|enviame|pasame) (la|el|mi|mis) (poliza|certificado|tarjeta|cupon|documentacion)\b/.test(
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
    return { messages: [welcomeMenu(undefined, ctx.botName)] };
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
    const t = text.toLowerCase();
    if (
      /\bnuev[ao]|\bdenunci|\breportar|\bregistr|\bquiero hacer|\bocurri|\btuve|\bchoque|\baccidente/.test(
        t,
      )
    )
      return OPT.sinNueva;
    if (/\bconsultar|\bver\b|\bestado|\bmis\b|\btengo\b|\bya ten[ií]a/.test(t))
      return OPT.sinConsultar;
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
      const dom = p.vehiculo?.dominio;
      if (dom && t.includes(dom.toLowerCase())) return p;
    }

    for (const p of polizas) {
      const v = p.vehiculo;
      if (!v) continue;
      const terms = [v.marca, v.modelo]
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
    docs: { codigo: string; nombre: string; url: string }[],
  ): string | null {
    const t = text.toLowerCase();
    for (const doc of docs) {
      const words = doc.nombre
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 4);
      if (words.length > 0 && words.some((w) => t.includes(w)))
        return doc.codigo;
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
