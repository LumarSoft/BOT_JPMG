import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import axios from 'axios';
import { ApiService } from '../api/api.service';
import type { BotContext, BotConversation } from '../api/api.types';
import { MetaService } from './meta.service';
import { FlowService } from './flow/flow.service';
import type { OutgoingMessage } from './flow/flow.types';
import { buildCotizacionPrompt, buildFaqPrompt } from './constants/prompts';
import { COTIZADOR_TOOLS } from './constants/tools';

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MODEL = 'gpt-4o-mini';
const MAX_TOOL_ROUNDS = 6;

/** How long a seen message id is remembered for deduplication. Meta re-delivers
 * webhooks on any timeout/hiccup, always within a few minutes. */
const DEDUP_TTL_MS = 10 * 60 * 1000;

/** Secret dev command: wipes the chat history so the next message starts fresh. */
const RESET_COMMAND = '/reset';

const FALLBACK_REPLY =
  'Disculpá, en este momento tenemos un inconveniente técnico. ' +
  'Probá de nuevo en unos minutos o comunicate con nuestra oficina de lunes a viernes de 8 a 16 hs.';

/** Maps inbound WhatsApp media MIME types to a file extension for the upload. */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

function buildMediaFilename(mimeType: string): string {
  const ext = MIME_EXT[mimeType] ?? 'jpg';
  return `whatsapp-${Date.now()}.${ext}`;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly openai: OpenAI;

  /**
   * Per-conversation serial queue. WhatsApp users routinely fire several short
   * messages in a row ("hola" / "quiero cotizar" / "un Fiat"). Processing them
   * concurrently would load stale history, race on saves and produce
   * interleaved, incoherent replies. We chain each incoming message onto the
   * previous one for the same sender so they run strictly in order.
   */
  private readonly queues = new Map<string, Promise<void>>();

  /**
   * WhatsApp message ids (wamid) seen recently, mapped to their arrival time.
   * Meta re-delivers the same webhook on any network hiccup; without this a
   * retry would trigger a second OpenAI call and a duplicate reply. Entries
   * expire after DEDUP_TTL_MS so the map stays bounded.
   */
  private readonly seenMessages = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly api: ApiService,
    private readonly meta: MetaService,
    private readonly flow: FlowService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.get('OPENAI_API_KEY'),
    });
  }

  /**
   * Entry point for a text message (fire-and-forget from the controller).
   * Discards Meta re-deliveries and serializes it behind any in-flight message
   * from the same sender.
   */
  handleMessage(
    from: string,
    text: string,
    phoneNumberId: string,
    messageId: string,
    selectionId?: string,
  ): Promise<void> {
    return this.enqueue(from, phoneNumberId, messageId, () =>
      this.processMessage(from, text, phoneNumberId, selectionId),
    );
  }

  /**
   * Entry point for an inbound image (e.g. a siniestro photo). Same dedup and
   * per-sender serialization as text, but handled outside the LLM loop: the
   * image is downloaded from Meta and attached to the open claim via the API.
   */
  handleMedia(
    from: string,
    mediaId: string,
    phoneNumberId: string,
    messageId: string,
  ): Promise<void> {
    return this.enqueue(from, phoneNumberId, messageId, () =>
      this.processMedia(from, mediaId, phoneNumberId),
    );
  }

  /**
   * Discards Meta re-deliveries, then chains `task` behind any in-flight one for
   * the same sender. Returns a promise that resolves when *this* task finishes.
   */
  private enqueue(
    from: string,
    phoneNumberId: string,
    messageId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    if (!this.markSeen(messageId)) {
      this.logger.warn(`Mensaje duplicado ${messageId} ignorado`);
      return Promise.resolve();
    }

    const key = `${phoneNumberId}:${from}`;
    const prev = this.queues.get(key) ?? Promise.resolve();
    // A failure in the previous message must not block the rest of the queue.
    const next = prev.catch(() => undefined).then(task);
    this.queues.set(key, next);
    // Drop the entry once the tail settles to keep the map from growing
    // unbounded; skip if a newer message already became the tail.
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    return next;
  }

  /** Records a message id and reports whether it is the first time we see it. */
  private markSeen(messageId: string): boolean {
    if (!messageId) return true; // No id to dedup on — process it.

    const now = Date.now();
    // Prune expired ids. The map keeps insertion order (≈ time order), so we
    // can stop at the first id still within the TTL.
    for (const [id, seenAt] of this.seenMessages) {
      if (now - seenAt <= DEDUP_TTL_MS) break;
      this.seenMessages.delete(id);
    }

    if (this.seenMessages.has(messageId)) return false;
    this.seenMessages.set(messageId, now);
    return true;
  }

  private async processMessage(
    from: string,
    text: string,
    phoneNumberId: string,
    selectionId?: string,
  ) {
    this.logger.log(
      `[1/5] Mensaje entrante de ${from}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`,
    );

    let context: BotContext;
    try {
      context = await this.api.getContext(phoneNumberId);
      this.logger.log(
        `[2/5] Contexto resuelto → productor: ${context.producerName ?? phoneNumberId}`,
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        this.logger.warn(
          `Número ${phoneNumberId} no registrado — mensaje ignorado`,
        );
        return;
      }
      this.logger.error(
        `API no disponible (context): ${(error as Error).message}`,
      );
      await this.meta.sendText(
        this.meta.normalizePhone(from),
        FALLBACK_REPLY,
        phoneNumberId,
      );
      return;
    }

    let conversation: BotConversation;
    try {
      conversation = await this.api.getConversation(phoneNumberId, from);
      this.logger.log(
        `[3/5] Conversación #${conversation.conversationId} — ` +
          `historial: ${conversation.messages.length} msgs — ` +
          `cliente: ${conversation.client ? `${conversation.client.firstName} ${conversation.client.lastName} (DNI ${conversation.client.dni})` : 'no identificado'} — ` +
          `sesión nueva: ${conversation.newSession ?? false}`,
      );

      // A human agent has taken over this conversation — store the message so
      // the agent can see it in the inbox, but do not run the bot for this turn.
      if (conversation.botPaused) {
        await this.api
          .saveMessage(conversation.conversationId, 'user', text)
          .catch(() => undefined);
        return;
      }

      // Secret dev command: reset the session and stop here.
      if (text.trim().toLowerCase() === RESET_COMMAND) {
        await this.api.resetSession(conversation.conversationId);
        this.flow.reset(`${phoneNumberId}:${from}`);
        await this.meta.sendText(
          this.meta.normalizePhone(from),
          '🔄 Conversación reiniciada. Escribime de nuevo para empezar.',
          phoneNumberId,
        );
        return;
      }

      await this.api.saveMessage(conversation.conversationId, 'user', text);
    } catch (error) {
      this.logger.error(
        `API no disponible (conversation): ${(error as Error).message}`,
      );
      await this.meta.sendText(
        this.meta.normalizePhone(from),
        FALLBACK_REPLY,
        phoneNumberId,
      );
      return;
    }

    const to = this.meta.normalizePhone(from);

    // Deterministic state machine drives the conversation. The LLM is only
    // reached when the flow explicitly hands off (cotización / free-text FAQ).
    const result = await this.flow.handle(
      `${phoneNumberId}:${from}`,
      { text: text.trim(), selectionId },
      {
        conversationId: conversation.conversationId,
        client: conversation.client,
        newSession: conversation.newSession ?? false,
      },
    );

    for (const message of result.messages) {
      await this.dispatch(to, message, phoneNumberId);
      await this.api
        .saveMessage(
          conversation.conversationId,
          'assistant',
          this.toTranscript(message),
        )
        .catch(() => undefined);
    }

    if (result.handoff) {
      this.logger.log(`[5/5] Handoff al LLM (${result.handoff})`);
      const reply = await this.generateReply(
        context,
        conversation,
        text,
        result.handoff,
      );
      await this.api
        .saveMessage(conversation.conversationId, 'assistant', reply)
        .catch((error: Error) =>
          this.logger.error(
            `No se pudo guardar la respuesta: ${error.message}`,
          ),
        );
      await this.meta.sendText(to, reply, phoneNumberId);
    }

    this.logger.log(`Mensaje(s) enviado(s) a ${to} ✓`);
  }

  /** Sends a flow message through the matching Meta endpoint. */
  private async dispatch(
    to: string,
    message: OutgoingMessage,
    phoneNumberId: string,
  ): Promise<void> {
    switch (message.kind) {
      case 'text':
        await this.meta.sendText(to, message.body, phoneNumberId);
        break;
      case 'buttons':
        await this.meta.sendButtons(
          to,
          message.body,
          message.buttons,
          phoneNumberId,
        );
        break;
      case 'list':
        await this.meta.sendList(
          to,
          message.body,
          message.button,
          message.rows,
          phoneNumberId,
        );
        break;
    }
  }

  /** Flattens an interactive message to text so the chat transcript stays readable. */
  private toTranscript(message: OutgoingMessage): string {
    switch (message.kind) {
      case 'text':
        return message.body;
      case 'buttons':
        return `${message.body}\n${message.buttons.map((b) => `[${b.title}]`).join(' ')}`;
      case 'list':
        return `${message.body}\n${message.rows.map((r) => `• ${r.title}`).join('\n')}`;
    }
  }

  /**
   * Handles an inbound image (e.g. a siniestro photo): resolves the
   * conversation, downloads the bytes from Meta and attaches them to the
   * client's open claim via the API. Runs outside the LLM loop — there is no
   * value in sending the image to the model, we only need to store it.
   */
  private async processMedia(
    from: string,
    mediaId: string,
    phoneNumberId: string,
  ) {
    this.logger.log(`Procesando imagen de ${from}...`);
    const to = this.meta.normalizePhone(from);

    let conversationId: number;
    try {
      await this.api.getContext(phoneNumberId);
      const conversation = await this.api.getConversation(phoneNumberId, from);
      conversationId = conversation.conversationId;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        this.logger.warn(
          `Número ${phoneNumberId} no registrado — imagen ignorada`,
        );
        return;
      }
      this.logger.error(
        `API no disponible (media): ${(error as Error).message}`,
      );
      await this.meta.sendText(to, FALLBACK_REPLY, phoneNumberId);
      return;
    }

    const media = await this.meta.downloadMedia(mediaId);
    if (!media) {
      await this.meta.sendText(
        to,
        'No pude descargar la imagen. ¿Podés reenviarla?',
        phoneNumberId,
      );
      return;
    }

    try {
      const { adjuntosCount } = await this.api.attachAdjunto(conversationId, {
        buffer: media.buffer,
        filename: buildMediaFilename(media.mimeType),
        mimeType: media.mimeType,
      });
      const reply = `📎 Recibí tu foto y la adjunté a la denuncia (${adjuntosCount} en total). Si tenés más, mandámelas.`;
      // Best-effort transcript note so later turns know a photo was sent.
      await this.api
        .saveMessage(conversationId, 'user', '[El cliente envió una foto]')
        .catch(() => undefined);
      await this.api
        .saveMessage(conversationId, 'assistant', reply)
        .catch(() => undefined);
      await this.meta.sendText(to, reply, phoneNumberId);
    } catch (error) {
      await this.meta.sendText(to, this.mediaErrorReply(error), phoneNumberId);
    }
  }

  /** Maps an attach-photo failure to a user-facing message. */
  private mediaErrorReply(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 404 || status === 403) {
        return 'Para sumar fotos necesito que primero registremos la denuncia del siniestro. Escribime "siniestro" y arrancamos.';
      }
    }
    this.logger.error(`Error adjuntando imagen: ${(error as Error).message}`);
    return 'No pude adjuntar la imagen en este momento. Probá de nuevo en un rato o comunicate con la oficina.';
  }

  /**
   * Runs the OpenAI tool-calling loop for an LLM sub-flow until the model
   * produces a final text reply. The prompt and tools are scoped to the
   * handoff: cotización gets the quote tools only, FAQ gets no tools — so the
   * model can never reach the client-scoped transactional flows, which the
   * deterministic state machine owns.
   */
  private async generateReply(
    context: BotContext,
    conversation: BotConversation,
    text: string,
    handoff: 'cotizacion' | 'faq',
  ): Promise<string> {
    const today = new Date().toLocaleDateString('es-AR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const system =
      handoff === 'cotizacion'
        ? buildCotizacionPrompt({ producerPrompt: context.systemPrompt, today })
        : buildFaqPrompt({ producerPrompt: context.systemPrompt, today });
    const tools = handoff === 'cotizacion' ? COTIZADOR_TOOLS : undefined;

    const messages: ChatMessageParam[] = [
      { role: 'system', content: system },
      ...conversation.messages.map(
        (m): ChatMessageParam => ({ role: m.role, content: m.content }),
      ),
      { role: 'user', content: text },
    ];

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        this.logger.log(
          `[4/5] OpenAI ronda ${round + 1}/${MAX_TOOL_ROUNDS} — enviando ${messages.length} msgs`,
        );
        const completion = await this.openai.chat.completions.create({
          model: MODEL,
          max_tokens: 800,
          messages,
          ...(tools ? { tools } : {}),
        });

        const message = completion.choices[0]?.message;
        if (!message) break;

        const toolCalls = (message.tool_calls ?? []).filter(
          (
            tc,
          ): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
            tc.type === 'function',
        );

        if (toolCalls.length === 0) {
          this.logger.log(
            `[4/5] Modelo respondió con texto final en ronda ${round + 1}`,
          );
          return message.content ?? FALLBACK_REPLY;
        }

        this.logger.log(
          `[4/5] Ronda ${round + 1}: ${toolCalls.length} tool call(s): ${toolCalls.map((tc) => tc.function.name).join(', ')}`,
        );
        messages.push(message);
        for (const toolCall of toolCalls) {
          const result = await this.executeTool(
            toolCall.function.name,
            toolCall.function.arguments,
            conversation.conversationId,
          );
          this.logger.log(
            `   🔧 ${toolCall.function.name}(${toolCall.function.arguments.slice(0, 100)}) → ${result.slice(0, 200)}`,
          );
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result,
          });
        }
      }
      this.logger.warn(
        `[4/5] Se alcanzó el límite de ${MAX_TOOL_ROUNDS} rondas — usando fallback`,
      );
    } catch (error) {
      this.logger.error(
        `Error generando respuesta: ${(error as Error).message}`,
      );
    }

    return FALLBACK_REPLY;
  }

  /** Maps a tool call to its ApiService method. Always returns a JSON string for the model. */
  private async executeTool(
    name: string,
    rawArgs: string,
    conversationId: number,
  ): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return JSON.stringify({ error: 'Argumentos inválidos' });
    }

    const vehicleType = args.vehicleType === 'moto' ? 'moto' : 'auto';

    try {
      switch (name) {
        case 'identify_client':
          return JSON.stringify(
            await this.api.identifyClient(conversationId, {
              dni: args.dni as string | undefined,
              plate: args.plate as string | undefined,
            }),
          );
        case 'get_polizas':
          return JSON.stringify(await this.api.getPolizas(conversationId));
        case 'get_estado_cuenta':
          return JSON.stringify(await this.api.getEstadoCuenta(conversationId));
        case 'get_documentos':
          return JSON.stringify(
            await this.api.getDocumentos(conversationId, Number(args.polizaId)),
          );
        case 'get_siniestros':
          return JSON.stringify(await this.api.getSiniestros(conversationId));
        case 'create_siniestro':
          return JSON.stringify(
            await this.api.createSiniestro(conversationId, {
              polizaId: Number(args.polizaId),
              tipo: String(args.tipo),
              fecha: String(args.fecha),
              descripcion: String(args.descripcion),
            }),
          );
        case 'search_vehicle_brands': {
          const brands = await this.api.searchBrands(
            vehicleType,
            typeof args.query === 'string' ? args.query : '',
          );
          return JSON.stringify(brands.map(({ id, name }) => ({ id, name })));
        }
        case 'get_vehicle_groups': {
          const groups = await this.api.getGroups(
            vehicleType,
            Number(args.brandId),
          );
          return JSON.stringify(groups.map(({ id, name }) => ({ id, name })));
        }
        case 'get_vehicle_models': {
          const models = await this.api.getModels(
            vehicleType,
            Number(args.brandId),
            Number(args.groupId),
            args.query as string | undefined,
          );
          return JSON.stringify(
            models.map(({ codia, description }) => ({ codia, description })),
          );
        }
        case 'quote_vehicle':
          return JSON.stringify(
            await this.api.quoteVehicle(vehicleType, {
              brand: String(args.brandId),
              model: String(args.codia),
              manufactureYear: Number(args.manufactureYear),
              postalCode: Number(args.postalCode),
            }),
          );
        default:
          return JSON.stringify({ error: `Tool desconocida: ${name}` });
      }
    } catch (error) {
      return this.toolError(name, error);
    }
  }

  private toolError(name: string, error: unknown): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data as
        | { message?: string | string[] }
        | undefined;
      const message = Array.isArray(data?.message)
        ? data.message.join('; ')
        : (data?.message ?? error.message);
      this.logger.warn(`Tool ${name} falló (${status ?? '?'}): ${message}`);
      return JSON.stringify({ error: message, status });
    }
    this.logger.error(`Tool ${name} falló: ${(error as Error).message}`);
    return JSON.stringify({ error: 'Error interno consultando los datos' });
  }
}
