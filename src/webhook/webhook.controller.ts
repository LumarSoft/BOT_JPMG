import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import { SentMessageRegistry } from './sent-message-registry.service';
import { ApiService } from '../api/api.service';
import type {
  WhatsAppWebhookBody,
  WhatsAppStatus,
  WhatsAppMessage,
  WhatsAppMetadata,
} from './types/whatsapp.types';
import type {
  WhatsAppHistoryChunk,
  WhatsAppMessageEcho,
} from './types/coexistence.types';

@Controller('webhook')
export class WebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly webhookService: WebhookService,
    private readonly api: ApiService,
    private readonly sent: SentMessageRegistry,
  ) {}

  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    if (
      mode === 'subscribe' &&
      token === this.config.get('WEBHOOK_VERIFY_TOKEN')
    ) {
      console.log('✅ Webhook verificado por Meta');
      return challenge;
    }
    throw new ForbiddenException('Token de verificación inválido');
  }

  @Post()
  receiveMessage(@Body() body: WhatsAppWebhookBody) {
    // Meta batches: one delivery can carry several entries, each with several
    // changes, and on a Coexistence number those changes are of DIFFERENT kinds
    // (a live message, an echo of what an employee typed, a chunk of history).
    // Reading only entry[0].changes[0] — as this did — silently drops the rest.
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        if (!value) continue;
        const phoneNumberId = value.metadata?.phone_number_id;

        switch (change.field) {
          case 'smb_message_echoes':
            this.handleAgentEchoes(value.message_echoes ?? [], phoneNumberId);
            break;

          case 'history':
            this.absorbHistory(value.history ?? [], phoneNumberId);
            break;

          case 'smb_app_state_sync':
            // Address-book changes. Nothing consumes them yet; logged so the
            // volume is visible before deciding whether to sync contacts.
            console.log(
              `📇 ${value.state_sync?.length ?? 0} cambio(s) de contactos en ${phoneNumberId ?? 'sin número'}`,
            );
            break;

          case 'account_update':
            this.handleAccountUpdate(
              entry.id,
              value.event,
              value.disconnection_info,
              phoneNumberId,
            );
            break;

          default:
            // "messages" and anything new Meta starts sending.
            if (value.statuses?.length) {
              this.reportBillableConversations(value.statuses, phoneNumberId);
            }
            for (const message of value.messages ?? []) {
              this.handleInboundMessage(message, value.metadata);
            }
        }
      }
    }

    return { status: 'ok' };
  }

  /** A live message from a customer. Unchanged behaviour: fire-and-forget so
   *  Meta gets its 200 immediately and stops retrying. */
  private handleInboundMessage(
    message: WhatsAppMessage,
    metadata: WhatsAppMetadata | undefined,
  ): void {
    const phoneNumberId = metadata?.phone_number_id;
    // Routing is by number: without it we cannot resolve which tenant this
    // belongs to, so there is nothing sensible to do with the message.
    if (!phoneNumberId) {
      console.warn('⚠️ Mensaje entrante sin phone_number_id — se ignora');
      return;
    }

    if (message.type === 'text') {
      console.log(`📩 De: ${message.from} → "${message.text.body}"`);
      this.webhookService
        .handleMessage(
          message.from,
          message.text.body,
          phoneNumberId,
          message.id,
        )
        .catch(console.error);
    } else if (message.type === 'interactive') {
      // A button/list tap: the title is the human-readable label (kept for the
      // transcript) and the id is the deterministic option the flow routes on.
      const reply =
        message.interactive.type === 'button_reply'
          ? message.interactive.button_reply
          : message.interactive.list_reply;
      console.log(`👆 De: ${message.from} → [opción ${reply.id}]`);
      this.webhookService
        .handleMessage(
          message.from,
          reply.title ?? '',
          phoneNumberId,
          message.id,
          reply.id,
        )
        .catch(console.error);
    } else if (message.type === 'image') {
      console.log(`🖼️ De: ${message.from} → [imagen ${message.image.id}]`);
      this.webhookService
        .handleMedia(message.from, message.image.id, phoneNumberId, message.id)
        .catch(console.error);
    }
  }

  /**
   * An employee answered from the WhatsApp Business app on the phone.
   *
   * This is THE reason Coexistence needs webhook work: the customer's message
   * still arrives as a normal inbound message, so without this the bot answers
   * on top of the employee, live, in front of the customer. Recording the echo
   * pauses the bot for that conversation using the same `botPaused` flag as the
   * manual takeover, so releasing it from the inbox already works.
   */
  private handleAgentEchoes(
    echoes: WhatsAppMessageEcho[],
    phoneNumberId: string | undefined,
  ): void {
    if (!phoneNumberId) return;

    for (const echo of echoes) {
      // Our own API sends can bounce back here. Pausing on those would mute the
      // bot everywhere, quietly.
      if (this.sent.isOurs(echo.id)) continue;

      const content = describeEcho(echo);
      if (!content || !echo.to) continue;

      console.log(`🧑‍💼 Agente → ${echo.to}: "${content}" (bot en pausa)`);
      void this.api
        .recordAgentEcho({
          phoneNumberId,
          waId: echo.to,
          content,
          waMessageId: echo.id,
        })
        .catch(console.error);
    }
  }

  /**
   * The 180-day historical sync that lands right after onboarding, in three
   * phases (0-1 day, 1-90, 90-180).
   *
   * Absorbed on purpose and NOT routed through handleMessage: these are old
   * conversations, and feeding them to the flow would have the bot answering
   * messages from months ago. Only progress is logged — enough to confirm all
   * three phases arrived inside the 24 h window Meta gives to sync.
   */
  private absorbHistory(
    chunks: WhatsAppHistoryChunk[],
    phoneNumberId: string | undefined,
  ): void {
    for (const chunk of chunks) {
      const threads = chunk.threads?.length ?? 0;
      const messages = (chunk.threads ?? []).reduce(
        (total, thread) => total + (thread.messages?.length ?? 0),
        0,
      );
      console.log(
        `🕘 Historial ${phoneNumberId ?? ''} · fase ${chunk.metadata?.phase ?? '?'} ` +
          `· chunk ${chunk.metadata?.chunk_order ?? '?'} · progreso ${chunk.metadata?.progress ?? '?'}% ` +
          `· ${threads} chat(s), ${messages} mensaje(s)`,
      );
    }
  }

  /**
   * Lifecycle notices for the WABA. PARTNER_REMOVED means the number stopped
   * delivering webhooks — most often because nobody opened the WhatsApp
   * Business app for 13 days. Loud on purpose: the failure mode otherwise is a
   * number that goes quiet with nothing in the logs.
   */
  private handleAccountUpdate(
    wabaId: string,
    event: string | undefined,
    info: { disconnect_reason?: string; initiated_by?: string } | undefined,
    phoneNumberId: string | undefined,
  ): void {
    if (event !== 'PARTNER_REMOVED') {
      console.log(
        `ℹ️ account_update "${event ?? 'sin evento'}" en ${phoneNumberId ?? 'sin número'}`,
      );
      return;
    }
    console.error(
      `🚨 DESCONEXIÓN de ${phoneNumberId ?? 'sin número'} · motivo: ${info?.disconnect_reason ?? 'desconocido'} ` +
        `· iniciada por: ${info?.initiated_by ?? 'desconocido'}. El número dejó de recibir mensajes.`,
    );
    void this.api
      .markWabaDisconnected(wabaId, info?.disconnect_reason)
      .catch(console.error);
  }

  /**
   * Counts billable Meta conversations from a batch of status callbacks.
   *
   * Meta bills per CONVERSATION, not per message, and repeats the same
   * `conversation.id` across every message inside it — plus it fires one status
   * per state change (sent → delivered → read). Counting raw statuses would
   * multiply the cost several times over, so only conversation ids not seen
   * before are reported.
   */
  private reportBillableConversations(
    statuses: WhatsAppStatus[],
    phoneNumberId: string | undefined,
  ): void {
    if (!phoneNumberId) return;

    const fresh = new Set<string>();
    for (const s of statuses) {
      const id = s.conversation?.id;
      if (!id) continue;
      if (s.pricing?.billable === false) continue;
      if (this.billedConversations.has(id)) continue;
      fresh.add(id);
    }
    if (!fresh.size) return;

    for (const id of fresh) this.rememberConversation(id);

    console.log(
      `💰 ${fresh.size} conversación(es) facturables de Meta en ${phoneNumberId}`,
    );
    void this.api.reportMetaUsage({ phoneNumberId, conversations: fresh.size });
  }

  /**
   * Conversation ids already reported. Meta keeps sending statuses for a
   * conversation for up to 24 h, so entries are dropped after that window; the
   * cap is a safety net against unbounded growth.
   */
  private readonly billedConversations = new Map<string, number>();
  private static readonly CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly MAX_TRACKED = 5000;

  private rememberConversation(id: string): void {
    const now = Date.now();
    this.billedConversations.set(id, now);

    if (this.billedConversations.size <= WebhookController.MAX_TRACKED) return;
    for (const [key, at] of this.billedConversations) {
      if (now - at > WebhookController.CONVERSATION_TTL_MS) {
        this.billedConversations.delete(key);
      }
    }
    // Still too many even after expiring: drop the oldest insertions.
    while (this.billedConversations.size > WebhookController.MAX_TRACKED) {
      const oldest = this.billedConversations.keys().next().value;
      if (oldest === undefined) break;
      this.billedConversations.delete(oldest);
    }
  }
}

/**
 * Flattens an echo into the one line that goes into the transcript. Non-text
 * messages become a short placeholder so the inbox shows that *something* was
 * sent rather than an empty bubble.
 */
function describeEcho(echo: WhatsAppMessageEcho): string {
  if (echo.text?.body) return echo.text.body;
  if (echo.image) return echo.image.caption ?? '[imagen]';
  if (echo.document)
    return (
      echo.document.caption ??
      `[documento${echo.document.filename ? ` ${echo.document.filename}` : ''}]`
    );
  if (echo.video) return echo.video.caption ?? '[video]';
  if (echo.audio) return '[audio]';
  if (echo.sticker) return '[sticker]';
  return `[${echo.type ?? 'mensaje'}]`;
}
