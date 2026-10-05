import type {
  WhatsAppAccountUpdate,
  WhatsAppAppStateSyncItem,
  WhatsAppHistoryChunk,
  WhatsAppMessageEcho,
} from './coexistence.types';

export interface WhatsAppTextMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text';
  text: { body: string };
}

export interface WhatsAppImageMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'image';
  image: {
    id: string;
    mime_type: string;
    sha256?: string;
    caption?: string;
  };
}

/** A voice note (`voice: true`) or an audio file. */
export interface WhatsAppAudioMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'audio';
  audio: {
    id: string;
    mime_type: string;
    voice?: boolean;
  };
}

/** Reply payload shared by button and list interactive messages. */
export interface WhatsAppInteractiveReply {
  id: string;
  title: string;
  description?: string;
}

/** Sent when the user taps a reply button or picks a row from a list message. */
export interface WhatsAppInteractiveMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'interactive';
  interactive:
    | { type: 'button_reply'; button_reply: WhatsAppInteractiveReply }
    | { type: 'list_reply'; list_reply: WhatsAppInteractiveReply };
}

/** Messages the bot acts on. Other types (video, documents, …) are ignored. */
export type WhatsAppMessage =
  | WhatsAppTextMessage
  | WhatsAppImageMessage
  | WhatsAppAudioMessage
  | WhatsAppInteractiveMessage;

export interface WhatsAppMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

/** Delivery callbacks include pricing category and whether this message is
 * billable. Meta charges per delivered message; conversation ids are not a
 * billing key. The API derives estimated USD cost from the official rate card. */
export interface WhatsAppStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  conversation?: {
    id: string;
    origin?: { type?: string };
    expiration_timestamp?: string;
  };
  pricing?: {
    billable?: boolean;
    pricing_model?: string;
    category?: string;
    type?: string;
  };
}

export interface WhatsAppContact {
  wa_id: string;
  profile?: { name?: string };
}

export interface WhatsAppWebhookBody {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: WhatsAppMetadata;
        messages?: WhatsAppMessage[];
        /** Sender profiles for `messages` (the WhatsApp name the person set). */
        contacts?: WhatsAppContact[];
        statuses?: WhatsAppStatus[];
        // ── Coexistence only (see coexistence.types.ts) ──
        /** Messages an employee sent from the WhatsApp Business app. */
        message_echoes?: WhatsAppMessageEcho[];
        /** Chunks of the 180-day historical sync fired right after onboarding. */
        history?: WhatsAppHistoryChunk[];
        /** Address-book changes on the business phone. */
        /** Meta names the payload array state_sync for this webhook field. */
        state_sync?: WhatsAppAppStateSyncItem[];
        /** WABA lifecycle notices, e.g. PARTNER_REMOVED. */
        event?: string;
        disconnection_info?: WhatsAppAccountUpdate['disconnection_info'];
      };
      /** Which subscription produced this change: "messages", "smb_message_echoes", "history", … */
      field: string;
    }>;
  }>;
}
