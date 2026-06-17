import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ApiService } from '../../api/api.service';
import type { PolizaSummary } from '../../api/api.types';
import type {
  FlowContext,
  FlowResult,
  FlowState,
  FlowStep,
  UserInput,
} from './flow.types';
import {
  clientMenu,
  docPicker,
  DOC_PREFIX,
  formatDocumento,
  formatEstadoCuenta,
  formatSiniestros,
  leadMenu,
  OPT,
  POLIZA_PREFIX,
  polizaPicker,
  siniestroConfirm,
  siniestroTypeMenu,
  welcomeMenu,
} from './flow.messages';

/** How long an idle flow state is kept in memory before it's pruned. */
const STATE_TTL_MS = 60 * 60 * 1000;

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

  if (t === 'hoy') return fromDate(new Date());
  if (t === 'ayer') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return fromDate(d);
  }

  let y: number, mo: number, day: number;
  const dmy = t.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  const ymd = t.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (dmy) {
    day = Number(dmy[1]);
    mo = Number(dmy[2]);
    y = Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]);
  } else if (ymd) {
    y = Number(ymd[1]);
    mo = Number(ymd[2]);
    day = Number(ymd[3]);
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
 * State lives in memory keyed by `${phoneNumberId}:${waId}`, mirroring the
 * dedup/queue maps already in webhook.service. It survives between messages but
 * not a process restart; a returning user simply gets the menu again.
 */
@Injectable()
export class FlowService {
  private readonly logger = new Logger(FlowService.name);
  private readonly states = new Map<
    string,
    { state: FlowState; touchedAt: number }
  >();

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
  ): Promise<FlowResult> {
    // A fresh session always restarts the flow.
    if (ctx.newSession) this.states.delete(key);

    const existing = this.load(key);

    // First contact (no state): greet and branch on whether they're a client.
    if (!existing) {
      if (ctx.client) {
        this.setState(key, 'CLIENT_MENU');
        return {
          messages: [
            { kind: 'text', body: `¡Hola de nuevo, ${ctx.client.firstName}!` },
            clientMenu(),
          ],
        };
      }
      this.setState(key, 'ROOT');
      return { messages: [welcomeMenu()] };
    }

    const sel = input.selectionId;

    // Global escape hatch: "menú" / the back option returns to the main menu.
    if (sel === OPT.menu || /^men[uú]$/i.test(input.text.trim())) {
      return this.toMainMenu(key, ctx);
    }

    try {
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
        return this.handleLeadMenu(input, key);
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
      case 'DOC_POLIZA':
        return this.handleDocPoliza(state, input, ctx, key);
      case 'DOC_TYPE':
        return this.handleDocType(state, input, key);
      case 'ASESOR_MOTIVO':
        return this.handleAsesorMotivo(input, key);
      case 'LEAD_CONTACT':
        return this.handleLeadContact(input, key);
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
  ): FlowResult {
    const t = input.text.toLowerCase();
    const isClient =
      input.selectionId === OPT.cliente ||
      (/cliente/.test(t) && !/no\b/.test(t));
    const isLead =
      input.selectionId === OPT.noCliente ||
      /^no\b/.test(t) ||
      /no.*cliente/.test(t);

    if (isClient) {
      this.setState(key, 'CLIENT_MENU');
      return { messages: [clientMenu()] };
    }
    if (isLead) {
      this.setState(key, 'LEAD_MENU');
      return { messages: [leadMenu()] };
    }
    return { messages: [welcomeMenu(ctx.client?.firstName)] };
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
        return this.startCotizacion(key);
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
              body: 'Contame brevemente el motivo y un asesor te contacta a la brevedad (Lun a Vie de 8 a 16 hs).',
            },
          ],
        };
      default:
        return {
          messages: [
            { kind: 'text', body: 'No te entendí. Elegí una opción 👇' },
            clientMenu(),
          ],
        };
    }
  }

  private handleLeadMenu(input: UserInput, key: string): FlowResult {
    switch (input.selectionId) {
      case OPT.leadCotizar:
        return this.startCotizacion(key);
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
        return { messages: [leadMenu()] };
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
            body: 'Para acceder a tus datos necesito identificarte. Pasame el *DNI del titular* o la *patente* del vehículo asegurado.',
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
    if (input.selectionId === OPT.sinNueva) {
      return this.guard(ctx, key, 'siniestro_nueva');
    }
    if (input.selectionId === OPT.sinConsultar) {
      return this.guard(ctx, key, 'siniestro_consultar');
    }
    return { messages: [siniestroTypeMenu()] };
  }

  private handleSiniestroPoliza(
    state: FlowState,
    input: UserInput,
    key: string,
  ): FlowResult {
    const polizas = (state.data.polizas as PolizaSummary[] | undefined) ?? [];
    const polizaId = this.parsePrefId(input.selectionId, POLIZA_PREFIX);

    if (polizaId === null || !polizas.some((p) => p.id === polizaId)) {
      return {
        messages: [polizaPicker(polizas, 'Elegí una póliza de la lista 👇')],
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
      return {
        messages: [
          {
            kind: 'text',
            body: 'No entendí la fecha. Escribila como *DD/MM/AAAA*, por ejemplo 17/06/2026.',
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
      return {
        messages: [
          {
            kind: 'text',
            body: 'Necesito un poco más de detalle sobre lo ocurrido.',
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
    if (input.selectionId === OPT.cancelar) {
      this.setState(key, 'CLIENT_MENU');
      return {
        messages: [
          { kind: 'text', body: 'Cancelé la denuncia. ¿Algo más?' },
          clientMenu(),
        ],
      };
    }
    if (input.selectionId !== OPT.confirmar) {
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

    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body:
            `✅ Registré tu denuncia (N° interno *${siniestro.id}*).\n` +
            `La oficina la va a cargar en Triunfo Seguros y te vamos a informar el número de siniestro oficial.\n\n` +
            `📸 Si tenés *fotos del daño*, mandámelas por este chat y las adjunto automáticamente a la denuncia.`,
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
    const polizaId = this.parsePrefId(input.selectionId, POLIZA_PREFIX);

    if (polizaId === null || !polizas.some((p) => p.id === polizaId)) {
      return {
        messages: [polizaPicker(polizas, 'Elegí una póliza de la lista 👇')],
      };
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
    const codigo = this.parseStringRef(input.selectionId, DOC_PREFIX);
    const doc = docs.find((d) => d.codigo === codigo);

    if (!doc) return { messages: [docPicker(docs)] };

    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [{ kind: 'text', body: formatDocumento(doc) }, clientMenu()],
    };
  }

  // ─── Asesor / leads ───────────────────────────────────────

  private handleAsesorMotivo(input: UserInput, key: string): FlowResult {
    // TODO: persist this as an advisor lead via the API (no endpoint yet) so the
    // panel admin shows a queue of pending contact requests.
    this.setState(key, 'CLIENT_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body: 'Listo, tomé nota ✍️. Un asesor te va a contactar dentro del horario de atención (Lun a Vie de 8 a 16 hs).',
        },
        clientMenu(),
      ],
    };
  }

  private handleLeadContact(input: UserInput, key: string): FlowResult {
    // TODO: persist this sales lead via the API once an endpoint exists.
    this.setState(key, 'LEAD_MENU');
    return {
      messages: [
        {
          kind: 'text',
          body: '¡Gracias! Un representante de ventas te va a contactar a la brevedad.',
        },
        leadMenu(),
      ],
    };
  }

  // ─── LLM hand-off (cotización / FAQ) ──────────────────────

  private startCotizacion(key: string): FlowResult {
    this.setState(key, 'LLM_COTIZACION');
    return {
      messages: [
        {
          kind: 'text',
          body:
            '💰 Te ayudo a cotizar. Decime *marca, modelo, año* y *localidad o código postal* del vehículo.\n' +
            'Escribí *menú* para volver al inicio.',
        },
      ],
    };
  }

  private handleLlm(
    input: UserInput,
    key: string,
    handoff: 'cotizacion' | 'faq',
  ): FlowResult {
    // Keep the user in the LLM sub-flow; webhook.service runs the model for this
    // turn. "menú" already exited earlier in handle().
    void key;
    void input;
    return { messages: [], handoff };
  }

  // ─── Shared helpers ───────────────────────────────────────

  private toMainMenu(key: string, ctx: FlowContext): FlowResult {
    if (ctx.client) {
      this.setState(key, 'CLIENT_MENU');
      return { messages: [clientMenu()] };
    }
    this.setState(key, 'ROOT');
    return { messages: [welcomeMenu()] };
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

  private load(
    key: string,
  ): { state: FlowState; touchedAt: number } | undefined {
    const entry = this.states.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.touchedAt > STATE_TTL_MS) {
      this.states.delete(key);
      return undefined;
    }
    return entry;
  }

  private setState(
    key: string,
    step: FlowStep,
    data: Record<string, unknown> = {},
  ): void {
    this.states.set(key, { state: { step, data }, touchedAt: Date.now() });
  }
}
