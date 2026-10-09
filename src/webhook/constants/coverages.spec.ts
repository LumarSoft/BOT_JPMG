import type { QuoteResult } from '../../api/api.types';
import { renderQuote } from './coverages';

describe('renderQuote', () => {
  it('keeps the same coverage copy and benefits used by the web', () => {
    const quote: QuoteResult = {
      quoteNumber: '123',
      validUntil: '2026-10-17',
      vehicleValue: '3435000.00',
      messages: [],
      coverages: [
        {
          code: 'B1',
          name: 'Todo Total Base',
          tagline: 'Pérdidas totales esenciales',
          benefits: ['Robo total', 'Incendio total'],
          exclusions: ['Destrucción total por accidente'],
          highlighted: false,
          paymentOptions: [
            {
              code: 'DA',
              name: 'Débito Automático',
              premium: 23000,
              installmentValue: 23000,
              installments: 1,
            },
          ],
        },
        {
          code: 'B4',
          name: 'Todo Total Premium',
          tagline: 'Pérdidas totales ampliadas',
          benefits: ['Robo total', 'Incendio total', 'Granizo total'],
          highlighted: true,
          paymentOptions: [
            {
              code: 'DA',
              name: 'Débito Automático',
              premium: 27000,
              installmentValue: 27000,
              installments: 1,
            },
          ],
        },
      ],
    };

    expect(renderQuote(quote).coberturas).toEqual([
      expect.objectContaining({
        codigo: 'B1',
        nombre: 'Todo Total Base',
        descripcion: 'Pérdidas totales esenciales',
        incluye: ['Robo total', 'Incendio total'],
        noIncluye: ['Destrucción total por accidente'],
        recomendada: false,
      }),
      expect.objectContaining({
        codigo: 'B4',
        nombre: 'Todo Total Premium',
        descripcion: 'Pérdidas totales ampliadas',
        incluye: ['Robo total', 'Incendio total', 'Granizo total'],
        // An API without exclusions yields an empty list, never undefined.
        noIncluye: [],
        recomendada: true,
      }),
    ]);
  });

  it('keeps the order the API configured, even when the recommended one costs more', () => {
    const coverage = (code: string, premium: number, highlighted = false) => ({
      code,
      name: code,
      tagline: null,
      benefits: [],
      highlighted,
      paymentOptions: [
        {
          code: 'DA',
          name: 'Débito Automático',
          premium,
          installmentValue: premium,
          installments: 1,
        },
      ],
    });
    const quote = {
      quoteNumber: '1',
      validUntil: null,
      vehicleValue: null,
      messages: [],
      coverages: [
        coverage('C1', 40000, true),
        coverage('A', 15000),
        coverage('B1', 23000),
      ],
    } as unknown as QuoteResult;

    expect(
      renderQuote(quote).coberturas.map((c) => [c.codigo, c.recomendada]),
    ).toEqual([
      ['C1', true],
      ['A', false],
      ['B1', false],
    ]);
  });

  it('shows the sum insured and the card and cash price of each coverage', () => {
    const quote = {
      quoteNumber: '1',
      validUntil: '2026-11-05',
      vehicleValue: '     23900000.00',
      messages: [],
      coverages: [
        {
          code: 'C1',
          name: 'Terceros Completo',
          tagline: null,
          benefits: [],
          highlighted: false,
          paymentOptions: [
            {
              code: '1',
              name: 'Con tarjeta',
              premium: 109654,
              installmentValue: 109654,
              installments: 1,
            },
            {
              code: '9',
              name: 'En efectivo',
              premium: 116072,
              installmentValue: 116072,
              installments: 1,
            },
          ],
        },
      ],
    } as unknown as QuoteResult;

    const rendered = renderQuote(quote);

    expect(rendered.sumaAsegurada).toMatch(/^\$\s?23\.900\.000$/);
    expect(rendered.coberturas[0].conTarjeta).toMatch(/^\$\s?109\.654$/);
    expect(rendered.coberturas[0].enEfectivo).toMatch(/^\$\s?116\.072$/);
  });

  it('does not present a $0 sum insured or a missing price as real', () => {
    const quote = {
      quoteNumber: '1',
      validUntil: null,
      vehicleValue: '0.00',
      messages: [],
      coverages: [
        {
          code: 'A',
          name: 'RC',
          tagline: null,
          benefits: [],
          highlighted: false,
          paymentOptions: [
            {
              code: '1',
              name: 'Con tarjeta',
              premium: 15000,
              installmentValue: 15000,
              installments: 1,
            },
          ],
        },
      ],
    } as unknown as QuoteResult;

    const rendered = renderQuote(quote);

    expect(rendered.sumaAsegurada).toBeNull();
    expect(rendered.coberturas[0].enEfectivo).toBeNull();
  });
});
