import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import axios from 'axios';
import { INSURANCE_ASSISTANT_PROMPT } from './constants/prompts';

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type ConversationSession = { messages: ChatMessage[]; lastActivity: number };

const MAX_HISTORY = 10;
const SESSION_TTL_MS = 30 * 60 * 1000;

@Injectable()
export class WebhookService {
  private readonly openai: OpenAI;
  private readonly sessions = new Map<string, ConversationSession>();

  constructor(private readonly config: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.config.get('OPENAI_API_KEY'),
    });
  }

  async handleMessage(from: string, text: string, phoneNumberId: string) {
    console.log(`🤖 Procesando mensaje de ${from}...`);

    const session = this.getSession(from);
    session.messages.push({ role: 'user', content: text });

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [
        { role: 'system', content: INSURANCE_ASSISTANT_PROMPT },
        ...session.messages,
      ],
    });

    const reply =
      completion.choices[0]?.message?.content ??
      'Lo siento, no pude procesar tu mensaje.';

    session.messages.push({ role: 'assistant', content: reply });
    this.trimSession(session);
    session.lastActivity = Date.now();

    console.log(`🤖 Respuesta IA: ${reply}`);

    await this.sendMessage(this.normalizePhone(from), reply, phoneNumberId);
  }

  private getSession(from: string): ConversationSession {
    const existing = this.sessions.get(from);
    if (existing && Date.now() - existing.lastActivity < SESSION_TTL_MS) {
      return existing;
    }
    const session: ConversationSession = { messages: [], lastActivity: Date.now() };
    this.sessions.set(from, session);
    return session;
  }

  private trimSession(session: ConversationSession): void {
    // Mantiene pares usuario/asistente, así que cortamos de a 2 desde el inicio
    while (session.messages.length > MAX_HISTORY) {
      session.messages.splice(0, 2);
    }
  }

  private async sendMessage(to: string, text: string, phoneNumberId: string) {
    const token = this.config.get('WHATSAPP_TOKEN');
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
      console.log(`✅ Respuesta enviada a ${to}`);
    } catch (error) {
      console.error(
        '❌ Error Meta:',
        JSON.stringify(error.response?.data, null, 2),
      );
    }
  }

  private normalizePhone(phone: string): string {
    // WhatsApp Argentina: remueve el '9' extra que agrega el móvil (549 → 54)
    if (phone.startsWith('549')) {
      return '54' + phone.slice(3);
    }
    return phone;
  }
}
