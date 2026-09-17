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
});
