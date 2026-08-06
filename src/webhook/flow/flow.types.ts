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
  | 'SINIESTRO_FOTO_TARJETA' // waiting for the insured's green-card photo
  | 'SINIESTRO_FOTO_CARNET' // waiting for the insured's driver-license photo
  | 'SINIESTRO_TERCERO' // ask whether a third party was involved
  | 'SINIESTRO_TERCERO_TARJETA' // third party's green-card photo
  | 'SINIESTRO_TERCERO_CARNET' // third party's driver-license photo
  | 'SINIESTRO_FOTO_DANIO' // photos of the incident/damage (multiple, then finish)
  | 'DOC_POLIZA' // pick the policy to get documents from
  | 'DOC_TYPE' // pick which document to send
  | 'ASESOR_MOTIVO' // waiting for the reason to pass to an advisor
  | 'LEAD_CONTACT' // non-client leaving name/time for a sales rep
  | 'COTIZAR_TIPO' // pick what to quote (auto/moto online vs other risks)
  | 'COT_PLAN' // pick a fixed-price plan (bolso/hogar)
  | 'COT_LEAD_FIELDS' // capturing the product-specific fields (driven by the shared catalog)
  | 'COT_LEAD_NOMBRE' // capturing the contact name for an advisor-contact lead
  | 'COT_LEAD_TELEFONO' // capturing the contact phone, then create the lead
  | 'LLM_COTIZACION' // conversational quote flow (handed to the LLM)
  | 'LLM_FAQ'; // free-text questions (handed to the LLM)

export interface FlowState {
  step: FlowStep;
  /** Slots collected during the current flow (polizaId, fecha, descripcion, …). */
  data: Record<string, unknown>;
  /** Which branch the user declared themselves into ('client' after "Sí, soy
   * cliente", 'lead' after "Todavía no"). Persisted and carried across steps so
   * the bot never re-asks "¿sos cliente?" on a menu return or a flow switch once
   * the user already answered. Independent of DB identification (clientId). */
  audience?: 'client' | 'lead';
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

/**
 * What `FlowService.handle` returns: the messages/handoff plus the resulting
 * state to persist. `state` is null when the flow ended (finalizar) or was
 * cleared, telling the caller to wipe the stored snapshot.
 */
export interface FlowHandleResult extends FlowResult {
  state: FlowState | null;
}

export interface FlowContext {
  conversationId: number;
  /** Identified client, if the conversation already has one. */
  client: ClientSummary | null;
  /** True when the previous session expired and this is a fresh start. */
  newSession: boolean;
  /** Durable flow snapshot loaded from the API, used to rehydrate the state
   * machine so a restart doesn't lose the user's place. Null/undefined → cold start. */
  flowState?: FlowState | null;
  /** Configurable bot display name (Producer.botName); null → generic fallback. */
  botName: string | null;
  /** General attention window (Producer.attentionHours); null → app default. */
  attentionHours: string | null;
}
