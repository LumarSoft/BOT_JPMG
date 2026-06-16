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

Dos módulos de negocio: `WebhookModule` (recepción/respuesta de WhatsApp + lógica de IA) y `ApiModule` (`ApiService`, único punto de acceso a `john-api`). El `AppModule` registra `ConfigModule` (global) y `WebhookModule`.

El bot **no tiene base de datos propia**: todo estado (conversaciones, mensajes, clientes, pólizas) vive en `john-api`. Los endpoints `/bot/*` se autentican con el header `x-bot-secret` (env `BOT_SECRET`, mismo valor que en `api/.env`). Cotizador e InfoAuto se consumen por los endpoints públicos de la misma API.

**Flujo de un mensaje entrante:**

1. Meta llama a `POST /webhook` con el payload de WhatsApp
2. `WebhookController.receiveMessage` extrae `from`, `text` y `phoneNumberId` del payload anidado de Meta
3. Lanza `WebhookService.handleMessage` en fire-and-forget (`.catch(console.error)`) y responde `{ status: 'ok' }` de inmediato — esto es intencional para evitar reintentos de Meta por timeout
4. `handleMessage` resuelve el tenant (`GET /bot/context/:phoneNumberId` — si el número no está registrado, ignora el mensaje), obtiene/crea la conversación con sus últimos 10 mensajes y persiste el mensaje del usuario
5. `generateReply` corre el loop de tool-calling de OpenAI (máx. 6 rondas): el modelo puede llamar tools de identificación, pólizas, estado de cuenta, documentos, siniestros, catálogo InfoAuto y cotización (ver `src/webhook/constants/tools.ts`); cada tool mapea 1:1 a un método de `ApiService`
6. Persiste la respuesta del asistente, normaliza el número de teléfono y la envía vía `graph.facebook.com/v25.0/{phoneNumberId}/messages`

**Detalle importante — `normalizePhone`:** WhatsApp Argentina reporta números con prefijo `549` (ej. `5491155556666`). La API de envío de Meta requiere `54` sin el `9` intercalado (ej. `541155556666`). La función recorta ese dígito.

## Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `OPENAI_API_KEY` | Clave de la API de OpenAI |
| `WHATSAPP_TOKEN` | Token de acceso de la API de WhatsApp Business (Meta) |
| `WEBHOOK_VERIFY_TOKEN` | Token arbitrario para la verificación inicial del webhook por Meta |
| `API_URL` | URL base de `john-api` (default `http://localhost:3001`) |
| `BOT_SECRET` | Secreto compartido con `john-api` para los endpoints `/bot/*` (mismo valor en `api/.env`) |
| `TOW_TRUCK_PHONE` | Opcional — número de grúa/auxilio que el bot informa en el menú |

## Convenciones TypeScript

- `isolatedModules: true` + `emitDecoratorMetadata: true` activos — las interfaces usadas como tipos de parámetros en métodos decorados deben importarse con `import type` (no `import`)
- `noImplicitAny: false` — se tolera `any` pero se prefiere tipado explícito
- Prettier: comillas simples, trailing comma en todo

## Dónde tocar qué

- **Prompt del bot**: `src/webhook/constants/prompts.ts` (`buildSystemPrompt`) — comportamiento, menús y reglas de la IA; el prefijo de identidad viene de `Producer.systemPrompt` en la API
- **Tools de OpenAI**: `src/webhook/constants/tools.ts` — schemas de las funciones que el modelo puede invocar
- **Cliente de john-api**: `src/api/api.service.ts` + tipos en `src/api/api.types.ts`
- **Tipos del payload de Meta**: `src/webhook/types/whatsapp.types.ts` — refleja la estructura real del webhook de WhatsApp Business
- **Lógica de IA, loop de tools y envío**: `src/webhook/webhook.service.ts`
- **Parsing del webhook y routing**: `src/webhook/webhook.controller.ts`
