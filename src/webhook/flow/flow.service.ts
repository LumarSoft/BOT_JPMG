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
  clientMenu,
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
  siniestroConfirm,
  siniestroTypeMenu,
  welcomeMenu,
} from './flow.messages';
import type {
  CatalogField,
  ProductCatalogItem,
  ProductPlanSummary,
} from '../../api/api.types';
import { attentionHoursOf } from '../constants/business';

/**
 * Matches a message that is *only* a greeting ("hola", "buenas", "buen día"),
 * used to send the user back to the menu mid-session. Anchored so a greeting
 * with an actual request ("hola, quiero una denuncia") is NOT caught here and
 * still routes to its intent.
 */
const GREETING_RE =
  /^(?:hola+s?|holis|buenas|buen(?:os|as)?\s*(?:d[ií]as?|tardes?|noches?)?|buen\s*d[ií]a|hey+|qu[eé]\s+tal|saludos)[\s!.,¡?]*$/i;

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

/** Buttons for the "¿hubo un tercero?" step. */
const TERCERO_SI = 'sin_tercero_si';
const TERCERO_NO = 'sin_tercero_no';

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
  if (/\bayer\b/.test(t)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return fromDate(d);
  }
  if (/\b(anteayer|antes de ayer)\b/.test(t)) {
    const d = new Date();
    d.setDate(d.getDate() - 2);
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

/** Actions that require an identified client; resumed after IDENTIFY succeeds. */
type ClientAction =
  | 'pagos'
  | 'documentos'
  | 'siniestro_nueva'
  | 'siniestro_consultar';

/**
 * Deterministic conversation engine. The bot's transactional flows (menus,
 * identification, siniestros, pagos, documentos) are driven entirely by this
 * state machine — fixed copy, stable option ids, no LLM. The model is only
 * reached through the LLM_* steps (cotización and free-text questions), where
 * natural language actually adds value.
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

    // First contact (no state): greet and branch on whether they're a client.
    if (!existing) {
      if (ctx.client) {
        this.setState(key, 'CLIENT_MENU', {}, 'client');
        return {
          messages: [
            { kind: 'text', body: `¡Hola de nuevo, ${ctx.client.firstName}!` },
            clientMenu(),
          ],
        };
      }
      this.setState(key, 'ROOT');
      return { messages: [welcomeMenu(undefined, ctx.botName)] };
    }

    const sel = input.selectionId;

    // Global escape hatch: "menú" / the back option returns to the main menu.
    if (sel === OPT.menu || /^men[uú]$/i.test(input.text.trim())) {
      return this.toMainMenu(key, ctx);
    }

    // A standalone greeting mid-session means "take me back to the menu", not a
    // FAQ chat — deterministic and free, and honoring the declared audience.
    // Skipped for taps (selectionId) since those are never typed greetings.
    if (!sel && GREETING_RE.test(input.text.trim())) {
      return this.toMainMenu(key, ctx);
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
    // bulletproof "no te vayas por las ramas" — it never reaches the LLM.
    if (
      !sel &&
      this.isOffTopic(input.text) &&
      !this.isCapturingData(existing.state.step)
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
      case 'SINIESTRO_TYPE':
        return this.handleSiniestroType(input, ctx, key);
      case 'SINIESTRO_POLIZA':
        return this.handleSiniestroPoliza(state, input, key);
      case 'SINIESTRO_FECHA':
        return this.handleSiniestroFecha(state, input, key);
      case 'SINIESTRO_DESC':
        return this.handleSiniestroDesc(state, input, key);
      case 'SINIESTRO_CONFIRM':
        return this.handleSiniestroConfirm(state, input, ctx, key);
      case 'SINIESTRO_FOTO_TARJETA':
        return this.handleSinFotoTarjeta(input, key);
      case 'SINIESTRO_FOTO_CARNET':
        return this.handleSinFotoCarnet(input, key);
      case 'SINIESTRO_TERCERO':
        return this.handleSinTercero(input, key);
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
      this.setState(key, 'CLIENT_MENU', {}, 'client');
      return { messages: [clientMenu()] };
    }
    if (isLead) {
      this.setState(key, 'LEAD_MENU', {}, 'lead');
      return { messages: [leadMenu(ctx.botName)] };
    }

    // ── 2. Direct intent routing (before asking client/non-client) ──
    // Cotizar doesn't need identification → go straight to the quote flow
    // (jumping to the named category when the message already specifies one).
    if (/\bcotiz|\bpresupuest|\bcu[aá]nto.*seguro|\bprecio.*seguro/.test(t)) {
      return this.enterCotizar(input, ctx, key);
    }

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

    const cleaned = raw.replace(/[\s.-]/g, '');
    const params = /[a-zA-Z]/.test(cleaned)
      ? { plate: cleaned.toUpperCase() }
      : { dni: cleaned.replace(/\D/g, '') };

    try {
      await this.api.identifyClient(ctx.conversationId, params);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return {
          messages: [
            {
              kind: 'text',
              body: 'No encontré ningún cliente con ese dato. Verificá el DNI o la patente y mandámelo de nuevo, o escribí *asesor* si preferís que te contacten.',
            },
          ],
        };
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
        if (polizas.length === 0) return this.noPolizas(key);
        this.setState(key, 'SINIESTRO_POLIZA', { polizas });
        return {
          messages: [
            polizaPicker(polizas, '¿Sobre qué póliza es la denuncia?'),
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

  private handleSiniestroPoliza(
    state: FlowState,
    input: UserInput,
    key: string,
  ): FlowResult {
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
      return {
        messages: [
          polizaPicker(
            polizas,
            'No reconocí esa póliza. Elegí una de la lista, por favor:',
          ),
        ],
      };
    }

    this.setState(key, 'SINIESTRO_FECHA', { ...state.data, polizaId });
    return {
      messages: [
        {
          kind: 'text',
          body: '¿Qué día ocurrió el hecho? Escribilo como *DD/MM/AAAA* (o "hoy").',
        },
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
      return {
        messages: [
          {
            kind: 'text',
            body: 'No pude leer la fecha 🗓️. Decime *hoy* o *ayer*, o escribila como *DD/MM/AAAA* (por ejemplo 05/06/2026).',
          },
        ],
      };
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
          body: 'Contame brevemente qué pasó (y la hora y el lugar si los tenés).',
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
      return {
        messages: [
          {
            kind: 'text',
            body: 'Contame un poco más de qué pasó (cómo fue, y la hora y el lugar si los tenés).',
          },
        ],
      };
    }

    const polizas = (state.data.polizas as PolizaSummary[] | undefined) ?? [];
    const poliza = polizas.find((p) => p.id === state.data.polizaId);
    this.setState(key, 'SINIESTRO_CONFIRM', { ...state.data, descripcion });
    return {
      messages: [
        siniestroConfirm(
          poliza,
          state.data.fechaDisplay as string,
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
      return {
        messages: [
          siniestroConfirm(
            poliza,
            state.data.fechaDisplay as string,
            state.data.descripcion as string,
          ),
        ],
      };
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

  /** True when the user is skipping a photo step ("no", "no la tengo", "saltar"). */
  private isPhotoSkip(text: string): boolean {
    return /^(no|no la tengo|no las? tengo|no tengo|salt(ar|o|á)|omitir|siguiente|despu[eé]s|listo)\b/i.test(
      text.trim(),
    );
  }

  /** A photo step advances on a received photo (synthetic id) or an explicit skip. */
  private photoAdvances(input: UserInput): boolean {
    return input.selectionId === PHOTO_RECEIVED || (!input.selectionId && this.isPhotoSkip(input.text));
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

  private handleSinTercero(input: UserInput, key: string): FlowResult {
    const t = input.text.trim().toLowerCase();
    const yes = input.selectionId === TERCERO_SI || /^s[ií]\b/.test(t) || /\bhubo\b/.test(t);
    const no = input.selectionId === TERCERO_NO || /^no\b/.test(t);

    if (yes) {
      return this.askPhoto(
        key,
        'SINIESTRO_TERCERO_TARJETA',
        'Mandame la *foto de la tarjeta verde del tercero* (si la tenés). (o *no la tengo*)',
      );
    }
    if (no) return this.askDanio(key);

    return {
      messages: [
        {
          kind: 'buttons',
          body: 'Decime si hubo un tercero involucrado:',
          buttons: [
            { id: TERCERO_SI, title: 'Sí, hubo' },
            { id: TERCERO_NO, title: 'No' },
          ],
        },
      ],
    };
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
    await this.api.requestHandoff(ctx.conversationId).catch(() => undefined);
    void input;
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
    void input;
    await this.api.requestHandoff(ctx.conversationId).catch(() => undefined);
    this.setState(key, 'LEAD_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body:
            `¡Gracias! Tomé nota ✍️. Un representante de ventas te va a contactar a la brevedad (${attentionHoursOf(ctx.attentionHours)}).` +
            (await this.closedNote()),
        },
        leadMenu(ctx.botName),
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
    if (category) {
      this.setState(key, 'COTIZAR_TIPO');
      return this.handleCotizarTipo(
        { text: input.text, selectionId: category },
        ctx,
        key,
      );
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
      // Category not recognised — LLM helps clarify; state stays COTIZAR_TIPO.
      return { messages: [], handoff: 'faq' };
    }

    if (COTIZAR_ONLINE.has(opt)) {
      return this.startCotizacion(key, opt === OPT.cotMoto ? 'moto' : 'auto');
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
  private handleCotPlan(
    state: FlowState,
    input: UserInput,
    ctx: FlowContext,
    key: string,
  ): FlowResult {
    void ctx;
    const productType = state.data.productType as string;
    const productLabel =
      (state.data.productLabel as string | undefined) ?? 'Planes';
    const plans = (state.data.plans as ProductPlanSummary[] | undefined) ?? [];
    const planId = this.parsePrefId(input.selectionId, PLAN_PREFIX);
    const plan = plans.find((p) => p.id === planId);

    if (!plan) {
      // Couldn't resolve the plan — re-show the picker instead of leaking to the FAQ.
      return { messages: [planPicker(productLabel, plans)] };
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
      const retry =
        field.type === 'select'
          ? 'Elegí una de las opciones de la lista 🙂 '
          : field.numeric
            ? 'Necesito un *número* (sin texto). '
            : 'No te llegué a entender 🙈 ';
      return { messages: [this.fieldMessage(field, retry)] };
    }
    answers[field.label] = value;

    const nextIndex = index + 1;
    if (nextIndex < fields.length) {
      this.setState(key, 'COT_LEAD_FIELDS', {
        ...state.data,
        answers,
        fieldIndex: nextIndex,
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
      return {
        messages: [
          {
            kind: 'text',
            body: 'Decime tu *nombre y apellido* para que el asesor te ubique.',
          },
        ],
      };
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
      return {
        messages: [
          {
            kind: 'text',
            body: 'No reconocí el teléfono. Pasámelo con característica, por ejemplo *341 555-0000*.',
          },
        ],
      };
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

  private startCotizacion(key: string, vehiculo: 'auto' | 'moto'): FlowResult {
    this.setState(key, 'LLM_COTIZACION', { vehiculo });
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

  /** Keyword routing so typed text (not just taps) reaches a quote category. */
  private matchCotizarCategory(text: string): string | null {
    const t = text.toLowerCase();
    if (/auto|coche|veh[ií]culo|camioneta|pick/.test(t)) return OPT.cotAuto;
    if (/moto|scooter|ciclomotor/.test(t)) return OPT.cotMoto;
    if (/bici|bicicleta|mtb|rodado/.test(t)) return OPT.cotBici;
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

    const intent = this.matchGlobalIntent(input.text);
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
  ):
    | 'grua'
    | 'siniestro'
    | 'pago'
    | 'documentos'
    | 'asesor'
    | 'cotizar'
    | null {
    const t = text.toLowerCase();
    if (/\bgr[uú]a\b|\bauxilio\b|\bremolque\b/.test(t)) return 'grua';
    if (
      /\bsiniestro\b|\bdenuncia\b|\bdenunciar\b|\bme chocaron\b|\bme robaron\b/.test(
        t,
      )
    )
      return 'siniestro';
    if (/\bpagar\b|\bpagos?\b|\bcuota\b|\bdeuda\b|\bvencimiento\b/.test(t))
      return 'pago';
    if (
      /\btarjeta\b|\bcertificad|\bcup[oó]n\b|\bdocumentaci[oó]n\b|\bdocumentos?\b/.test(
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
    if (/\bcotizar\b|\bcotizaci[oó]n\b|\bpresupuest/.test(t)) return 'cotizar';
    return null;
  }

  // ─── Shared helpers ───────────────────────────────────────

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
      return { messages: [leadMenu(ctx.botName)] };
    }
    this.setState(key, 'ROOT');
    return { messages: [welcomeMenu(undefined, ctx.botName)] };
  }

  private noPolizas(key: string): FlowResult {
    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body: 'No encontré pólizas asociadas a tu cuenta. Si creés que es un error, escribí *asesor* y te ayudamos.',
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
   * Detects a question about opening hours ("¿qué horario tienen?", "¿están
   * abiertos?", "¿a qué hora abren?"). Deliberately specific so it doesn't fire
   * on ordinary text — note "ahora" is not matched (no word boundary before
   * "hora").
   */
  /**
   * Detects clearly off-domain requests (programming, math, recipes, translations,
   * jokes, write-this-for-me, general trivia) so the bot refuses deterministically
   * instead of letting the LLM wander. Tight patterns to avoid false positives on
   * real insurance questions.
   */
  private isOffTopic(text: string): boolean {
    const t = text.toLowerCase();
    return (
      // Programming / tech
      /\b(javascript|typescript|python|java|kotlin|c\+\+|c#|php|html|css|sql|node|react|bash|powershell)\b/.test(t) ||
      /\b(hello world|console\.log|c[oó]digo|codigo|programar|programaci[oó]n|funci[oó]n|algoritmo|script|compilar|debug)\b/.test(
        t,
      ) ||
      // Math / homework
      /\b(ecuaci[oó]n|integral|derivada|factoriz|teorema|resolv[eé] (este|el) (c[aá]lculo|problema))\b/.test(t) ||
      // Creative / generic assistant abuse
      /\b(receta|cocinar|poema|poes[ií]a|chiste|cuento|ensayo|redact[aá]|traduc[ií]|traducci[oó]n)\b/.test(t) ||
      /\b(qui[eé]n (es|fue|gan[oó])|capital de|cu[aá]nto es \d)\b/.test(t)
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

  private isHoursQuestion(text: string): boolean {
    const t = text.toLowerCase();
    return (
      /\bhorarios?\b/.test(t) ||
      /\b(a|hasta)\s+qu[eé]\s+hora\b/.test(t) ||
      /\bqu[eé]\s+hora\b/.test(t) ||
      /\best[aá]n?\s+abiert/.test(t) ||
      /\babren\b|\bcierran\b|\batienden\b/.test(t) ||
      /\bqu[eé]\s+d[ií]as?\s+(abren|atienden|trabajan)/.test(t)
    );
  }

  /** Steps where free text is the user's data — never hijack those for hours. */
  private isCapturingData(step: FlowStep): boolean {
    return (
      step === 'IDENTIFY' ||
      step === 'SINIESTRO_FECHA' ||
      step === 'SINIESTRO_DESC' ||
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
      step === 'SINIESTRO_FOTO_DANIO'
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
    const t = text.toLowerCase();
    if (/siniestro|denuncia|choque|accidente|rob/.test(t))
      return OPT.siniestros;
    if (/cotiz|precio|presupuesto|seguro nuevo/.test(t)) return OPT.cotizacion;
    if (/pago|cuota|deuda|deb[ií]to|cobr|rechaz/.test(t)) return OPT.pagos;
    if (/document|p[oó]liza|tarjeta|certificado|cup[oó]n/.test(t))
      return OPT.documentos;
    if (/gr[uú]a|auxilio|remolque|asistencia/.test(t)) return OPT.grua;
    if (/asesor|humano|persona|hablar|representante/.test(t)) return OPT.asesor;
    return null;
  }

  private matchLeadIntent(text: string): string | null {
    const t = text.toLowerCase();
    if (/\bcotiz|\bpresupuest|\bseguro|\bp[oó]liza|\bcobertura/.test(t))
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
    const prev = this.states.get(key)?.state.audience;
    this.states.set(key, { state: { step, data, audience: audience ?? prev } });
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
