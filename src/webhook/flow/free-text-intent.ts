import { fold } from '../text';

export type FreeTextIntent = 'human' | 'art' | 'pagos' | 'documentos';

/** Only explicit requests. Used at entry/menu states, never to parse captured data. */
export function freeTextIntent(text: string): FreeTextIntent | null {
  const t = fold(text).trim();
  if (/\bno (quiero|necesito|deseo)\b/.test(t)) return null;
  if (
    /^(asesor|humano|una persona)([.!?\s]*)$/.test(t) ||
    /\b(hablar|comunicar\w*|contact\w*|pasame|derivame)\b.*\b(con|asesor|humano|representante)\b/.test(
      t,
    )
  )
    return 'human';
  if (/\bart\b|\briesgos? (?:de |del )?trabajo\b/.test(t)) return 'art';
  // Questions about paying for a proposed insurance stay in the quote flow.
  if (
    /\bcotiz|\bpresupuest|\basegurar\b|\bcontratar\b|\bbaja\b|\bcancelar\b|\bcancelacion\b/.test(
      t,
    )
  )
    return null;
  if (
    /\b(cuando|cuanto|como|donde)\b.*\b(pagar|pago|cuotas?)\b|\b(estado de cuenta|mis cuotas|mi deuda|vencimiento de mi cuota)\b/.test(
      t,
    )
  )
    return 'pagos';
  if (
    /\b(mandar\w*|enviar\w*|pasar\w*|pasame|pasas|necesito|quiero)\b.*\b(poliza|certificado|documentacion|documentos)\b/.test(
      t,
    )
  )
    return 'documentos';
  return null;
}
