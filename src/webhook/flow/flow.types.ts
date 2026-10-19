import type {
  ClientSummary,
  HumanReply,
  PhoneMatch,
} from '../../api/api.types';

/**
 * Conversation steps driven by the state machine. The model interprets
 * identification and claim details and handles LLM_* steps; validation and
 * transactional actions stay in the flow.
 */
export type FlowStep =
  | 'ROOT' // first contact: ¿sos cliente?
  | 'CLIENT_MENU' // main menu for clients
  | 'LEAD_MENU' // main menu for non-clients
  | 'IDENTIFY' // waiting for DNI/patente to identify the client
  | 'SINIESTRO_TYPE' // denuncia nueva vs consultar
  | 'SINIESTRO_POLIZA' // pick the affected policy
  | 'SINIESTRO_DATOS' // checklist answered in one message, read by the model
  | 'SINIESTRO_FECHA' // waiting for the incident date
  | 'SINIESTRO_DESC' // waiting for the description
  | 'SINIESTRO_HORA'
  | 'SINIESTRO_LOCALIDAD'
  | 'SINIESTRO_CALLE'
  | 'SINIESTRO_ALTURA'
  | 'SINIESTRO_CONFIRM' // confirm before creating
  | 'SINIESTRO_FOTO_TARJETA' // waiting for the insured's green-card photo
  | 'SINIESTRO_FOTO_CARNET' // waiting for the insured's driver-license photo
  | 'SINIESTRO_TERCERO' // ask whether a third party was involved
  | 'SINIESTRO_TERCERO_TARJETA' // third party's green-card photo
  | 'SINIESTRO_TERCERO_CARNET' // third party's driver-license photo
  | 'SINIESTRO_FOTO_DANIO' // photos of the incident/damage (multiple, then finish)
  | 'BAJA_POLIZA'
  | 'BAJA_CONFIRM'
  | 'DOC_POLIZA' // pick the policy to get documents from
  | 'DOC_TYPE' // pick which document to send
  | 'CUPON_POLIZA' // pick the policy (or all) whose payment coupons the office sends
  | 'ASESOR_MOTIVO' // waiting for the reason to pass to an advisor
  | 'LEAD_CONTACT' // non-client leaving name/time for a sales rep
  | 'COTIZAR_TIPO' // pick what to quote (auto/moto online vs other risks)
  | 'COT_PLAN' // pick a fixed-price plan (bolso/hogar)
  | 'COT_LEAD_FIELDS' // capturing the product-specific fields (driven by the shared catalog)
  | 'COT_LEAD_NOMBRE' // capturing the contact name for an advisor-contact lead
  | 'COT_LEAD_TELEFONO' // capturing the contact phone, then create the lead
  | 'LLM_COTIZACION' // conversational quote flow (handed to the LLM)
  | 'COT_DOC_DNI_FRENTE' // take-out documents after choosing a coverage: DNI front
  | 'COT_DOC_DNI_DORSO' // DNI back
  | 'COT_DOC_CERO_KM' // "¿es 0 km?" when the quote did not say
  | 'COT_DOC_TARJETA_AZUL' // tarjeta verde o azul (step id kept for chats mid-flow)
  | 'COT_DOC_NO_RODAMIENTO' // 0 km: certificado de no rodamiento
  | 'COT_DOC_FOTOS_VEHICULO' // used: photos of the vehicle, several, ends with "listo"
  | 'COT_DOC_TARJETA_GNC' // with GNC: tarjeta de GNC
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
  /** A person from the office handled this chat in the last days (see
   * OFFICE_THREAD_MS): kept for the session, since the API stops reporting
   * that person's reply once the bot answers. */
  officeThread?: boolean;
  /** Said "No, soy otra persona" to "¿Hablo con Juan?": not asked again this
   * session. It came back on the next step that needed identification. */
  phoneDeclined?: boolean;
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
  | { kind: 'list'; body: string; button: string; rows: ListRow[] }
  /** A PDF already downloaded (a policy document); `body` is its caption, may be empty. */
  | { kind: 'document'; body: string; filename: string; buffer: Buffer };

/** Which LLM sub-flow to run after the deterministic messages, if any. */
export type LLMHandoff = 'cotizacion' | 'faq';

export interface FlowResult {
  messages: OutgoingMessage[];
  handoff?: LLMHandoff;
  /** Office person alerted by this message; the model mentions it in its reply. */
  staffNotified?: string;
  /**
   * The list the customer was answering when the text went to the model: it can
   * pick a row of it for them, and it is shown again under its answer.
   */
  onScreen?: OutgoingMessage;
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
  /** Meta number the chat came through (OpenAI usage is billed per number). */
  phoneNumberId?: string;
  /** False when the number is over its monthly LLM budget. */
  llmEnabled?: boolean;
  /** Recent session messages for contextual interpretation. */
  history?: Array<{ role: string; content: string }>;
  /** When the API stored the message being handled (ISO). */
  inboundAt?: string;
  /** Last thing a person from the office wrote here within 72 h, any session,
   * unless the bot spoke after it. */
  lastHumanReply?: HumanReply | null;
  /** When this number last talked to us before this message (ISO), any session. */
  previousActivityAt?: string | null;
  /** The customer is answering a person from the office, not the bot: that
   * person spoke last (see `answeringAPerson` in closers.ts). */
  answeringPerson?: boolean;
  /** This sender used up the hourly model calls: skip optional model reads. */
  llmRateLimited?: boolean;
  /** Office people customers write to by name ("Mili"): those messages go to the office. */
  staffNames?: string[];
  /** The sender's WhatsApp profile name, when Meta sends it. */
  contactName?: string | null;
  /** Unidentified, but this number is one client's phone: "¿hablo con Juan?". */
  phoneMatch?: PhoneMatch | null;
  /** A person from the office handled this chat in the last days. Set by the
   * flow itself from `lastHumanReply` and the session's state. */
  officeThread?: boolean;
  /** The bot already replied in this session. */
  botSpoke?: boolean;
}
