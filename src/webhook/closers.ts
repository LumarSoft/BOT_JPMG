import type { ConversationMessage, HumanReply } from '../api/api.types';
import { fold } from './text';

/**
 * Words a customer uses to wrap up a conversation ("gracias", "dale", "ok",
 * "ya está"). A message made only of these (and emojis/punctuation) carries no
 * request the bot could serve.
 */
const CLOSER_WORDS = new Set([
  'gracias',
  'grax',
  'gcs',
  'muchas',
  'muchisimas',
  'mil',
  'ok',
  'okey',
  'oka',
  'okis',
  'dale',
  'listo',
  'listoo',
  'perfecto',
  'genial',
  'buenisimo',
  'barbaro',
  'joya',
  'excelente',
  'espectacular',
  'entendido',
  'ya',
  'esta',
  'bien',
  'igualmente',
  'saludos',
  'chau',
  'adios',
  'bueno',
  'si',
  'no',
  'va',
  'de',
  'acuerdo',
  'nos',
  'vemos',
  'hasta',
  'luego',
  'manana',
  'abrazo',
  'beso',
  'besos',
  'besito',
  'a',
  'un',
  'una',
  'vos',
  'ustedes',
  'usted',
  'por',
  'todo',
  'la',
  'ayuda',
  'atencion',
  'che',
  'genia',
  'genio',
  'crack',
  'capo',
  'capa',
  'total',
  'totales',
  'igual',
  'amable',
  'super',
  'recibido',
  'anotado',
  'quedo',
  'atento',
  'atenta',
  'espero',
  'entonces',
  'buen',
  'finde',
  'dia',
  'tarde',
  'noche',
  'buenas',
  'buenos',
  'tardes',
  'noches',
  'dias',
]);

/** The words that make a line a closing one; the rest only accompany them. */
const CORE_CLOSERS = new Set([
  'gracias',
  'grax',
  'gcs',
  'ok',
  'okey',
  'oka',
  'okis',
  'dale',
  'listo',
  'listoo',
  'perfecto',
  'genial',
  'buenisimo',
  'barbaro',
  'joya',
  'excelente',
  'espectacular',
  'entendido',
  'recibido',
  'anotado',
  'igualmente',
  'saludos',
  'chau',
  'adios',
  'abrazo',
  'beso',
  'besos',
  'besito',
  'si',
  'no',
  'bueno',
  'va',
  'bien',
  'esta',
  'manana',
  'luego',
  'vemos',
  'genia',
  'genio',
  'crack',
  'capo',
  'capa',
]);

/** Up to this many words still reads as a closing line, not a new request. */
const MAX_CLOSER_WORDS = 8;

/** Whether `text` only wraps up the conversation (thanks, ok, bye, emojis). */
export function isCloser(text: string): boolean {
  const words = fold(text)
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // Only emojis/punctuation ("👍", "🙏🙏") is a closer too.
  if (words.length === 0) return text.trim().length > 0;
  if (words.length > MAX_CLOSER_WORDS) return false;
  // Digits ("ok, 30379505") are data for a person, never a plain closer.
  if (words.some((w) => /\d/.test(w))) return false;
  if (!words.some((w) => CORE_CLOSERS.has(w))) return false;
  // "Gracias Mili", "dale Juan": one word we don't know is a name, two is a request.
  const unknown = words.filter((w) => !CLOSER_WORDS.has(w));
  return unknown.length === 0 || (unknown.length === 1 && words.length >= 2);
}

/** Whether the last thing said in this chat came from a person on our side. */
export function lastSpeakerIsHuman(messages: ConversationMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  return last.role === 'agent' || last.source === 'app_echo';
}

/**
 * How long after a person from the office wrote that the customer is still
 * taken to be answering that person, and the bot keeps out of the chat. A
 * session lasts minutes, so "dale, cuando llegue a casa me fijo" an hour later
 * opens a fresh one. Two hours: with half a day (and three days for a
 * follow-up), a chat answered by hand from the app at 14:06 got nothing from
 * the bot for the rest of the day (28/10).
 */
export const HUMAN_FOLLOWUP_MS = 2 * 60 * 60_000;

/**
 * A notice the platform sent on its own (a rechazo, a póliza vencida) is
 * answered the next morning, and that answer is for the office: three days.
 */
export const NOTICE_FOLLOWUP_MS = 72 * 60 * 60_000;

/** The window a reply keeps the customer "answering the office" for. */
export function followUpWindow(reply: HumanReply | null | undefined): number {
  return reply?.kind === 'notice' ? NOTICE_FOLLOWUP_MS : HUMAN_FOLLOWUP_MS;
}

/** Whether a person from the office wrote to this chat within the follow-up window. */
export function recentHumanReply(
  reply: HumanReply | null | undefined,
  now: number = Date.now(),
  windowMs: number = followUpWindow(reply),
): boolean {
  if (!reply) return false;
  const at = Date.parse(reply.createdAt);
  return Number.isFinite(at) && now - at <= windowMs;
}

/**
 * Whether the customer is answering a person from the office rather than the
 * bot: that person spoke last in this session, or — in a session where the bot
 * has not said anything yet — wrote to them in the last hours.
 */
export function answeringAPerson(
  messages: ConversationMessage[],
  lastHumanReply?: HumanReply | null,
  now: number = Date.now(),
): boolean {
  if (lastSpeakerIsHuman(messages)) return true;
  const botSpoke = messages.some(
    (m) => m.role === 'assistant' && m.source !== 'app_echo',
  );
  return !botSpoke && recentHumanReply(lastHumanReply, now);
}

/**
 * The customer is closing a conversation a person had with them. Answering
 * with the welcome menu here is what made the office switch the bot off every
 * morning: a human said goodbye and the bot barged in on the "gracias".
 */
export function closesHumanConversation(
  text: string,
  messages: ConversationMessage[],
  lastHumanReply?: HumanReply | null,
): boolean {
  return isCloser(text) && answeringAPerson(messages, lastHumanReply);
}

/**
 * Another business's automatic reply ("Gracias por comunicarte con X, ¿cómo
 * podemos ayudarte?"). Answering it with the welcome got another automatic
 * reply back, five times in two hours (#118). A customer writing to us does
 * not thank us for contacting them, so the phrase alone is a strong sign;
 * it still needs a second sign of an automatic message.
 */
const THANKS_FOR_CONTACTING_RE =
  /\bgracias por (?:comunicarte|comunicarse|contactarte|contactarse|contactarnos|escribirnos|tu mensaje|su mensaje|tu consulta|su consulta)\b/;
const AUTO_REPLY_SIGN_RE =
  /\b(?:como|en que) (?:te |le )?(?:podemos|puedo) ayudar|\ben (?:breve|instantes|unos minutos)\b|\ba la brevedad\b|\b(?:te|le|les) (?:responderemos|contactaremos|contestaremos)\b|\bnos (?:comunicaremos|contactaremos|pondremos en contacto)\b|\bhorario de atencion\b|\bresponderemos\b/;
const AUTOMATIC_MESSAGE_RE =
  /\b(?:este es un )?mensaje automatico\b|\brespuesta automatica\b|\bauto-?respuesta\b/;

export function isAutoReply(text: string): boolean {
  const t = fold(text);
  if (AUTOMATIC_MESSAGE_RE.test(t)) return true;
  return THANKS_FOR_CONTACTING_RE.test(t) && AUTO_REPLY_SIGN_RE.test(t);
}
