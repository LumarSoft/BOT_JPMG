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
import { ApiService } from '../api/api.service';
import type {
  WhatsAppWebhookBody,
  WhatsAppStatus,
} from './types/whatsapp.types';

@Controller('webhook')
export class WebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly webhookService: WebhookService,
    private readonly api: ApiService,
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
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const metadata = value?.metadata;
    const phoneNumberIdFromMeta = metadata?.phone_number_id;

    // Status callbacks carry Meta's billing info; they arrive without `messages`.
    if (value?.statuses?.length) {
      this.reportBillableConversations(value.statuses, phoneNumberIdFromMeta);
    }

    if (!message) return { status: 'ok' };

    const phoneNumberId = phoneNumberIdFromMeta;

    // Fire-and-forget: responde 200 a Meta de inmediato para evitar reintentos
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

    return { status: 'ok' };
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
