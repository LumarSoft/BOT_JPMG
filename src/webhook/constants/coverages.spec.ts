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
        recomendada: false,
      }),
      expect.objectContaining({
        codigo: 'B4',
        nombre: 'Todo Total Premium',
        descripcion: 'Pérdidas totales ampliadas',
        incluye: ['Robo total', 'Incendio total', 'Granizo total'],
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
});
