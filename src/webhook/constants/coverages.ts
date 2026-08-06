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
  desde: string;
  opciones: RenderedOption[];
}

/**
 * Turns a raw quote into the shape the model should read out: human coverage
 * names and prices already written in Argentine pesos, cheapest first.
 *
 * Formatting here rather than in the prompt is deliberate. Left to itself the
 * model printed US separators ("$65,976" — which an Argentine reads as sixty-six
 * pesos) and echoed the raw Triunfo codes. Pre-rendered strings leave it nothing
 * to convert, so the numbers on WhatsApp always match the ones on the site.
 */
export function renderQuote(quote: QuoteResult): {
  vigencia: string | null;
  valorVehiculo: string | null;
  coberturas: RenderedCoverage[];
  avisos: string[];
} {
  const cheapest = (c: (typeof quote.coverages)[number]): number => {
    const premiums = c.paymentOptions
      .map((o) => o.premium)
      .filter((p) => p > 0);
    return premiums.length > 0
      ? Math.min(...premiums)
      : Number.MAX_SAFE_INTEGER;
  };

  const coberturas = [...quote.coverages]
    .sort((a, b) => cheapest(a) - cheapest(b))
    .map((c) => ({
      nombre: coverageName(c.code),
      codigo: c.code,
      desde: fmtArs(cheapest(c)),
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
    valorVehiculo: quote.vehicleValue,
    coberturas,
    avisos: quote.messages,
  };
}
