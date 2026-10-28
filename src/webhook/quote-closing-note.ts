import type { OrgProfile } from './org-profile';

/**
 * Whether a quote_vehicle result gave the customer prices: not an error, not
 * a vehicle the company turned down and not the RC-only quote of a vehicle it
 * could not value (that one already ends with an advisor sending the rest).
 */
export function quoteReturnedPrices(result: string): boolean {
  try {
    const value = JSON.parse(result) as {
      error?: unknown;
      sinCotizacion?: unknown;
      cotizacionIncompleta?: unknown;
      coberturas?: unknown;
    };
    return (
      value.error === undefined &&
      value.sinCotizacion !== true &&
      value.cotizacionIncompleta !== true &&
      Array.isArray(value.coberturas) &&
      value.coberturas.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * The reply with the organization's closing line under it, when this turn
 * gave the customer prices and the organization configured one (some offices
 * close every quote with "Un asesor seguro te va a poder mejorar el precio con
 * una bonificación"). The line is added by code, not by the model, so it reads
 * exactly as the office wrote it.
 */
export function withQuoteClosingNote(
  text: string,
  org: OrgProfile,
  quoted: boolean,
): string {
  const note = org.quoteClosingNote;
  if (!quoted || !note || !text.trim()) return text;
  if (text.includes(note)) return text;
  return `${text.trimEnd()}\n\n${note}`;
}
