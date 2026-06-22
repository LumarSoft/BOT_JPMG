import type { ClientSummary } from '../../api/api.types';

/**
 * The deterministic conversation steps. The bot is driven by this state
 * machine; the LLM is only reached through the `LLM_*` steps (cotización and
 * free-text questions), never for the critical transactional flows.
 */
export type FlowStep =
  | 'ROOT' // first contact: ¿sos cliente?
  | 'CLIENT_MENU' // main menu for clients
  | 'LEAD_MENU' // main menu for non-clients
  | 'IDENTIFY' // waiting for DNI/patente to identify the client
  | 'SINIESTRO_TYPE' // denuncia nueva vs consultar
  | 'SINIESTRO_POLIZA' // pick the affected policy
  | 'SINIESTRO_FECHA' // waiting for the incident date
  | 'SINIESTRO_DESC' // waiting for the description
  | 'SINIESTRO_CONFIRM' // confirm before creating
  | 'DOC_POLIZA' // pick the policy to get documents from
  | 'DOC_TYPE' // pick which document to send
  | 'ASESOR_MOTIVO' // waiting for the reason to pass to an advisor
  | 'LEAD_CONTACT' // non-client leaving name/time for a sales rep
  | 'COTIZAR_TIPO' // pick what to quote (auto/moto online vs other risks)
  | 'LLM_COTIZACION' // conversational quote flow (handed to the LLM)
  | 'LLM_FAQ'; // free-text questions (handed to the LLM)

export interface FlowState {
  step: FlowStep;
  /** Slots collected during the current flow (polizaId, fecha, descripcion, …). */
  data: Record<string, unknown>;
}

export interface UserInput {
  /** Free text the user typed, trimmed. Empty when it was a pure interactive tap. */
  text: string;
  /** The option id from a button/list reply, when the user tapped a choice. */
  selectionId?: string;
}

export interface ReplyButton {
  id: string;
  title: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

/** A single message the bot will send. Rendered by the meta.service dispatcher. */
export type OutgoingMessage =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; buttons: ReplyButton[] }
  | { kind: 'list'; body: string; button: string; rows: ListRow[] };

/** Which LLM sub-flow to run after the deterministic messages, if any. */
export type LLMHandoff = 'cotizacion' | 'faq';

export interface FlowResult {
  messages: OutgoingMessage[];
  handoff?: LLMHandoff;
}

export interface FlowContext {
  conversationId: number;
  /** Identified client, if the conversation already has one. */
  client: ClientSummary | null;
  /** True when the previous session expired and this is a fresh start. */
  newSession: boolean;
  /** Configurable bot display name (Producer.botName); null → generic fallback. */
  botName: string | null;
}
