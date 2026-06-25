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
import type { WhatsAppWebhookBody } from './types/whatsapp.types';

@Controller('webhook')
export class WebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly webhookService: WebhookService,
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
    const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const metadata = body?.entry?.[0]?.changes?.[0]?.value?.metadata;

    if (!message) return { status: 'ok' };

    const phoneNumberId = metadata?.phone_number_id;

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
}
