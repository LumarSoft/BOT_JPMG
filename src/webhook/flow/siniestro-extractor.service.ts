import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { ApiService } from '../../api/api.service';
import { DEFAULT_OPENAI_MODEL } from '../constants/business';
import {
  SENTIDOS,
  type SiniestroCampo,
  type SiniestroDatos,
} from './siniestro-datos';

const nullable = (type: string) => ({ type: [type, 'null'] });

const DATOS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'fecha',
    'hora',
    'localidad',
    'calle',
    'altura',
    'entreCalles',
    'alturaDesconocida',
    'sentido',
    'relato',
    'personas',
    'lesionados',
    'lesionesDetalle',
    'otroVehiculo',
    'terceroPatente',
    'terceroConductor',
    'terceroCompania',
  ],
  properties: {
    fecha: nullable('string'),
    hora: nullable('string'),
    localidad: nullable('string'),
    calle: nullable('string'),
    altura: nullable('string'),
    entreCalles: nullable('string'),
    alturaDesconocida: nullable('boolean'),
    sentido: { type: ['string', 'null'], enum: [...SENTIDOS, null] },
    relato: nullable('string'),
    personas: nullable('integer'),
    lesionados: nullable('boolean'),
    lesionesDetalle: nullable('string'),
    otroVehiculo: nullable('boolean'),
    terceroPatente: nullable('string'),
    terceroConductor: nullable('string'),
    terceroCompania: nullable('string'),
  },
} as const;

function systemPrompt(today: string): string {
  return [
    'Extraés los datos de una denuncia de siniestro de un vehículo que un cliente escribe por WhatsApp, muchas veces desordenado o con errores.',
    `Hoy es ${today} (Argentina).`,
    'Devolvé solo lo que el cliente dijo. Si un dato no está, va null. No inventes ni completes con suposiciones.',
    'Reglas:',
    '- fecha: YYYY-MM-DD. Resolvé "hoy", "ayer", "el sábado", etc. contra la fecha de hoy.',
    '- hora: HH:MM en 24 h si la dio; si fue aproximada, tal como la dijo ("a la tarde", "cerca de las 8").',
    '- calle: solo el nombre de la calle donde ocurrió, sin el número. altura: solo el número.',
    '- Si dio una esquina o un cruce sin número ("en Pellegrini y Oroño"): calle = la primera calle, entreCalles = la otra (o "X y Y" si dio dos), altura = null.',
    '- alturaDesconocida: true solo si dijo explícitamente que no sabe el número/altura.',
    '- sentido: hacia dónde circulaba el vehículo asegurado (norte, sur, este, oeste). "no_sabe" solo si dijo que no lo sabe.',
    '- relato: cómo ocurrió, con sus palabras, corregido mínimamente para que se entienda.',
    '- personas: cantidad total de personas en el vehículo asegurado, contando al conductor ("iba solo" = 1).',
    '- lesionados: true/false según si hubo heridos; lesionesDetalle: quiénes y cómo.',
    '- otroVehiculo: true/false según si hubo otro vehículo involucrado; tercero*: los datos de ese vehículo si los dio.',
    'Si el mensaje responde a datos que se le pidieron (por ejemplo "no sé", "2", "norte", "no"), asignalo al dato pedido.',
  ].join('\n');
}

function argentinaToday(now: Date): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
}

/**
 * Reads the claim data out of the customer's free-text reply. The one place a
 * transactional flow uses the model: people who struggle with step-by-step
 * questions can answer the whole checklist at once, and the flow still owns
 * validation, the follow-up for what's missing and the final confirmation.
 */
@Injectable()
export class SiniestroExtractor {
  private readonly logger = new Logger(SiniestroExtractor.name);
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(
    config: ConfigService,
    private readonly api: ApiService,
  ) {
    this.openai = new OpenAI({ apiKey: config.get('OPENAI_API_KEY') });
    this.model = config.get<string>('OPENAI_MODEL') || DEFAULT_OPENAI_MODEL;
  }

  /** Throws when the model is unavailable or answers off-schema; the flow then falls back to step-by-step. */
  async extract(input: {
    text: string;
    known: SiniestroDatos;
    asked: SiniestroCampo[];
    phoneNumberId: string;
  }): Promise<Partial<SiniestroDatos>> {
    const completion = await this.openai.chat.completions.create({
      model: this.model,
      reasoning_effort: 'low',
      max_completion_tokens: 1200,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'siniestro_datos',
          strict: true,
          schema: DATOS_SCHEMA,
        },
      },
      messages: [
        { role: 'system', content: systemPrompt(argentinaToday(new Date())) },
        {
          role: 'user',
          content:
            `Datos ya recolectados: ${JSON.stringify(input.known)}\n` +
            `Datos que se le pidieron en el último mensaje: ${input.asked.length ? input.asked.join(', ') : 'toda la lista'}\n\n` +
            `Mensaje del cliente:\n${input.text}`,
        },
      ],
    });

    void this.reportUsage(completion, input.phoneNumberId);

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('Respuesta vacía del modelo');
    return JSON.parse(content) as Partial<SiniestroDatos>;
  }

  private async reportUsage(
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
}
