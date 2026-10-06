import type { QuoteResult } from '../../api/api.types';

/**
 * Triunfo groups its coverage codes by letter prefix, from basic liability (A)
 * to full coverage (D). These are the same names the web cotizador shows
 * (`front/src/features/cotizador/lib/coverages.ts`), so a client who quotes on
 * WhatsApp and on the site reads the exact same product names — "Cobertura B4"
 * means nothing to anyone outside the company.
 */
const COVERAGE_NAMES: { prefix: string; name: string }[] = [
  { prefix: 'A', name: 'Responsabilidad Civil' },
  { prefix: 'B', name: 'Todo Total' },
  { prefix: 'C', name: 'Terceros Completo' },
  { prefix: 'D', name: 'Todo Riesgo' },
];

export function coverageName(code: string): string {
  const tier = COVERAGE_NAMES.find((t) =>
    code.toUpperCase().startsWith(t.prefix),
  );
  return tier ? tier.name : `Cobertura ${code}`;
}

/** Whole-peso ARS, matching the web cotizador. */
const ars = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  maximumFractionDigits: 0,
});

export function fmtArs(value: number): string {
  return Number.isFinite(value) ? ars.format(value) : String(value);
}

interface RenderedOption {
  forma: string;
  total: string;
  cuotas?: string;
}

export interface RenderedCoverage {
  nombre: string;
  codigo: string;
  descripcion: string | null;
  incluye: string[];
  recomendada: boolean;
  /** Card price (Triunfo payment code 1), null when not quoted. */
  conTarjeta: string | null;
  /** Cash price (Triunfo payment code 9), null when not quoted. */
  enEfectivo: string | null;
  opciones: RenderedOption[];
}

const CARD_PAYMENT_CODE = '1';
const CASH_PAYMENT_CODE = '9';

/**
 * Turns a raw quote into the shape the model should read out: the sum insured,
 * human coverage names and the card and cash prices already written in
 * Argentine pesos, in the order the API configured.
 *
 * Formatting here rather than in the prompt is deliberate. Left to itself the
 * model printed US separators ("$65,976" — which an Argentine reads as sixty-six
 * pesos) and echoed the raw Triunfo codes. Pre-rendered strings leave it nothing
 * to convert, so the numbers on WhatsApp always match the ones on the site.
 */
export function renderQuote(quote: QuoteResult): {
  vigencia: string | null;
  sumaAsegurada: string | null;
  coberturas: RenderedCoverage[];
  avisos: string[];
} {
  const priceFor = (
    c: (typeof quote.coverages)[number],
    code: string,
  ): string | null => {
    const premium = c.paymentOptions.find(
      (o) => o.code.trim() === code,
    )?.premium;
    return premium && premium > 0 ? fmtArs(premium) : null;
  };
  // The value Triunfo insures the vehicle for; it returns 0 when it could not
  // value it, and a $0 sum insured must not be shown as if it were real.
  const value = Number.parseFloat(quote.vehicleValue ?? '');

  // Kept in the order the API returns: the producer's configuration puts the
  // coverages recommended for this vehicle year first, same as on the web.
  const coberturas = quote.coverages.map((c) => ({
    // The API applies the same producer-configured wording used by the web.
    // Keep the prefix fallback only as protection against an older API.
    nombre: c.name?.trim() || coverageName(c.code),
    codigo: c.code,
    descripcion: c.tagline?.trim() || null,
    incluye: Array.isArray(c.benefits) ? c.benefits : [],
    recomendada: c.highlighted === true,
    conTarjeta: priceFor(c, CARD_PAYMENT_CODE),
    enEfectivo: priceFor(c, CASH_PAYMENT_CODE),
    opciones: c.paymentOptions.map((o) => ({
      forma: o.name,
      total: fmtArs(o.premium),
      ...(o.installments > 1
        ? { cuotas: `${o.installments} x ${fmtArs(o.installmentValue)}` }
        : {}),
    })),
  }));

  return {
    vigencia: quote.validUntil,
    sumaAsegurada: value > 0 ? fmtArs(value) : null,
    coberturas,
    avisos: quote.messages,
  };
}
