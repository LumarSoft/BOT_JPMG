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

/** Messages the bot acts on. Other types (audio, video, …) are ignored. */
export type WhatsAppMessage =
  | WhatsAppTextMessage
  | WhatsAppImageMessage
  | WhatsAppInteractiveMessage;

export interface WhatsAppMetadata {
  display_phone_number: string;
  phone_number_id: string;
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
      };
      field: string;
    }>;
  }>;
}
