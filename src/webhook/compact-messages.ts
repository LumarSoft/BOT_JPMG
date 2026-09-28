import type { OutgoingMessage } from './flow/flow.types';

/** Meta's body limits: plain text 4096, interactive (buttons/list) 1024. */
const TEXT_MAX = 4096;
const INTERACTIVE_BODY_MAX = 1024;

const URL_RE = /https?:\/\//i;

/**
 * Folds a turn's consecutive messages into as few WhatsApp messages as
 * possible. Meta bills every message sent (service messages included since
 * October 2026), and each extra send also adds a network round-trip before the
 * user sees the menu. Typical wins: "¡Hola de nuevo!" + menu, a confirmation +
 * menu, an off-topic notice + menu — each goes from two messages to one.
 *
 * Only a text followed by something merges (an interactive message must stay
 * last, its buttons belong to its own body). A merge is skipped when it would
 * exceed Meta's limits — which would otherwise truncate the text — or when the
 * text carries a link: a link inside an interactive body gets no preview, so a
 * document link stays in its own message.
 */
export function compactMessages(
  messages: OutgoingMessage[],
): OutgoingMessage[] {
  const out: OutgoingMessage[] = [];
  for (const message of messages) {
    const prev = out[out.length - 1];
    if (prev?.kind === 'text') {
      const merged = merge(prev.body, message);
      if (merged) {
        out[out.length - 1] = merged;
        continue;
      }
    }
    out.push(message);
  }
  return out;
}

function merge(text: string, next: OutgoingMessage): OutgoingMessage | null {
  const body = `${text}\n\n${next.body}`;
  if (next.kind === 'text') {
    return body.length <= TEXT_MAX ? { kind: 'text', body } : null;
  }
  if (URL_RE.test(text) || body.length > INTERACTIVE_BODY_MAX) return null;
  return { ...next, body };
}
