import {
  OFFICE_REQUEST_TOOL,
  OPEN_OPTION_TOOL,
  PICK_TOOL,
} from './constants/prompts';
import { OPENABLE_OPTIONS, type OpenableOption } from './constants/tools';
import { OPT } from './flow/flow.messages';
import type { OutgoingMessage } from './flow/flow.types';

/**
 * What the model asked the flow to do instead of answering in words: tap this
 * option for the customer, with this text as what they wrote.
 */
export interface FlowAction {
  selectionId: string;
  text: string;
}

/** The flow option each openable menu option taps. */
const OPTION_IDS: Record<OpenableOption, string> = {
  documentacion: OPT.documentos,
  cupones: OPT.cupones,
  estado_de_cuenta: OPT.pagos,
  siniestro: OPT.siniestros,
  baja: OPT.bajaPoliza,
  grua: OPT.grua,
  cotizar: OPT.cotizacion,
  cambiar_forma_de_pago: OPT.cambioPago,
  hablar_con_un_asesor: OPT.asesor,
  cobertura: OPT.cobertura,
};

/** Longest customer text quoted in an office request. */
const QUOTE_MAX = 400;

/**
 * Reads an action tool call. Null when its arguments don't make sense (an
 * option that doesn't exist, an id that wasn't on the list), so the model
 * answers in words instead.
 */
export function flowActionOf(
  name: string,
  rawArgs: string,
  text: string,
  pickIds: string[],
): FlowAction | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs || '{}') as Record<string, unknown>;
  } catch {
    return null;
  }
  if (name === OPEN_OPTION_TOOL) {
    const option = args.opcion as OpenableOption;
    if (!OPENABLE_OPTIONS.includes(option)) return null;
    // What they wrote goes along: it names the paper ("la tarjeta verde") or
    // carries the DNI or plate the flow reads.
    return { selectionId: OPTION_IDS[option], text };
  }
  if (name === OFFICE_REQUEST_TOOL) {
    // "Pide X." + ". Escribió" read "Pide X.. Escribió" in the alert.
    const summary =
      typeof args.resumen === 'string'
        ? args.resumen.trim().replace(/[.\s]+$/, '')
        : '';
    const said = text.trim().slice(0, QUOTE_MAX);
    const reason = summary
      ? said
        ? `${summary}. Escribió: "${said}"`
        : summary
      : said;
    return reason ? { selectionId: OPT.pedidoOficina, text: reason } : null;
  }
  if (name === PICK_TOOL) {
    const id = typeof args.id === 'string' ? args.id : '';
    return pickIds.includes(id) ? { selectionId: id, text: '' } : null;
  }
  return null;
}

/** The rows of a list or the buttons of a message. */
function optionsOf(
  message: OutgoingMessage | undefined,
): { id: string; title: string }[] {
  if (message?.kind === 'list')
    return message.rows.map(({ id, title }) => ({ id, title }));
  if (message?.kind === 'buttons')
    return message.buttons.map(({ id, title }) => ({ id, title }));
  return [];
}

/** Ids the model may pick from the list on screen. */
export function optionIds(message: OutgoingMessage | undefined): string[] {
  return optionsOf(message).map((o) => o.id);
}

/** The list on screen, as the FAQ prompt shows it to the model. */
export function describeOnScreen(
  message: OutgoingMessage | undefined,
): { question: string; options: { id: string; title: string }[] } | undefined {
  const options = optionsOf(message);
  if (!message || options.length === 0) return undefined;
  return { question: message.body, options };
}
