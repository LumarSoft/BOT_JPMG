# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run start:dev      # desarrollo con hot reload
npm run build          # compila TypeScript a /dist
npm run start:prod     # corre desde /dist (requiere build previo)
npm run test           # corre todos los unit tests
npm run test:cov       # tests con reporte de coverage
npm run lint           # lint + autofix con ESLint
npm run format         # formatea con Prettier
```

Correr un único test file:
```bash
npx jest src/webhook/webhook.service.spec.ts
```

## Arquitectura

El proyecto tiene un único módulo de negocio: `WebhookModule`. El `AppModule` solo registra `ConfigModule` (global) y `WebhookModule`.

**Flujo de un mensaje entrante:**

1. Meta llama a `POST /webhook` con el payload de WhatsApp
2. `WebhookController.receiveMessage` extrae `from`, `text` y `phoneNumberId` del payload anidado de Meta
3. Lanza `WebhookService.handleMessage` en fire-and-forget (`.catch(console.error)`) y responde `{ status: 'ok' }` de inmediato — esto es intencional para evitar reintentos de Meta por timeout
4. `handleMessage` llama a OpenAI con el `INSURANCE_ASSISTANT_PROMPT`, normaliza el número de teléfono y llama a `sendMessage` (privado)
5. `sendMessage` hace POST a `graph.facebook.com/v25.0/{phoneNumberId}/messages`

**Detalle importante — `normalizePhone`:** WhatsApp Argentina reporta números con prefijo `549` (ej. `5491155556666`). La API de envío de Meta requiere `54` sin el `9` intercalado (ej. `541155556666`). La función recorta ese dígito.

## Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `OPENAI_API_KEY` | Clave de la API de OpenAI |
| `WHATSAPP_TOKEN` | Token de acceso de la API de WhatsApp Business (Meta) |
| `WEBHOOK_VERIFY_TOKEN` | Token arbitrario para la verificación inicial del webhook por Meta |

## Convenciones TypeScript

- `isolatedModules: true` + `emitDecoratorMetadata: true` activos — las interfaces usadas como tipos de parámetros en métodos decorados deben importarse con `import type` (no `import`)
- `noImplicitAny: false` — se tolera `any` pero se prefiere tipado explícito
- Prettier: comillas simples, trailing comma en todo

## Dónde tocar qué

- **Prompt del bot**: `src/webhook/constants/prompts.ts` — único lugar donde se ajusta el comportamiento de la IA
- **Tipos del payload de Meta**: `src/webhook/types/whatsapp.types.ts` — refleja la estructura real del webhook de WhatsApp Business
- **Lógica de IA y envío**: `src/webhook/webhook.service.ts`
- **Parsing del webhook y routing**: `src/webhook/webhook.controller.ts`
