import type OpenAI from 'openai';

/**
 * Tools the assistant can call. Every data tool maps 1:1 to a john-api
 * endpoint — see src/api/api.service.ts. Client-scoped tools require a prior
 * successful identify_client call in the same conversation.
 */
export const BOT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'identify_client',
      description:
        'Identifica al cliente por DNI del titular o patente del vehículo y vincula la conversación. Obligatorio antes de consultar pólizas, estado de cuenta, documentos o siniestros.',
      parameters: {
        type: 'object',
        properties: {
          dni: { type: 'string', description: 'DNI del titular, solo números' },
          plate: {
            type: 'string',
            description: 'Patente del vehículo (ej: AB123CD)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_polizas',
      description:
        'Lista las pólizas del cliente identificado: estado, vigencia, cobertura y vehículo. Usar para "qué seguros tengo", vencimientos o para elegir una póliza antes de pedir documentos o denunciar un siniestro.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_estado_cuenta',
      description:
        'Estado de cuenta del cliente identificado: cuotas impagas (pendientes, vencidas o con rechazo de débito) por póliza. Usar para consultas de pagos y cobranzas.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_documentos',
      description:
        'Obtiene los documentos de una póliza (Tarjeta de Circulación, Certificado de Cobertura, Cupón de Pago) con su link de descarga, directo desde Triunfo.',
      parameters: {
        type: 'object',
        properties: {
          polizaId: {
            type: 'integer',
            description: 'ID de la póliza (de get_polizas)',
          },
        },
        required: ['polizaId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_siniestros',
      description:
        'Lista las denuncias de siniestro del cliente identificado con su estado interno de seguimiento (pendiente, en_proceso, resuelto).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_siniestro',
      description:
        'Registra una denuncia de siniestro nueva para una póliza del cliente identificado y notifica al asesor. Pedir antes: póliza, fecha del hecho y descripción de lo ocurrido.',
      parameters: {
        type: 'object',
        properties: {
          polizaId: {
            type: 'integer',
            description: 'ID de la póliza (de get_polizas)',
          },
          tipo: {
            type: 'string',
            description: 'Tipo de siniestro: auto, moto, hogar, robo u otro',
          },
          fecha: {
            type: 'string',
            description: 'Fecha del hecho en formato YYYY-MM-DD',
          },
          descripcion: {
            type: 'string',
            description:
              'Descripción de lo ocurrido (incluir hora y lugar si el cliente los dio)',
          },
        },
        required: ['polizaId', 'tipo', 'fecha', 'descripcion'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_vehicle_brands',
      description:
        'Busca marcas de vehículos en el catálogo InfoAuto por nombre. Primer paso para cotizar.',
      parameters: {
        type: 'object',
        properties: {
          vehicleType: { type: 'string', enum: ['auto', 'moto'] },
          query: {
            type: 'string',
            description: 'Nombre (o parte) de la marca, ej: "fiat"',
          },
        },
        required: ['vehicleType', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vehicle_groups',
      description:
        'Lista los grupos (líneas de modelo, ej: CRONOS, ARGO) de una marca. Segundo paso para cotizar.',
      parameters: {
        type: 'object',
        properties: {
          vehicleType: { type: 'string', enum: ['auto', 'moto'] },
          brandId: {
            type: 'integer',
            description: 'ID de la marca (de search_vehicle_brands)',
          },
        },
        required: ['vehicleType', 'brandId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_vehicle_models',
      description:
        'Lista las versiones de un grupo con su código CODIA. Tercer paso para cotizar: el CODIA elegido es el "model" de quote_vehicle.',
      parameters: {
        type: 'object',
        properties: {
          vehicleType: { type: 'string', enum: ['auto', 'moto'] },
          brandId: { type: 'integer' },
          groupId: {
            type: 'integer',
            description: 'ID del grupo (de get_vehicle_groups)',
          },
          query: {
            type: 'string',
            description: 'Filtro opcional por versión, ej: "1.3 gse"',
          },
        },
        required: ['vehicleType', 'brandId', 'groupId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'quote_vehicle',
      description:
        'Cotiza el seguro del vehículo en Triunfo en tiempo real y devuelve coberturas con precios. Requiere el CODIA del modelo (ya incluye la marca), año de fabricación y código postal.',
      parameters: {
        type: 'object',
        properties: {
          vehicleType: { type: 'string', enum: ['auto', 'moto'] },
          codia: {
            type: 'integer',
            description:
              'CODIA del modelo obtenido de get_vehicle_models. El CODIA ya codifica la marca (codia = marca * 10000 + modelo), por lo que NO hace falta pasar brandId.',
          },
          manufactureYear: {
            type: 'integer',
            description: 'Año de fabricación',
          },
          postalCode: {
            type: 'integer',
            description: 'Código postal de la localidad',
          },
        },
        required: ['vehicleType', 'codia', 'manufactureYear', 'postalCode'],
      },
    },
  },
];

/** Tool names safe to expose during the conversational quote sub-flow. */
const COTIZADOR_TOOL_NAMES = [
  'search_vehicle_brands',
  'get_vehicle_groups',
  'get_vehicle_models',
  'quote_vehicle',
];

/**
 * Subset of tools handed to the LLM during cotización. Client-scoped tools
 * (pólizas, siniestros, documentos, pagos) are intentionally excluded — those
 * flows are driven by the deterministic state machine, never by the model.
 */
export const COTIZADOR_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] =
  BOT_TOOLS.filter(
    (tool) =>
      tool.type === 'function' &&
      COTIZADOR_TOOL_NAMES.includes(tool.function.name),
  );
