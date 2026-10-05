import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import axios from 'axios';
import { ApiService } from '../api/api.service';
import type {
  BotContext,
  BotConversation,
  MessageMedia,
} from '../api/api.types';
import { MetaService } from './meta.service';
import {
  FlowService,
  LEAD_DOC_TIPO,
  PHOTO_RECEIVED,
  SINIESTRO_PHOTO_TIPO,
  TAKE_OUT_DOCS_INTRO,
  takeOutDocsState,
} from './flow/flow.service';
import type { FlowState, OutgoingMessage } from './flow/flow.types';
import { gncButtons, toWhatsAppMarkdown } from './flow/flow.messages';
import { renderQuote } from './constants/coverages';
import { buildCotizacionPrompt, buildFaqPrompt } from './constants/prompts';
import { COTIZADOR_TOOLS, REQUEST_COVERAGE_TOOL } from './constants/tools';
import { compactMessages } from './compact-messages';
import { findVehicle } from './vehicle-finder';
import {
  AudioTranscriber,
  audioFilename,
  baseMimeType,
} from './audio-transcriber.service';
import { fold } from './text';
import {
  DEFAULT_ATTENTION_HOURS,
  DEFAULT_OPENAI_MODEL,
  renderCatalogForPrompt,
} from './constants/business';

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface QuoteVehicleCandidate {
  codia: number;
  description: string;
}

interface QuoteVehicleMemory {
  vehicleType: 'auto' | 'moto';
  brandId?: number;
  brandName?: string;
  candidates: QuoteVehicleCandidate[];
  selected?: QuoteVehicleCandidate;
}

const QUOTE_VEHICLE_MEMORY = 'quoteVehicle';

/** Tool rounds per reply. A car quote legitimately chains several lookups;
 * when the cap is hit the model still gets one last call, without tools, to
 * answer with what it has (instead of the generic error reply). */
const MAX_TOOL_ROUNDS = 8;

/** Output token caps per sub-flow. Cotización needs room to list coverages;
 * FAQ replies are short by design. Lower caps = lower cost and tighter answers. */
const MAX_TOKENS: Record<'cotizacion' | 'faq', number> = {
  cotizacion: 800,
  faq: 350,
};

const DEFAULT_PRICE_IN_PER_1M = 0.2;
const DEFAULT_PRICE_OUT_PER_1M = 1.2;

/** Soft backstop against runaway OpenAI cost: max LLM hand-offs per sender per
 * rolling hour. A normal user never reaches this; it caps a single number from
 * spamming free text and blowing the monthly budget (USD 20 / number). */
const LLM_CALLS_PER_HOUR = 30;
const LLM_WINDOW_MS = 60 * 60 * 1000;

const RATE_LIMIT_REPLY =
  'Estoy recibiendo muchas consultas seguidas tuyas y necesito un respiro 🙏. ' +
  'Escribí *menú* para usar las opciones, o *asesor* y te contacta una persona del equipo.';

/** How long a seen message id is remembered for deduplication. Meta re-delivers
 * webhooks on any timeout/hiccup, always within a few minutes. */
const DEDUP_TTL_MS = 10 * 60 * 1000;

/** Secret dev command: wipes the chat history so the next message starts fresh. */
const RESET_COMMAND = '/reset';

const FALLBACK_REPLY =
  'Disculpá, en este momento tenemos un inconveniente técnico. ' +
  `Probá de nuevo en unos minutos o comunicate con nuestra oficina de ${DEFAULT_ATTENTION_HOURS}.`;

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
  private readonly autoReplyEnabled: boolean;
  private readonly model: string;
  private readonly priceInPer1M: number;
  private readonly priceOutPer1M: number;

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

  /**
   * LLM hand-off timestamps per sender (`phoneNumberId:waId`), for the rolling
   * per-hour rate cap. Pruned on each check so the map stays bounded.
   */
  private readonly llmCalls = new Map<string, number[]>();

  /** Running OpenAI cost estimate for this process (USD), for observability. */
  private llmCostUsd = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly api: ApiService,
    private readonly meta: MetaService,
    private readonly flow: FlowService,
    private readonly transcriber: AudioTranscriber,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.get('OPENAI_API_KEY'),
    });
    this.model =
      this.config.get<string>('OPENAI_MODEL') || DEFAULT_OPENAI_MODEL;
    this.priceInPer1M = this.readPositiveNumber(
      'OPENAI_PRICE_IN_PER_1M',
      DEFAULT_PRICE_IN_PER_1M,
    );
    this.priceOutPer1M = this.readPositiveNumber(
      'OPENAI_PRICE_OUT_PER_1M',
      DEFAULT_PRICE_OUT_PER_1M,
    );
    // Operational kill switch for onboarding/cutover: keep ingesting and
    // storing messages while staff answers from WhatsApp Business, but send no
    // automated replies until smoke tests are complete.
    this.autoReplyEnabled =
      this.config.get<string>('BOT_AUTOREPLY_ENABLED') !== 'false';
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
    contactName?: string,
  ): Promise<void> {
    return this.enqueue(from, phoneNumberId, messageId, () =>
      this.processMessage(
        from,
        text,
        phoneNumberId,
        selectionId,
        messageId,
        contactName,
      ),
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
    contactName?: string,
  ): Promise<void> {
    return this.enqueue(from, phoneNumberId, messageId, () =>
      this.processMedia(from, mediaId, phoneNumberId, contactName),
    );
  }

  /**
   * Entry point for a voice note. Same dedup and per-sender serialization as
   * text: the audio is transcribed and then answered like a typed message.
   */
  handleAudio(
    from: string,
    mediaId: string,
    phoneNumberId: string,
    messageId: string,
    contactName?: string,
  ): Promise<void> {
    return this.enqueue(from, phoneNumberId, messageId, () =>
      this.processAudio(from, mediaId, phoneNumberId, messageId, contactName),
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
    messageId?: string,
    contactName?: string,
    // What the inbox stores instead of `text` (a voice note: its transcription
    // labelled as audio, plus the playable file). The flow still gets `text`.
    inbound?: { content: string; media?: MessageMedia },
  ) {
    this.logger.log(
      `[1/5] Mensaje entrante de ${from}: ${JSON.stringify(text)}`,
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
      if (
        conversation.botPaused ||
        !this.autoReplyEnabled ||
        context.botEnabled === false
      ) {
        if (!this.autoReplyEnabled) {
          this.logger.warn(
            `BOT_AUTOREPLY_ENABLED=false — mensaje de ${from} guardado sin responder`,
          );
        } else if (context.botEnabled === false) {
          this.logger.warn(
            `Bot desactivado para ${context.producerName} — mensaje de ${from} guardado sin responder`,
          );
        }
        await this.api
          .saveMessage(
            conversation.conversationId,
            'user',
            inbound?.content ?? text,
            inbound?.media,
            contactName,
          )
          .catch(() => undefined);
        return;
      }

      // Secret dev command: reset the session and stop here.
      if (text.trim().toLowerCase() === RESET_COMMAND) {
        // Full reset: also unlinks the identified client, so the next message
        // starts from the "¿sos cliente?" welcome instead of greeting whoever
        // was identified before.
        await this.api.resetSession(conversation.conversationId, true);
        this.flow.reset(`${phoneNumberId}:${from}`);
        await this.meta.sendText(
          this.meta.normalizePhone(from),
          '🔄 Conversación reiniciada. Escribime de nuevo para empezar.',
          phoneNumberId,
        );
        return;
      }

      // The bot will answer this turn: show "escribiendo…" right away so the
      // wait for the reply (a model call can take seconds) doesn't feel dead.
      if (messageId) this.meta.showTyping(messageId, phoneNumberId);

      await this.api.saveMessage(
        conversation.conversationId,
        'user',
        inbound?.content ?? text,
        inbound?.media,
        contactName,
      );
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
        botName: context.botName,
        attentionHours: context.attentionHours,
        flowState: this.parseFlowState(conversation.flowState),
        phoneNumberId,
        llmEnabled: context.llmEnabled,
      },
    );

    // Re-read the organization switch immediately before any automated output.
    // This closes the race where a SuperAdmin activates global human attention
    // while this message is already being processed.
    if (!(await this.automaticRepliesStillEnabled(phoneNumberId))) return;

    // Persist the new flow snapshot so a restart resumes the exact step. The LLM
    // handoff below never changes flow state, so it's safe to save it now.
    await this.api
      .saveFlowState(
        conversation.conversationId,
        result.state ? JSON.stringify(result.state) : null,
      )
      .catch((error: Error) =>
        this.logger.error(`No se pudo guardar el flowState: ${error.message}`),
      );

    for (const message of compactMessages(result.messages)) {
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
      // Hard cost cap: if this number is over its monthly budget (resolved by the
      // API from UsageMonthly), skip the paid LLM entirely. Deterministic flows
      // already answered everything they can; nudge to the menu / a human.
      if (context.llmEnabled === false) {
        this.logger.warn(
          `[5/5] Número ${phoneNumberId} sobre el presupuesto mensual — respondo sin modelo`,
        );
        await this.api
          .saveMessage(
            conversation.conversationId,
            'assistant',
            RATE_LIMIT_REPLY,
          )
          .catch(() => undefined);
        await this.meta.sendText(to, RATE_LIMIT_REPLY, phoneNumberId);
        return;
      }

      // Cost backstop: if this sender has exceeded the hourly LLM budget, skip
      // the model entirely and nudge them to the menu / a human.
      if (!this.allowLlmCall(`${phoneNumberId}:${from}`)) {
        this.logger.warn(
          `[5/5] Rate limit LLM alcanzado para ${phoneNumberId}:${from} — respondo sin modelo`,
        );
        await this.api
          .saveMessage(
            conversation.conversationId,
            'assistant',
            RATE_LIMIT_REPLY,
          )
          .catch(() => undefined);
        await this.meta.sendText(to, RATE_LIMIT_REPLY, phoneNumberId);
        return;
      }

      this.logger.log(`[5/5] Handoff al LLM (${result.handoff})`);
      const stateVehicleType = result.state?.data.vehiculo;
      const vehicleType =
        result.state?.step === 'LLM_COTIZACION' &&
        (stateVehicleType === 'auto' || stateVehicleType === 'moto')
          ? stateVehicleType
          : undefined;
      const {
        text: raw,
        coverageLeadId,
        quoteVehicleMemory,
      } = await this.generateReply(
        context,
        conversation,
        text,
        result.handoff,
        phoneNumberId,
        from,
        vehicleType,
        this.readQuoteVehicleMemory(result.state),
      );
      // LLM/tool turns can take several seconds. Check again so an in-flight
      // response cannot escape after the global stop button was pressed.
      if (!(await this.automaticRepliesStillEnabled(phoneNumberId))) return;
      let effectiveState = result.state;
      if (effectiveState?.step === 'LLM_COTIZACION' && quoteVehicleMemory) {
        effectiveState = {
          ...effectiveState,
          data: {
            ...effectiveState.data,
            [QUOTE_VEHICLE_MEMORY]: quoteVehicleMemory,
          },
        };
        // Tool results are not transcript messages. Persist the verified
        // vehicle candidates/selection explicitly so the following GNC turn
        // still has the exact CODIA, including after a bot restart.
        await this.api
          .saveFlowState(
            conversation.conversationId,
            JSON.stringify(effectiveState),
          )
          .catch((error: Error) =>
            this.logger.error(
              `No se pudo guardar el vehículo de la cotización: ${error.message}`,
            ),
          );
      }
      // The model writes standard markdown; WhatsApp speaks its own dialect.
      const reply = toWhatsAppMarkdown(raw);
      // The quote sub-flow's GNC question goes out as buttons instead of text.
      let outgoing: OutgoingMessage[] = [
        (result.handoff === 'cotizacion' ? gncButtons(reply) : null) ??
          ({ kind: 'text', body: reply } as const),
      ];

      // A coverage was chosen: the request is recorded, now collect the
      // documents to take it out (DNI front/back, tarjeta azul) step by step.
      if (coverageLeadId) {
        await this.api
          .saveFlowState(
            conversation.conversationId,
            JSON.stringify(takeOutDocsState(effectiveState, coverageLeadId)),
          )
          .catch((error: Error) =>
            this.logger.error(
              `No se pudo guardar el flowState: ${error.message}`,
            ),
          );
        outgoing = compactMessages([
          ...outgoing,
          { kind: 'text', body: TAKE_OUT_DOCS_INTRO },
        ]);
      }

      for (const message of outgoing) {
        await this.api
          .saveMessage(
            conversation.conversationId,
            'assistant',
            this.toTranscript(message),
          )
          .catch((error: Error) =>
            this.logger.error(
              `No se pudo guardar la respuesta: ${error.message}`,
            ),
          );
        await this.dispatch(to, message, phoneNumberId);
      }
    }

    if (result.messages.length > 0 || result.handoff) {
      this.logger.log(`Mensaje(s) enviado(s) a ${to} ✓`);
    } else {
      this.logger.log(`Sin mensaje saliente para ${to} (evento ignorado)`);
    }
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

  /**
   * Parses the persisted flow snapshot. A corrupt/legacy value must never crash
   * the turn — we log it and start the user fresh (null) instead.
   */
  private parseFlowState(raw: string | null): FlowState | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FlowState;
    } catch {
      this.logger.warn('flowState ilegible — reinicio el flujo desde cero');
      return null;
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
   * A voice note: stored for the inbox and transcribed by OpenAI, then run
   * through processMessage as if the customer had typed the transcription. When
   * it can't be transcribed (download failure, no speech, number over its LLM
   * budget) the inbox still gets the audio and the customer is asked to write.
   */
  private async processAudio(
    from: string,
    mediaId: string,
    phoneNumberId: string,
    messageId: string,
    contactName?: string,
  ) {
    this.logger.log(`Procesando audio de ${from}...`);
    const to = this.meta.normalizePhone(from);

    let context: BotContext;
    let conversation: BotConversation;
    try {
      context = await this.api.getContext(phoneNumberId);
      conversation = await this.api.getConversation(phoneNumberId, from);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        this.logger.warn(
          `Número ${phoneNumberId} no registrado — audio ignorado`,
        );
        return;
      }
      this.logger.error(
        `API no disponible (audio): ${(error as Error).message}`,
      );
      await this.meta.sendText(to, FALLBACK_REPLY, phoneNumberId);
      return;
    }

    const botAnswers =
      this.autoReplyEnabled &&
      context.botEnabled !== false &&
      !conversation.botPaused;
    // Download + transcription take a few seconds: show "escribiendo…".
    if (botAnswers) this.meta.showTyping(messageId, phoneNumberId);

    const audio = await this.meta.downloadMedia(mediaId, phoneNumberId);
    let media: MessageMedia | undefined;
    let transcript: string | null = null;
    if (audio) {
      const mimeType = baseMimeType(audio.mimeType);
      media = await this.api
        .storeAudio(conversation.conversationId, {
          buffer: audio.buffer,
          filename: audioFilename(mimeType),
          mimeType,
        })
        .catch((error: Error) => {
          this.logger.error(`No se pudo guardar el audio: ${error.message}`);
          return undefined;
        });
      // Transcribed even when a human has the chat, so the advisor can read
      // it — but never over the number's monthly LLM budget.
      if (context.llmEnabled !== false) {
        transcript = await this.transcriber
          .transcribe(audio, phoneNumberId)
          .catch((error: Error) => {
            this.logger.error(
              `No se pudo transcribir el audio: ${error.message}`,
            );
            return null;
          });
      }
    }

    if (transcript) {
      this.logger.log(
        `🎤 Transcripción de ${from}: ${JSON.stringify(transcript)}`,
      );
      await this.processMessage(
        from,
        transcript,
        phoneNumberId,
        undefined,
        messageId,
        contactName,
        { content: `🎤 Audio: ${transcript}`, media },
      );
      return;
    }

    await this.api
      .saveMessage(
        conversation.conversationId,
        'user',
        '🎤 Audio (sin transcripción)',
        media,
        contactName,
      )
      .catch(() => undefined);
    if (
      !botAnswers ||
      !(await this.automaticRepliesStillEnabled(phoneNumberId))
    )
      return;

    const reply = !audio
      ? 'No pude descargar el audio 😕. ¿Me lo reenviás o me lo escribís?'
      : context.llmEnabled === false
        ? 'Por ahora no puedo escuchar audios 🙏. ¿Me lo escribís?'
        : 'No pude entender el audio 😕. ¿Me lo escribís?';
    await this.meta.sendText(to, reply, phoneNumberId);
    await this.api
      .saveMessage(conversation.conversationId, 'assistant', reply)
      .catch(() => undefined);
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
    contactName?: string,
  ) {
    this.logger.log(`Procesando imagen de ${from}...`);
    const to = this.meta.normalizePhone(from);

    let context: BotContext;
    let conversation: BotConversation;
    try {
      context = await this.api.getContext(phoneNumberId);
      conversation = await this.api.getConversation(phoneNumberId, from);
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

    const automationDisabled =
      context.botEnabled === false || !this.autoReplyEnabled;

    const media = await this.meta.downloadMedia(mediaId, phoneNumberId);
    if (!media) {
      if (
        automationDisabled ||
        !(await this.automaticRepliesStillEnabled(phoneNumberId))
      ) {
        return;
      }
      await this.meta.sendText(
        to,
        'No pude descargar la imagen. ¿Podés reenviarla?',
        phoneNumberId,
      );
      return;
    }

    // If we're in a guided claim-photo step, label the attachment by type so the
    // admin sees "tarjeta verde / carnet / tercero" instead of an unnamed photo.
    const flowState = this.parseFlowState(conversation.flowState);
    const tipo = flowState?.step
      ? SINIESTRO_PHOTO_TIPO[flowState.step]
      : undefined;
    // Or a take-out document for a chosen coverage (DNI, tarjeta azul): it goes
    // to that request instead of a claim.
    const leadTipo = flowState?.step
      ? LEAD_DOC_TIPO[flowState.step]
      : undefined;
    const leadId = Number(flowState?.data.leadId);
    const file = {
      buffer: media.buffer,
      filename: buildMediaFilename(media.mimeType),
      mimeType: media.mimeType,
    };

    let attachmentResult: {
      attached?: boolean;
      attachments?: MessageMedia[];
    };
    try {
      if (leadTipo && Number.isInteger(leadId)) {
        attachmentResult = await this.api.attachLeadAdjunto(
          conversation.conversationId,
          leadId,
          file,
          leadTipo,
        );
      } else {
        attachmentResult = await this.api.attachAdjunto(
          conversation.conversationId,
          file,
          tipo,
        );
      }
    } catch (error) {
      if (
        automationDisabled ||
        !(await this.automaticRepliesStillEnabled(phoneNumberId))
      ) {
        return;
      }
      const reply = leadTipo
        ? this.leadDocErrorReply(error)
        : this.mediaErrorReply(error);
      await this.meta.sendText(to, reply, phoneNumberId);
      return;
    }

    // Persist the real attachment metadata in the transcript. The inbox signs
    // its protected URL when it is read, so the browser can render the image.
    const messageMedia = attachmentResult.attachments?.[0];
    const saveImageMessage = this.api.saveMessage(
      conversation.conversationId,
      'user',
      '[El cliente envió una foto]',
      messageMedia,
      contactName,
    );
    await saveImageMessage.catch((error: Error) =>
      this.logger.error(
        `No se pudo guardar la imagen en el chat: ${error.message}`,
      ),
    );

    // A human agent owns the chat → store the photo but stay silent.
    if (
      conversation.botPaused ||
      automationDisabled ||
      !(await this.automaticRepliesStillEnabled(phoneNumberId))
    ) {
      return;
    }

    // The image remains available in the inbox even when there is no open
    // claim yet, but the guided flow must not advance as if it were attached.
    if (attachmentResult.attached === false) {
      await this.meta.sendText(
        to,
        'Para sumar fotos necesito que primero registremos la denuncia del siniestro. Escribime "siniestro" y arrancamos.',
        phoneNumberId,
      );
      return;
    }

    // In a guided photo step: advance the deterministic flow and send the next
    // prompt (next photo / "¿hubo tercero?" / closing), keeping it on the rails.
    if (tipo || leadTipo) {
      const key = `${phoneNumberId}:${from}`;
      const result = await this.flow.handle(
        key,
        { text: '', selectionId: PHOTO_RECEIVED },
        {
          conversationId: conversation.conversationId,
          client: conversation.client,
          newSession: false,
          botName: context.botName,
          attentionHours: context.attentionHours,
          flowState,
        },
      );
      await this.api
        .saveFlowState(
          conversation.conversationId,
          result.state ? JSON.stringify(result.state) : null,
        )
        .catch((error: Error) =>
          this.logger.error(
            `No se pudo guardar el flowState: ${error.message}`,
          ),
        );
      for (const message of compactMessages(result.messages)) {
        await this.dispatch(to, message, phoneNumberId);
        await this.api
          .saveMessage(
            conversation.conversationId,
            'assistant',
            this.toTranscript(message),
          )
          .catch(() => undefined);
      }
      return;
    }

    // Outside the guided flow: generic acknowledgement (attaches to the open claim).
    const reply =
      '📎 Recibí tu foto y la sumé a tu denuncia. Si tenés más, mandámelas.';
    await this.api
      .saveMessage(conversation.conversationId, 'assistant', reply)
      .catch(() => undefined);
    await this.meta.sendText(to, reply, phoneNumberId);
  }

  /** A take-out document that could not be stored: ask again, don't lose the step. */
  private leadDocErrorReply(error: unknown): string {
    this.logger.error(
      `Error adjuntando documento de contratación: ${(error as Error).message}`,
    );
    return 'No pude guardar la foto 😕. ¿Me la mandás de nuevo? Si no la tenés, escribí *no la tengo*.';
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

  private readQuoteVehicleMemory(
    state: FlowState | null,
  ): QuoteVehicleMemory | undefined {
    const raw = state?.data[QUOTE_VEHICLE_MEMORY];
    if (!raw || typeof raw !== 'object') return undefined;
    const value = raw as Partial<QuoteVehicleMemory>;
    if (value.vehicleType !== 'auto' && value.vehicleType !== 'moto') {
      return undefined;
    }
    if (!Array.isArray(value.candidates)) return undefined;
    const candidates = value.candidates
      .filter(
        (candidate): candidate is QuoteVehicleCandidate =>
          !!candidate &&
          Number.isInteger(candidate.codia) &&
          candidate.codia > 10_000 &&
          typeof candidate.description === 'string' &&
          candidate.description.trim().length > 0,
      )
      .slice(0, 8);
    if (candidates.length === 0) return undefined;

    const selected = candidates.find(
      (candidate) => candidate.codia === value.selected?.codia,
    );
    return {
      vehicleType: value.vehicleType,
      ...(Number.isInteger(value.brandId) && Number(value.brandId) > 0
        ? { brandId: Number(value.brandId) }
        : {}),
      ...(typeof value.brandName === 'string' && value.brandName.trim()
        ? { brandName: value.brandName.trim() }
        : {}),
      candidates,
      ...(selected ? { selected } : {}),
    };
  }

  /** Fail-closed gate used immediately before automated outbound messages. */
  private async automaticRepliesStillEnabled(
    phoneNumberId: string,
  ): Promise<boolean> {
    if (!this.autoReplyEnabled) return false;
    try {
      const context = await this.api.getContext(phoneNumberId);
      return context.botEnabled !== false;
    } catch (error) {
      this.logger.error(
        `No se pudo revalidar el estado global del bot: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /** Resolves a numeric/version answer against the last verified InfoAuto list. */
  private selectRememberedVehicle(
    memory: QuoteVehicleMemory | undefined,
    text: string,
    previousAssistantText?: string,
  ): QuoteVehicleMemory | undefined {
    if (!memory || memory.candidates.length === 0) return memory;
    const normalized = fold(text)
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const numbered = normalized.match(/^(?:opcion )?([1-8])$/);
    if (numbered) {
      const position = Number(numbered[1]);
      const numberedLine = previousAssistantText
        ?.split('\n')
        .map((line) => line.match(/^\s*(\d+)[.)-]\s*(.+)$/))
        .find((match) => Number(match?.[1]) === position)?.[2];
      const normalizedLine = numberedLine
        ? fold(numberedLine)
            .replace(/[^a-z0-9]+/g, ' ')
            .trim()
        : '';
      const lineMatches = normalizedLine
        ? memory.candidates.filter((candidate) => {
            const description = fold(candidate.description)
              .replace(/[^a-z0-9]+/g, ' ')
              .trim();
            return normalizedLine.includes(description);
          })
        : [];
      const selected =
        lineMatches.length === 1
          ? lineMatches[0]
          : memory.candidates[position - 1];
      if (selected) return { ...memory, selected };
    }

    const matches = memory.candidates.filter((candidate) => {
      const description = fold(candidate.description)
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      return description.length > 0 && normalized.includes(description);
    });
    if (matches.length === 1) return { ...memory, selected: matches[0] };
    if (memory.candidates.length === 1) {
      return { ...memory, selected: memory.candidates[0] };
    }
    return memory;
  }

  private renderRememberedVehicle(
    memory: QuoteVehicleMemory | undefined,
  ): string {
    const selected = memory?.selected;
    if (!selected) return '';
    const brand = memory.brandName ? `${memory.brandName} ` : '';
    return (
      '\n\n## VEHÍCULO VERIFICADO POR EL SISTEMA\n' +
      `La persona ya eligió *${brand}${selected.description}*. Su CODIA verificado es \`${selected.codia}\`. ` +
      'Usá exactamente ese CODIA en quote_vehicle; nunca envíes 0 ni inventes otro código. No vuelvas a pedir la versión.'
    );
  }

  /** Extracts and keeps the latest verified candidates returned by find_vehicle. */
  private rememberVehicleSearch(
    previous: QuoteVehicleMemory | undefined,
    rawResult: string,
    rawArgs: string,
    fallbackType?: 'auto' | 'moto',
  ): QuoteVehicleMemory | undefined {
    try {
      const result = JSON.parse(rawResult) as {
        brand?: { id?: unknown; name?: unknown };
        versions?: Array<{ codia?: unknown; description?: unknown }>;
      };
      const args = rawArgs
        ? (JSON.parse(rawArgs) as Record<string, unknown>)
        : {};
      const vehicleType =
        args.vehicleType === 'moto'
          ? 'moto'
          : args.vehicleType === 'auto'
            ? 'auto'
            : (fallbackType ?? previous?.vehicleType);
      if (!vehicleType || !Array.isArray(result.versions)) return previous;

      const candidates = result.versions
        .map((version) => ({
          codia: Number(version.codia),
          description:
            typeof version.description === 'string'
              ? version.description.trim()
              : '',
        }))
        .filter(
          (candidate) =>
            Number.isInteger(candidate.codia) &&
            candidate.codia > 10_000 &&
            candidate.description.length > 0,
        )
        .slice(0, 8);
      if (candidates.length === 0) return previous;

      const priorSelected = candidates.find(
        (candidate) => candidate.codia === previous?.selected?.codia,
      );
      const selected = candidates.length === 1 ? candidates[0] : priorSelected;
      return {
        vehicleType,
        ...(Number.isInteger(Number(result.brand?.id)) &&
        Number(result.brand?.id) > 0
          ? { brandId: Number(result.brand?.id) }
          : {}),
        ...(typeof result.brand?.name === 'string' && result.brand.name.trim()
          ? { brandName: result.brand.name.trim() }
          : {}),
        candidates,
        ...(selected ? { selected } : {}),
      };
    } catch {
      return previous;
    }
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
    phoneNumberId: string,
    from: string,
    vehicleType?: 'auto' | 'moto',
    rememberedVehicle?: QuoteVehicleMemory,
  ): Promise<{
    text: string;
    coverageLeadId?: number;
    quoteVehicleMemory?: QuoteVehicleMemory;
  }> {
    const today = new Date().toLocaleDateString('es-AR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    // FAQ describes coverages, so it gets the price-free catalog. A catalog fetch
    // failure must not block the reply — fall back to an empty block (the model
    // then deflects coverage questions to an advisor, as the prompt instructs).
    const catalog =
      handoff === 'faq'
        ? renderCatalogForPrompt(await this.api.getProducts().catch(() => []))
        : undefined;
    let quoteVehicleMemory = this.selectRememberedVehicle(
      rememberedVehicle,
      text,
      [...conversation.messages]
        .reverse()
        .find((message) => message.role !== 'user')?.content,
    );
    const baseSystem =
      handoff === 'cotizacion'
        ? buildCotizacionPrompt({
            botName: context.botName,
            producerPrompt: context.systemPrompt,
            attentionHours: context.attentionHours,
            today,
            client: conversation.client,
            vehicleType,
          })
        : buildFaqPrompt({
            botName: context.botName,
            producerPrompt: context.systemPrompt,
            attentionHours: context.attentionHours,
            today,
            client: conversation.client,
            catalog,
          });
    const system =
      handoff === 'cotizacion'
        ? baseSystem + this.renderRememberedVehicle(quoteVehicleMemory)
        : baseSystem;
    const tools = handoff === 'cotizacion' ? COTIZADOR_TOOLS : undefined;

    const messages: ChatMessageParam[] = [
      { role: 'system', content: system },
      // Anything that isn't the user is our side of the chat. A human agent's
      // inbox reply is stored as role "agent", which OpenAI rejects (400) —
      // that used to turn every later model reply into the error message.
      ...conversation.messages.map(
        (m): ChatMessageParam => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
        }),
      ),
      { role: 'user', content: text },
    ];

    let promptTokens = 0;
    let completionTokens = 0;
    // Set when the model calls request_coverage (the customer chose a coverage).
    let coverageLeadId: number | undefined;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        this.logger.log(
          `[4/5] OpenAI ronda ${round + 1}/${MAX_TOOL_ROUNDS} — enviando ${messages.length} msgs`,
        );
        const completion = await this.openai.chat.completions.create({
          model: this.model,
          // This flow is tightly specified and tool-driven. Disabling reasoning
          // preserves the output budget and minimizes latency/cost on WhatsApp.
          reasoning_effort: 'none',
          max_completion_tokens: MAX_TOKENS[handoff],
          messages,
          ...(tools ? { tools } : {}),
        });

        await this.reportCompletionUsage(completion, phoneNumberId);
        promptTokens += completion.usage?.prompt_tokens ?? 0;
        completionTokens += completion.usage?.completion_tokens ?? 0;

        const message = completion.choices[0]?.message;
        if (!message) break;

        const toolCalls = (message.tool_calls ?? []).filter(
          (
            tc,
          ): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
            tc.type === 'function',
        );

        if (toolCalls.length === 0) {
          quoteVehicleMemory = this.selectRememberedVehicle(
            quoteVehicleMemory,
            message.content ?? '',
          );
          this.logger.log(
            `[4/5] Modelo respondió con texto final en ronda ${round + 1}`,
          );
          return {
            text: message.content ?? FALLBACK_REPLY,
            coverageLeadId,
            quoteVehicleMemory,
          };
        }

        this.logger.log(
          `[4/5] Ronda ${round + 1}: ${toolCalls.length} tool call(s): ${toolCalls.map((tc) => tc.function.name).join(', ')}`,
        );
        messages.push(message);
        // Independent lookups run in parallel; results keep the call order.
        const results = await Promise.all(
          toolCalls.map(async (toolCall) => {
            if (toolCall.function.name !== REQUEST_COVERAGE_TOOL) {
              return this.executeTool(
                toolCall.function.name,
                toolCall.function.arguments,
                conversation.conversationId,
                quoteVehicleMemory,
              );
            }
            // One request per turn even if the model repeats the call.
            if (coverageLeadId) return JSON.stringify({ ok: true });
            const res = await this.requestCoverage(
              toolCall.function.arguments,
              conversation,
              from,
            );
            coverageLeadId = res.leadId;
            return res.result;
          }),
        );
        toolCalls.forEach((toolCall, i) => {
          this.logger.log(
            `   🔧 ${toolCall.function.name}(${toolCall.function.arguments.slice(0, 100)}) → ${results[i].slice(0, 200)}`,
          );
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: results[i],
          });
          if (toolCall.function.name === 'find_vehicle') {
            quoteVehicleMemory = this.rememberVehicleSearch(
              quoteVehicleMemory,
              results[i],
              toolCall.function.arguments,
              vehicleType,
            );
          }
        });
      }

      this.logger.warn(
        `[4/5] Se alcanzó el límite de ${MAX_TOOL_ROUNDS} rondas — pido respuesta final sin tools`,
      );
      const final = await this.openai.chat.completions.create({
        model: this.model,
        reasoning_effort: 'none',
        max_completion_tokens: MAX_TOKENS[handoff],
        messages,
        ...(tools ? { tools, tool_choice: 'none' as const } : {}),
      });
      await this.reportCompletionUsage(final, phoneNumberId);
      promptTokens += final.usage?.prompt_tokens ?? 0;
      completionTokens += final.usage?.completion_tokens ?? 0;
      const content = final.choices[0]?.message?.content;
      if (content) {
        quoteVehicleMemory = this.selectRememberedVehicle(
          quoteVehicleMemory,
          content,
        );
        return { text: content, coverageLeadId, quoteVehicleMemory };
      }
    } catch (error) {
      this.logger.error(
        `Error generando respuesta: ${(error as Error).message}`,
      );
    } finally {
      this.logCost(handoff, promptTokens, completionTokens);
    }

    return { text: FALLBACK_REPLY, coverageLeadId, quoteVehicleMemory };
  }

  private async reportCompletionUsage(
    completion: OpenAI.Chat.Completions.ChatCompletion,
    phoneNumberId: string,
  ): Promise<void> {
    if (!completion.usage) return;
    try {
      await this.api.reportOpenAiUsage({
        phoneNumberId,
        requestId: completion.id,
        timestamp: completion.created,
        model: this.model,
        inputTokens: completion.usage.prompt_tokens,
        outputTokens: completion.usage.completion_tokens,
        cachedInputTokens:
          completion.usage.prompt_tokens_details?.cached_tokens ?? 0,
      });
    } catch (error) {
      this.logger.error(
        `No se pudo registrar consumo OpenAI ${completion.id}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * The customer chose a quoted coverage: record it as a lead in the
   * Solicitudes panel (with everything the advisor needs to issue it) and flag
   * the chat for human attention. Before this the model just said "te derivo
   * con un asesor" and nothing reached anyone.
   */
  private async requestCoverage(
    rawArgs: string,
    conversation: BotConversation,
    from: string,
  ): Promise<{ result: string; leadId?: number }> {
    let args: Record<string, unknown>;
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return { result: JSON.stringify({ error: 'Argumentos inválidos' }) };
    }
    const code = typeof args.coverageCode === 'string' ? args.coverageCode : '';
    const name = typeof args.coverageName === 'string' ? args.coverageName : '';
    if (!code && !name) {
      return {
        result: JSON.stringify({ error: 'Falta la cobertura elegida' }),
      };
    }

    const vehicleType = args.vehicleType === 'moto' ? 'moto' : 'auto';
    const client = conversation.client;
    const payload: Record<string, unknown> = {
      cobertura: [code, name].filter(Boolean).join(' — '),
      vehiculo: args.vehicle,
      anio: args.manufactureYear,
      codigoPostal: args.postalCode,
      ...(typeof args.price === 'string' && args.price
        ? { precio: args.price }
        : {}),
      ...(vehicleType === 'auto' && typeof args.hasGnc === 'boolean'
        ? { gnc: args.hasGnc ? 'Sí' : 'No' }
        : {}),
      ...(client ? { dni: client.dni } : {}),
    };

    try {
      const { id } = await this.api.createLead(conversation.conversationId, {
        productType: vehicleType,
        contactName: client
          ? `${client.firstName} ${client.lastName}`.trim()
          : 'Cliente WhatsApp',
        phone: from,
        payload,
      });
      await this.api
        .requestHandoff(conversation.conversationId)
        .catch(() => undefined);
      this.logger.log(
        `📝 Pedido de contratación #${id}: ${String(payload.cobertura)} (${vehicleType})`,
      );
      return { result: JSON.stringify({ ok: true }), leadId: id };
    } catch (error) {
      return { result: this.toolError(REQUEST_COVERAGE_TOOL, error) };
    }
  }

  /**
   * Rolling per-hour rate cap on LLM hand-offs for a single sender. Records the
   * call and returns false once the sender exceeds LLM_CALLS_PER_HOUR within the
   * window. Keeps the OpenAI spend per number bounded as a last-resort backstop.
   */
  private allowLlmCall(key: string): boolean {
    const now = Date.now();
    const recent = (this.llmCalls.get(key) ?? []).filter(
      (t) => now - t < LLM_WINDOW_MS,
    );
    if (recent.length >= LLM_CALLS_PER_HOUR) {
      this.llmCalls.set(key, recent);
      return false;
    }
    recent.push(now);
    this.llmCalls.set(key, recent);
    return true;
  }

  /** Logs token usage and a running USD estimate for OpenAI cost visibility. */
  private logCost(
    handoff: 'cotizacion' | 'faq',
    promptTokens: number,
    completionTokens: number,
  ): void {
    if (promptTokens === 0 && completionTokens === 0) return;
    const cost =
      (promptTokens / 1_000_000) * this.priceInPer1M +
      (completionTokens / 1_000_000) * this.priceOutPer1M;
    this.llmCostUsd += cost;
    this.logger.log(
      `💸 OpenAI ${handoff}: ${promptTokens} in + ${completionTokens} out tokens ` +
        `≈ USD ${cost.toFixed(5)} — acumulado proceso: USD ${this.llmCostUsd.toFixed(4)}`,
    );
  }

  private readPositiveNumber(key: string, fallback: number): number {
    const parsed = Number(this.config.get<string>(key));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  /** Maps a tool call to its ApiService method. Always returns a JSON string for the model. */
  private async executeTool(
    name: string,
    rawArgs: string,
    conversationId: number,
    rememberedVehicle?: QuoteVehicleMemory,
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
        case 'find_vehicle':
          return JSON.stringify(
            await findVehicle(this.api, {
              vehicleType,
              brand: typeof args.brand === 'string' ? args.brand : '',
              model: typeof args.model === 'string' ? args.model : '',
              year: Number.isInteger(Number(args.year))
                ? Number(args.year)
                : undefined,
              version:
                typeof args.version === 'string' ? args.version : undefined,
            }),
          );
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
            args.groupId === undefined ? undefined : Number(args.groupId),
            args.query as string | undefined,
          );
          return JSON.stringify(
            models.map(({ codia, description }) => ({ codia, description })),
          );
        }
        case 'quote_vehicle': {
          // The InfoAuto codia encodes the Triunfo brand: codia = brand * 10000 + model.
          // Extract brand from the codia directly — never trust the LLM's brandId, which
          // can be wrong if it browsed models across mismatched brand/group combinations.
          const requestedCodia = Number(args.codia);
          const codiaNum =
            Number.isSafeInteger(requestedCodia) && requestedCodia > 10_000
              ? requestedCodia
              : rememberedVehicle?.vehicleType === vehicleType
                ? rememberedVehicle.selected?.codia
                : undefined;
          if (!codiaNum) {
            return JSON.stringify({
              error:
                'CODIA inválido o ausente. No se cotizó. Volvé a llamar find_vehicle con la marca, modelo, versión y año de la charla; después usá el CODIA positivo que devuelva.',
            });
          }
          if (codiaNum !== requestedCodia) {
            this.logger.warn(
              `quote_vehicle recibió CODIA inválido (${String(args.codia)}); uso el CODIA verificado ${codiaNum}`,
            );
          }
          const brandFromCodia = Math.floor(codiaNum / 10000);
          const quote = await this.api.quoteVehicle(vehicleType, {
            brand: String(brandFromCodia),
            model: String(codiaNum),
            manufactureYear: Number(args.manufactureYear),
            postalCode: Number(args.postalCode),
          });
          // Hand the model coverage names and ARS-formatted prices, not raw
          // codes and bare numbers — see constants/coverages.ts.
          return JSON.stringify(renderQuote(quote));
        }
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
      const data = error.response?.data as { message?: unknown } | undefined;
      const raw = data?.message ?? error.message;
      // Validation errors come back as arrays of objects — stringify them so
      // the log shows the reason instead of "[object Object]".
      const message = Array.isArray(raw)
        ? raw
            .map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
            .join('; ')
        : typeof raw === 'string'
          ? raw
          : JSON.stringify(raw);
      this.logger.warn(`Tool ${name} falló (${status ?? '?'}): ${message}`);
      return JSON.stringify({ error: message, status });
    }
    this.logger.error(`Tool ${name} falló: ${(error as Error).message}`);
    return JSON.stringify({ error: 'Error interno consultando los datos' });
  }
}
