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

    if (!message || message.type !== 'text') return { status: 'ok' };

    const { from } = message;
    const text = message.text.body;
    const phoneNumberId = metadata?.phone_number_id;

    console.log(`📩 De: ${from} → "${text}"`);

    // Fire-and-forget: responde 200 a Meta de inmediato para evitar reintentos
    this.webhookService
      .handleMessage(from, text, phoneNumberId)
      .catch(console.error);

    return { status: 'ok' };
  }
}
