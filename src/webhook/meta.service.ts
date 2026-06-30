import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/** Trims a string to Meta's per-field limit, adding an ellipsis when cut. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/**
 * Thin wrapper over the Meta Cloud API send endpoint, shared by the webhook
 * (replies) and the inactivity job (warnings).
 */
@Injectable()
export class MetaService {
  private readonly logger = new Logger(MetaService.name);

  constructor(private readonly config: ConfigService) {}

  async sendText(
    to: string,
    text: string,
    phoneNumberId: string,
  ): Promise<void> {
    await this.send(phoneNumberId, {
      to,
      type: 'text',
      text: { body: text },
    });
  }

  /**
   * Sends an interactive message with up to 3 reply buttons. Meta caps button
   * titles at 20 chars and the body at 1024 — we truncate defensively so a long
   * label never makes the whole send fail.
   */
  async sendButtons(
    to: string,
    body: string,
    buttons: { id: string; title: string }[],
    phoneNumberId: string,
  ): Promise<void> {
    await this.send(phoneNumberId, {
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: truncate(body, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: truncate(b.title, 20) },
          })),
        },
      },
    });
  }

  /**
   * Sends an interactive list message (a single section, up to 10 rows). Used
   * for menus with more than 3 options. Row titles cap at 24 chars and
   * descriptions at 72.
   */
  async sendList(
    to: string,
    body: string,
    buttonLabel: string,
    rows: { id: string; title: string; description?: string }[],
    phoneNumberId: string,
  ): Promise<void> {
    await this.send(phoneNumberId, {
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: truncate(body, 1024) },
        action: {
          button: truncate(buttonLabel, 20),
          sections: [
            {
              rows: rows.slice(0, 10).map((r) => ({
                id: r.id,
                title: truncate(r.title, 24),
                ...(r.description
                  ? { description: truncate(r.description, 72) }
                  : {}),
              })),
            },
          ],
        },
      },
    });
  }

  /**
   * Sends an approved template message (HSM). Required for first contact outside
   * the 24-hour window — e.g. following up a web quote with a client who never
   * messaged the bot. `params` fill the body variables ({{1}}, {{2}}, …) in order.
   */
  async sendTemplate(
    to: string,
    phoneNumberId: string,
    template: string,
    lang: string,
    params: string[] = [],
  ): Promise<void> {
    const components = params.length
      ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }]
      : undefined;
    await this.send(phoneNumberId, {
      to,
      type: 'template',
      template: {
        name: template,
        language: { code: lang },
        ...(components ? { components } : {}),
      },
    });
  }

  /** Posts a message payload to the Meta Cloud API, swallowing errors (logged). */
  private async send(
    phoneNumberId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const token = this.config.get<string>('WHATSAPP_TOKEN');
    const url = `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`;

    try {
      await axios.post(
        url,
        { messaging_product: 'whatsapp', ...payload },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );
      this.logger.log(`✅ Mensaje enviado a ${payload.to as string}`);
    } catch (error) {
      this.logger.error(
        `❌ Error Meta: ${JSON.stringify(axios.isAxiosError(error) ? error.response?.data : error)}`,
      );
    }
  }

  /**
   * Downloads a media object (e.g. a siniestro photo) from the Meta Cloud API.
   * Meta returns the bytes in two steps: first resolve the media id to a signed
   * URL, then fetch that URL — both calls need the bearer token. Returns null on
   * failure so the caller can fall back gracefully.
   */
  async downloadMedia(
    mediaId: string,
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const token = this.config.get<string>('WHATSAPP_TOKEN');

    try {
      const { data: media } = await axios.get<{
        url: string;
        mime_type: string;
      }>(`https://graph.facebook.com/v25.0/${mediaId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const { data } = await axios.get<ArrayBuffer>(media.url, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'arraybuffer',
      });

      return { buffer: Buffer.from(data), mimeType: media.mime_type };
    } catch (error) {
      this.logger.error(
        `❌ Error descargando media ${mediaId}: ${JSON.stringify(
          axios.isAxiosError(error) ? error.response?.data : error,
        )}`,
      );
      return null;
    }
  }

  /** WhatsApp Argentina reports 549...; Meta's send API wants 54... (drops the extra 9). */
  normalizePhone(phone: string): string {
    if (phone.startsWith('549')) {
      return '54' + phone.slice(3);
    }
    return phone;
  }
}
