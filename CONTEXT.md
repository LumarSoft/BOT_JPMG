# whatsapp-bot-seguros — Contexto del proyecto

Bot de WhatsApp para una aseguradora argentina. Recibe mensajes via webhook de Meta, los procesa con OpenAI (GPT-4o-mini) y responde directamente al usuario por WhatsApp.

Stack: **NestJS 11 + TypeScript + OpenAI SDK + Axios**

---

## Estructura de archivos (`src/`)

```
src/
├── main.ts
├── app.module.ts
└── webhook/
    ├── webhook.module.ts
    ├── webhook.controller.ts
    ├── webhook.service.ts
    ├── webhook.controller.spec.ts
    ├── webhook.service.spec.ts
    ├── constants/
    │   └── prompts.ts
    └── types/
        └── whatsapp.types.ts
```

---

## Variables de entorno (`.env`)

El `.env` está ignorado por git (`.gitignore` lo incluye). Las variables requeridas son:

```
WEBHOOK_VERIFY_TOKEN=   # token para verificar el webhook con Meta
WHATSAPP_TOKEN=         # token de acceso de la API de WhatsApp Business
PHONE_NUMBER_ID=        # ID del número de teléfono en Meta (no se usa en código, viene del payload)
OPENAI_API_KEY=         # clave de API de OpenAI
```

---

## Código completo

### `src/main.ts`

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

---

### `src/app.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhookModule } from './webhook/webhook.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), WebhookModule],
})
export class AppModule {}
```

`ConfigModule` es global, por lo que `ConfigService` está disponible en todos los módulos sin importarlo individualmente.

---

### `src/webhook/webhook.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}
```

---

### `src/webhook/webhook.controller.ts`

Maneja dos rutas bajo `/webhook`:

- `GET /webhook` — verificación inicial del webhook por Meta
- `POST /webhook` — recepción de mensajes entrantes

```typescript
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
  async receiveMessage(@Body() body: WhatsAppWebhookBody) {
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
```

---

### `src/webhook/webhook.service.ts`

Contiene la lógica principal: llama a OpenAI y envía la respuesta por WhatsApp.

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import axios from 'axios';
import { INSURANCE_ASSISTANT_PROMPT } from './constants/prompts';

@Injectable()
export class WebhookService {
  private readonly openai: OpenAI;

  constructor(private readonly config: ConfigService) {
    this.openai = new OpenAI({
      apiKey: this.config.get('OPENAI_API_KEY'),
    });
  }

  async handleMessage(from: string, text: string, phoneNumberId: string) {
    console.log(`🤖 Procesando mensaje de ${from}...`);

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [
        { role: 'system', content: INSURANCE_ASSISTANT_PROMPT },
        { role: 'user', content: text },
      ],
    });

    const reply =
      completion.choices[0]?.message?.content ??
      'Lo siento, no pude procesar tu mensaje.';

    console.log(`🤖 Respuesta IA: ${reply}`);

    await this.sendMessage(this.normalizePhone(from), reply, phoneNumberId);
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
```

---

### `src/webhook/constants/prompts.ts`

System prompt de OpenAI. Se edita acá para ajustar el comportamiento del bot.

```typescript
export const INSURANCE_ASSISTANT_PROMPT = `Sos un asistente virtual de una aseguradora argentina. Tu rol es ayudar a los clientes con consultas sobre sus pólizas, coberturas, siniestros y pagos.

Directrices:
- Respondé siempre en español argentino, de manera amable y profesional.
- Si el cliente pregunta por su póliza específica o datos personales, informale que un asesor lo va a contactar.
- Para cotizaciones, solicitá: tipo de seguro (auto, hogar, vida), datos del bien a asegurar y datos de contacto.
- Si hay un siniestro urgente, indicá que llame al número de emergencias o que un asesor lo contactará a la brevedad.
- No inventes coberturas, montos ni condiciones. Si no sabés algo, derivá al asesor.
- Mantené las respuestas breves y claras, ideales para WhatsApp.`;
```

---

### `src/webhook/types/whatsapp.types.ts`

Tipado del payload que envía Meta al webhook.

```typescript
export interface WhatsAppTextMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text';
  text: { body: string };
}

export interface WhatsAppMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

export interface WhatsAppWebhookBody {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: WhatsAppMetadata;
        messages?: WhatsAppTextMessage[];
      };
      field: string;
    }>;
  }>;
}
```

---

### `src/webhook/webhook.service.spec.ts`

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookService } from './webhook.service';

describe('WebhookService', () => {
  let service: WebhookService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-value') },
        },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
```

---

### `src/webhook/webhook.controller.spec.ts`

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

describe('WebhookController', () => {
  let controller: WebhookController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        {
          provide: WebhookService,
          useValue: { handleMessage: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-value') },
        },
      ],
    }).compile();

    controller = module.get<WebhookController>(WebhookController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
```

---

## Dependencias principales

| Paquete                          | Versión | Uso                                        |
| -------------------------------- | ------- | ------------------------------------------ |
| `@nestjs/common`, `@nestjs/core` | ^11     | Framework principal                        |
| `@nestjs/config`                 | ^4      | Variables de entorno via `ConfigService`   |
| `openai`                         | ^6      | SDK oficial de OpenAI                      |
| `axios`                          | ^1      | HTTP client para llamadas a la API de Meta |

---

## Scripts disponibles

```bash
npm run start:dev   # desarrollo con hot reload
npm run build       # compila a /dist
npm run start:prod  # corre desde /dist
npm run test        # corre los tests
npm run test:cov    # coverage
```

---

## Flujo de funcionamiento

```
Usuario WhatsApp
      |
      | mensaje de texto
      v
POST /webhook  (WebhookController)
      |
      | fire-and-forget (responde 200 inmediatamente a Meta)
      v
WebhookService.handleMessage()
      |
      |-- normalizePhone()  (549xxxxxxxx → 54xxxxxxxx)
      |-- OpenAI GPT-4o-mini con INSURANCE_ASSISTANT_PROMPT
      |
      v
WebhookService.sendMessage()  (privado)
      |
      | POST graph.facebook.com/v25.0/{phoneNumberId}/messages
      v
Usuario recibe respuesta en WhatsApp
```

---

## Decisiones de diseño relevantes

- **Fire-and-forget en el controller**: el POST responde `{ status: 'ok' }` de inmediato antes de que termine el procesamiento de IA. Esto evita que Meta reintente el webhook por timeout (Meta espera respuesta en menos de 20 segundos; OpenAI puede tardar más).
- **`normalizePhone`**: WhatsApp Argentina envía números con prefijo `549` (el `9` es un artefacto del sistema argentino). La API de envío de Meta requiere `54` sin el `9`.
- **`ConfigModule.forRoot({ isGlobal: true })`**: permite usar `ConfigService` en cualquier módulo sin importar `ConfigModule` localmente.
- **System prompt separado en `constants/prompts.ts`**: facilita ajustar el comportamiento del bot sin tocar la lógica del servicio.

---

## Pendientes / próximos pasos sugeridos

- Ajustar `INSURANCE_ASSISTANT_PROMPT` con información real de la aseguradora (nombre, coberturas, número de emergencias, etc.)
- Agregar manejo de conversaciones con historial (hoy cada mensaje es stateless, sin contexto previo)
- Considerar guardar los intercambios en base de datos para seguimiento
- Agregar tests de integración para `handleMessage` y `sendMessage`
- Configurar despliegue (Railway, Render, etc.) con las variables de entorno de producción
