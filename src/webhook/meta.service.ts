import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

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
    const token = this.config.get<string>('WHATSAPP_TOKEN');
    const url = `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`;

    try {
      await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );
      this.logger.log(`✅ Mensaje enviado a ${to}`);
    } catch (error) {
      this.logger.error(
        `❌ Error Meta: ${JSON.stringify(axios.isAxiosError(error) ? error.response?.data : error)}`,
      );
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
