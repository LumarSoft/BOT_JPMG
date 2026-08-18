/**
 * Webhook payloads that only exist once a number is onboarded through
 * COEXISTENCE — the mode where the business keeps using the WhatsApp Business
 * app on the phone while the Cloud API works on the same number.
 *
 * Three of these are the difference between a bot that behaves and a bot that
 * talks over the staff:
 *
 *  · smb_message_echoes  → an employee replied from the phone. The bot must
 *                          shut up in that conversation.
 *  · history             → up to 180 days of past chats, delivered in chunks
 *                          right after onboarding. Must be absorbed, NEVER
 *                          answered, or the bot replies to messages from January.
 *  · account_update      → the connection dropped (usually: nobody opened the
 *                          app for 13 days). Without this you find out when the
 *                          client calls.
 */

/** A message the business sent from the WhatsApp Business app (not via the API). */
export interface WhatsAppMessageEcho {
  /** The business number. */
  from: string;
  /** The customer this was sent to — this is the waId of the conversation. */
  to: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; caption?: string };
  document?: { id: string; filename?: string; caption?: string };
  audio?: { id: string };
  video?: { id: string; caption?: string };
  sticker?: { id: string };
}

/** One thread inside a history chunk. */
export interface WhatsAppHistoryThread {
  id: string;
  messages?: unknown[];
}

/** A chunk of the historical sync. Phases: 0-1 day, 1-90 days, 90-180 days. */
export interface WhatsAppHistoryChunk {
  metadata?: {
    phase?: string;
    chunk_order?: number;
    progress?: number;
  };
  threads?: WhatsAppHistoryThread[];
}

/** Contact added, edited or removed in the business phone's address book. */
export interface WhatsAppAppStateSyncItem {
  type?: string;
  contact?: {
    full_name?: string;
    first_name?: string;
    phone_number?: string;
  };
  action?: string;
  metadata?: { timestamp?: string };
}

/** Lifecycle notice for the WhatsApp Business Account itself. */
export interface WhatsAppAccountUpdate {
  event?: string;
  phone_number?: string;
  disconnection_info?: {
    disconnect_reason?: string;
    initiated_by?: string;
  };
}
