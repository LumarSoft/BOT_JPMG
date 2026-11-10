/**
 * The last quote_vehicle call of a chat, whatever it got, kept in the flow
 * state for the office: when the client asked for a person, the alert only
 * said "Venía con la cotización" and the office had to read the chat to learn
 * the vehicle, the year and the place (Pueblo Esther, 9/11).
 */
export interface QuoteRequestNote {
  vehicle: string;
  manufactureYear: number;
  postalCode: number;
  /** Why it was not quoted, when it was not. */
  problem?: string;
}

export function isQuoteRequestNote(value: unknown): value is QuoteRequestNote {
  if (!value || typeof value !== 'object') return false;
  const note = value as Partial<QuoteRequestNote>;
  return (
    typeof note.vehicle === 'string' &&
    note.vehicle.trim().length > 0 &&
    Number.isInteger(note.manufactureYear) &&
    Number.isInteger(note.postalCode) &&
    (note.problem === undefined || typeof note.problem === 'string')
  );
}

/**
 * "Lo último que pidió cotizar: HONDA WAVE 110S NEW BASE, año 2026, CP 2152."
 * for the advisor alert, from the quote memory saved in the flow state; null
 * when no quote was asked for.
 */
export function describeQuoteRequest(quoteMemory: unknown): string | null {
  const note =
    quoteMemory && typeof quoteMemory === 'object'
      ? (quoteMemory as { lastRequest?: unknown }).lastRequest
      : undefined;
  if (!isQuoteRequestNote(note)) return null;
  const asked = `${note.vehicle.trim()}, año ${note.manufactureYear}, CP ${note.postalCode}`;
  const problem = note.problem?.trim().replace(/[.\s]+$/, '');
  return problem
    ? `Lo último que pidió cotizar: ${asked} (no se pudo: ${problem}).`
    : `Lo último que pidió cotizar: ${asked}.`;
}
