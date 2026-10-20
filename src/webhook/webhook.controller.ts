import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isStorableDocument,
  WebhookService,
  type SharedItem,
} from './webhook.service';
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

/**
 * account_update events that may mean the number left Cloud API: the business
 * disconnected (PARTNER_REMOVED), re-registered or offboarded the Business-app
 * number (ACCOUNT_OFFBOARDED), or our app lost its access (PARTNER_APP_UNINSTALLED).
 */
const CONNECTION_EVENTS = new Set([
  'PARTNER_REMOVED',
  'ACCOUNT_OFFBOARDED',
  'PARTNER_APP_UNINSTALLED',
]);

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
  async receiveMessage(@Body() body: WhatsAppWebhookBody) {
    const persistence: Promise<void>[] = [];
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
            persistence.push(
              this.persistHistory(value.history ?? [], phoneNumberId),
            );
            break;

          case 'smb_app_state_sync':
            persistence.push(
              this.persistContacts(value.state_sync ?? [], phoneNumberId),
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
              persistence.push(
                this.reportDeliveredMessages(value.statuses, phoneNumberId),
              );
            }
            for (const message of value.messages ?? []) {
              const contactName = value.contacts?.find(
                (contact) => contact.wa_id === message.from,
              )?.profile?.name;
              this.handleInboundMessage(message, value.metadata, contactName);
            }
        }
      }
    }

    // A failed persistence request must fail the webhook delivery so Meta retries
    // it. The API de-duplicates both messages and contacts, making retries safe.
    await Promise.all(persistence);
    return { status: 'ok' };
  }

  /** A live message from a customer. Unchanged behaviour: fire-and-forget so
   *  Meta gets its 200 immediately and stops retrying. */
  private handleInboundMessage(
    message: WhatsAppMessage,
    metadata: WhatsAppMetadata | undefined,
    contactName?: string,
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
          undefined,
          contactName,
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
          contactName,
        )
        .catch(console.error);
    } else if (message.type === 'audio') {
      console.log(`🎤 De: ${message.from} → [audio ${message.audio.id}]`);
      this.webhookService
        .handleAudio(
          message.from,
          message.audio.id,
          phoneNumberId,
          message.id,
          contactName,
        )
        .catch(console.error);
    } else if (message.type === 'image') {
      console.log(`🖼️ De: ${message.from} → [imagen ${message.image.id}]`);
      this.webhookService
        .handleMedia(
          message.from,
          message.image.id,
          phoneNumberId,
          message.id,
          contactName,
          { caption: message.image.caption },
        )
        .catch(console.error);
    } else if (message.type === 'document') {
      const { document } = message;
      console.log(
        `📄 De: ${message.from} → [documento ${document.mime_type} ${document.id}]`,
      );
      // A PDF or a photo sent as a document is stored like a photo; anything
      // else (a .docx) is only noted, since the API keeps images and PDFs.
      if (isStorableDocument(document.mime_type))
        this.webhookService
          .handleMedia(
            message.from,
            document.id,
            phoneNumberId,
            message.id,
            contactName,
            {
              document: { filename: document.filename },
              caption: document.caption,
            },
          )
          .catch(console.error);
      else
        this.shareItem(message.from, phoneNumberId, message.id, contactName, {
          kind: 'file',
          content: `[El cliente envió un archivo que el bot no puede abrir${document.filename ? `: ${document.filename}` : ''}]`,
        });
    } else if (message.type === 'video') {
      console.log(`🎥 De: ${message.from} → [video ${message.video.id}]`);
      this.shareItem(message.from, phoneNumberId, message.id, contactName, {
        kind: 'video',
        content:
          '[El cliente envió un video]' +
          (message.video.caption ? ` ${message.video.caption}` : ''),
      });
    } else if (message.type === 'location') {
      const { latitude, longitude, name, address } = message.location;
      console.log(`📍 De: ${message.from} → [ubicación]`);
      const place = [name, address].filter(Boolean).join(', ');
      const map = `https://maps.google.com/?q=${latitude},${longitude}`;
      this.shareItem(message.from, phoneNumberId, message.id, contactName, {
        kind: 'location',
        content: `📍 Ubicación: ${place ? `${place} ` : ''}(${map})`,
        flowText: `Lugar: ${place || `ubicación compartida ${map}`}`,
      });
    } else if (message.type === 'contacts') {
      console.log(`📇 De: ${message.from} → [contacto]`);
      const cards = message.contacts
        .map((c) =>
          [c.name?.formatted_name, ...(c.phones ?? []).map((p) => p.phone)]
            .filter(Boolean)
            .join(' '),
        )
        .filter(Boolean);
      this.shareItem(message.from, phoneNumberId, message.id, contactName, {
        kind: 'contacts',
        content: `[El cliente compartió un contacto: ${cards.join('; ') || 'sin datos'}]`,
      });
    }
  }

  private shareItem(
    from: string,
    phoneNumberId: string,
    messageId: string,
    contactName: string | undefined,
    item: SharedItem,
  ): void {
    this.webhookService
      .handleSharedItem(from, phoneNumberId, messageId, item, contactName)
      .catch(console.error);
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
   * Persisted through the API but NOT routed through handleMessage: these are old
   * conversations, and feeding them to the flow would have the bot answering
   * messages from months ago. Progress is also logged so all three phases can be
   * confirmed inside the 24 h window Meta gives to sync.
   */
  private persistHistory(
    chunks: WhatsAppHistoryChunk[],
    phoneNumberId: string | undefined,
  ): Promise<void> {
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

    if (!phoneNumberId) {
      console.warn('⚠️ Historial sin phone_number_id — no se puede persistir');
      return Promise.resolve();
    }
    return this.api.persistCoexistenceHistory({ phoneNumberId, chunks });
  }

  private persistContacts(
    contacts: import('./types/coexistence.types').WhatsAppAppStateSyncItem[],
    phoneNumberId: string | undefined,
  ): Promise<void> {
    console.log(
      `📇 ${contacts.length} cambio(s) de contactos en ${phoneNumberId ?? 'sin número'}`,
    );
    if (!phoneNumberId) {
      console.warn('⚠️ Contactos sin phone_number_id — no se pueden persistir');
      return Promise.resolve();
    }
    return this.api.persistCoexistenceContacts({ phoneNumberId, contacts });
  }

  /**
   * Lifecycle notices for the WABA. Every one is logged with the WABA id and the
   * raw disconnection_info: on 19/10/2026 a PARTNER_REMOVED matched no stored
   * WABA and the log could not say which one Meta meant.
   *
   * The ones that may mean the number left Cloud API go to the API, which checks
   * them against Graph, marks the number and emails the office. The failure mode
   * otherwise is a number that goes quiet until the client calls.
   */
  private handleAccountUpdate(
    wabaId: string,
    event: string | undefined,
    info:
      | { reason?: string; disconnect_reason?: string; initiated_by?: string }
      | undefined,
    phoneNumberId: string | undefined,
  ): void {
    const details =
      `WABA ${wabaId} · número ${phoneNumberId ?? '—'} · ` +
      `disconnection_info ${JSON.stringify(info ?? null)}`;
    if (!event || !CONNECTION_EVENTS.has(event)) {
      console.log(`ℹ️ account_update "${event ?? 'sin evento'}" · ${details}`);
      return;
    }

    const reason = info?.reason ?? info?.disconnect_reason;
    console.error(
      `🚨 account_update ${event} · motivo: ${reason ?? 'desconocido'} ` +
        `· iniciado por: ${info?.initiated_by ?? 'desconocido'} · ${details}. ` +
        'El número puede haber dejado de recibir mensajes.',
    );
    void this.api
      .reportWabaAccountUpdate(wabaId, {
        event,
        reason,
        initiatedBy: info?.initiated_by,
      })
      .then((result) =>
        console.error(
          `🚨 ${event}: la API revisó ${result.checked} WABA(s) ` +
            `(${result.known ? 'conocida' : 'NO registrada'}) y marcó ${result.disconnected} como desconectada(s)`,
        ),
      )
      .catch(console.error);
  }

  /** Count message ids, never conversation ids; API handles callback retries. */
  private async reportDeliveredMessages(
    statuses: WhatsAppStatus[],
    phoneNumberId?: string,
  ): Promise<void> {
    if (!phoneNumberId) return;
    for (const status of statuses) {
      if (status.status !== 'delivered') continue;
      if (!status.id || typeof status.pricing?.billable !== 'boolean') continue;
      await this.api.reportMetaUsage({
        phoneNumberId,
        messageId: status.id,
        category: status.pricing.category ?? 'service',
        billable: status.pricing.billable,
        recipient: status.recipient_id,
        timestamp: Number(status.timestamp),
      });
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
