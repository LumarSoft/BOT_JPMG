import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import axios from 'axios';
import { ApiService } from '../api/api.service';
import type { BotContext, BotConversation } from '../api/api.types';
import { buildSystemPrompt } from './constants/prompts';
import { BOT_TOOLS } from './constants/tools';

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const MODEL = 'gpt-4o-mini';
const MAX_TOOL_ROUNDS = 6;

const FALLBACK_REPLY =
  'Disculpá, en este momento tenemos un inconveniente técnico. ' +
  'Probá de nuevo en unos minutos o comunicate con nuestra oficina de lunes a viernes de 8 a 16 hs.';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly openai: OpenAI;
  private readonly towTruckPhone?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly api: ApiService,
  ) {
    this.openai = new OpenAI({
      apiKey: this.config.get('OPENAI_API_KEY'),
    });
    this.towTruckPhone = this.config.get('TOW_TRUCK_PHONE');
  }

  async handleMessage(from: string, text: string, phoneNumberId: string) {
    this.logger.log(`Procesando mensaje de ${from}...`);

    let context: BotContext;
    try {
      context = await this.api.getContext(phoneNumberId);
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
      await this.sendMessage(
        this.normalizePhone(from),
        FALLBACK_REPLY,
        phoneNumberId,
      );
      return;
    }

    let conversation: BotConversation;
    try {
      conversation = await this.api.getConversation(phoneNumberId, from);
      await this.api.saveMessage(conversation.conversationId, 'user', text);
    } catch (error) {
      this.logger.error(
        `API no disponible (conversation): ${(error as Error).message}`,
      );
      await this.sendMessage(
        this.normalizePhone(from),
        FALLBACK_REPLY,
        phoneNumberId,
      );
      return;
    }

    const reply = await this.generateReply(context, conversation, text);

    // Best-effort: si falla el guardado igual respondemos al usuario
    await this.api
      .saveMessage(conversation.conversationId, 'assistant', reply)
      .catch((error: Error) =>
        this.logger.error(`No se pudo guardar la respuesta: ${error.message}`),
      );

    await this.sendMessage(this.normalizePhone(from), reply, phoneNumberId);
  }

  /** Runs the OpenAI tool-calling loop until the model produces a final text reply. */
  private async generateReply(
    context: BotContext,
    conversation: BotConversation,
    text: string,
  ): Promise<string> {
    const messages: ChatMessageParam[] = [
      { role: 'system', content: this.buildSystem(context, conversation) },
      ...conversation.messages.map(
        (m): ChatMessageParam => ({ role: m.role, content: m.content }),
      ),
      { role: 'user', content: text },
    ];

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const completion = await this.openai.chat.completions.create({
          model: MODEL,
          max_tokens: 800,
          messages,
          tools: BOT_TOOLS,
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
          return message.content ?? FALLBACK_REPLY;
        }

        messages.push(message);
        for (const toolCall of toolCalls) {
          const result = await this.executeTool(
            toolCall.function.name,
            toolCall.function.arguments,
            conversation.conversationId,
          );
          this.logger.log(
            `🔧 ${toolCall.function.name} → ${result.slice(0, 200)}`,
          );
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: result,
          });
        }
      }
    } catch (error) {
      this.logger.error(
        `Error generando respuesta: ${(error as Error).message}`,
      );
    }

    return FALLBACK_REPLY;
  }

  private buildSystem(
    context: BotContext,
    conversation: BotConversation,
  ): string {
    let prompt = buildSystemPrompt({
      producerPrompt: context.systemPrompt,
      towTruckPhone: this.towTruckPhone,
      today: new Date().toLocaleDateString('es-AR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
    });

    if (conversation.client) {
      const { firstName, lastName, dni } = conversation.client;
      prompt +=
        `\n\n## CLIENTE IDENTIFICADO EN ESTA CONVERSACIÓN\n` +
        `${firstName} ${lastName} (DNI ${dni}). Ya está identificado: no vuelvas a pedirle DNI ni patente y podés usar las tools de cliente directamente.`;
    }

    return prompt;
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

  private async sendMessage(to: string, text: string, phoneNumberId: string) {
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
      this.logger.log(`✅ Respuesta enviada a ${to}`);
    } catch (error) {
      this.logger.error(
        `❌ Error Meta: ${JSON.stringify(axios.isAxiosError(error) ? error.response?.data : error)}`,
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
