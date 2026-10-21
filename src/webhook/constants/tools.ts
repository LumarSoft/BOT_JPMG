import type OpenAI from 'openai';
import { OFFICE_REQUEST_TOOL, OPEN_OPTION_TOOL, PICK_TOOL } from './prompts';

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
        'Identifica al cliente por DNI (o CUIT) del titular o patente del vehículo y vincula la conversación. Obligatorio antes de consultar pólizas, estado de cuenta, documentos o siniestros.',
      parameters: {
        type: 'object',
        properties: {
          dni: {
            type: 'string',
            description:
              'DNI del titular, o CUIT/CUIL si es una empresa; solo números',
          },
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
        'Lista las denuncias de siniestro del cliente identificado con su estado interno de seguimiento (status: pending = pendiente de carga, in_progress = en proceso, resolved = resuelto).',
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
      name: 'request_coverage',
      description:
        'Registra que la persona quiere CONTRATAR una cobertura que ya le cotizaste con quote_vehicle (ej: "me interesa la B1", "quiero la A"). Llamala en cuanto elija una. El sistema anota el pedido para un asesor y le pide a continuación las fotos de la documentación.',
      parameters: {
        type: 'object',
        properties: {
          vehicleType: { type: 'string', enum: ['auto', 'moto'] },
          coverageCode: {
            type: 'string',
            description: 'Código de la cobertura elegida, ej: "B1"',
          },
          coverageName: {
            type: 'string',
            description:
              'Nombre de la cobertura tal como lo devolvió quote_vehicle, ej: "Robo e Incendio Total"',
          },
          price: {
            type: 'string',
            description: 'Precio "desde" tal como lo mostraste, ej: "$ 62.614"',
          },
          vehicle: {
            type: 'string',
            description:
              'Marca, modelo y versión cotizados, ej: "HONDA NAVI 110"',
          },
          manufactureYear: { type: 'integer' },
          postalCode: { type: 'integer' },
          hasGnc: {
            type: 'boolean',
            description: 'Solo autos: si tiene GNC',
          },
          isZeroKm: {
            type: 'boolean',
            description:
              'Si el vehículo es 0 km (nuevo, sin patentar). Mandalo solo si la persona lo dijo o la versión se vende solo 0 km; si no se sabe, omitilo.',
          },
        },
        required: [
          'vehicleType',
          'coverageCode',
          'coverageName',
          'vehicle',
          'manufactureYear',
          'postalCode',
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_vehicle',
      description:
        'Busca el vehículo en el catálogo InfoAuto en UN solo paso: resuelve la marca, la línea del modelo y devuelve las versiones que coinciden (con su CODIA), ya filtradas por año si lo pasás. Es el primer paso para cotizar: usalo apenas tengas marca y modelo. Si no encuentra el modelo, devuelve los modelos disponibles de la marca.',
      parameters: {
        type: 'object',
        properties: {
          vehicleType: { type: 'string', enum: ['auto', 'moto'] },
          brand: {
            type: 'string',
            description: 'Marca tal como la dijo la persona, ej: "chevrolet"',
          },
          model: {
            type: 'string',
            description: 'Modelo o línea, ej: "corsa", "cronos", "wave"',
          },
          year: {
            type: 'integer',
            description: 'Año del vehículo, si ya lo sabés (filtra versiones)',
          },
          version: {
            type: 'string',
            description:
              'Datos de la versión si los dio, ej: "1.4 gl 5p" (opcional)',
          },
        },
        required: ['vehicleType', 'brand', 'model'],
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
        'Lista modelos/versiones con su código CODIA. Para motos alcanza con la marca; para autos también requiere groupId.',
      parameters: {
        type: 'object',
        properties: {
          vehicleType: { type: 'string', enum: ['auto', 'moto'] },
          brandId: { type: 'integer' },
          groupId: {
            type: 'integer',
            description:
              'ID del grupo (obligatorio para autos; no se usa para motos)',
          },
          query: {
            type: 'string',
            description: 'Filtro opcional por versión, ej: "1.3 gse"',
          },
        },
        required: ['vehicleType', 'brandId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'quote_vehicle',
      description:
        'Cotiza el seguro del vehículo en Triunfo en tiempo real y devuelve cada cobertura con código, nombre, descripción, beneficios incluidos y precios. Usar también para responder qué incluye o cuál es la diferencia entre opciones ya cotizadas. Requiere el CODIA del modelo (ya incluye la marca), año de fabricación y código postal.',
      parameters: {
        type: 'object',
        properties: {
          vehicleType: { type: 'string', enum: ['auto', 'moto'] },
          codia: {
            type: 'integer',
            minimum: 10001,
            description:
              'CODIA positivo del modelo obtenido de find_vehicle o get_vehicle_models. El CODIA ya codifica la marca (codia = marca * 10000 + modelo), por lo que NO hace falta pasar brandId. Nunca usar 0.',
          },
          manufactureYear: {
            type: 'integer',
            description: 'Año de fabricación',
          },
          postalCode: {
            type: 'integer',
            description: 'Código postal de la localidad',
          },
          isZeroKm: {
            type: 'boolean',
            description:
              'true si el vehículo es 0 km (nuevo, sin patentar): la persona lo dijo o la versión se vende solo 0 km. La compañía cotiza distinto el 0 km. Si no se sabe, omitilo.',
          },
        },
        required: ['vehicleType', 'codia', 'manufactureYear', 'postalCode'],
      },
    },
  },
];

/**
 * Signals that the customer chose a quoted coverage to take out. Handled by the
 * bot itself (not a data lookup): it records the request in the Solicitudes
 * panel, flags the chat for an advisor and starts asking for the documents.
 */
export const REQUEST_COVERAGE_TOOL = 'request_coverage';

/** Tool names safe to expose during the conversational quote sub-flow. */
const COTIZADOR_TOOL_NAMES = [
  REQUEST_COVERAGE_TOOL,
  'find_vehicle',
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

/** Menu options a model can open for the customer instead of telling them what to tap. */
export const OPENABLE_OPTIONS = [
  'documentacion',
  'cupones',
  'estado_de_cuenta',
  'siniestro',
  'baja',
  'grua',
  'cotizar',
  'cambiar_forma_de_pago',
  'hablar_con_un_asesor',
  'cobertura',
] as const;
export type OpenableOption = (typeof OPENABLE_OPTIONS)[number];

/**
 * Opens a menu option for the customer: the deterministic flow runs it (sends
 * the PDFs, alerts the office for coupons, shows the account status…).
 */
export const OPEN_OPTION_TOOL_DEF: OpenAI.Chat.Completions.ChatCompletionTool =
  {
    type: 'function',
    function: {
      name: OPEN_OPTION_TOOL,
      description:
        'Hace lo que la persona pidió abriendo esa opción del menú: el sistema la atiende en ese momento (manda los papeles en PDF, le avisa a la oficina los cupones, muestra la deuda, arranca la denuncia, etc.).',
      parameters: {
        type: 'object',
        properties: {
          opcion: { type: 'string', enum: [...OPENABLE_OPTIONS] },
        },
        required: ['opcion'],
        additionalProperties: false,
      },
    },
  };

/**
 * Tools of the FAQ model. `pickIds` are the rows of the list the customer had
 * on screen, which it can choose for them.
 */
/** Passes a request only a person can do to the office, with what was asked. */
export const OFFICE_REQUEST_TOOL_DEF: OpenAI.Chat.Completions.ChatCompletionTool =
  {
    type: 'function',
    function: {
      name: OFFICE_REQUEST_TOOL,
      description:
        'Le pasa a la oficina un pedido que solo puede hacer una persona y no es una opción del menú. El sistema crea el aviso y le confirma a la persona.',
      parameters: {
        type: 'object',
        properties: {
          resumen: {
            type: 'string',
            description:
              'Qué pide, en una línea y en tercera persona (ej: "Pide agregar a una persona a la póliza").',
          },
        },
        required: ['resumen'],
        additionalProperties: false,
      },
    },
  };

export function faqActionTools(
  pickIds: string[] = [],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    OPEN_OPTION_TOOL_DEF,
    OFFICE_REQUEST_TOOL_DEF,
  ];
  if (pickIds.length)
    tools.push({
      type: 'function',
      function: {
        name: PICK_TOOL,
        description:
          'Elige por la persona una opción de la lista que tiene en pantalla, cuando lo que escribió la indica.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', enum: pickIds } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    });
  return tools;
}

/** Names of the tools that hand the turn back to the flow. */
export const ACTION_TOOL_NAMES = new Set<string>([
  OPEN_OPTION_TOOL,
  OFFICE_REQUEST_TOOL,
  PICK_TOOL,
]);
