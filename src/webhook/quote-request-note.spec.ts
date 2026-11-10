import { describeQuoteRequest } from './quote-request-note';

describe('describeQuoteRequest', () => {
  it('names the vehicle, year and postal code, and why it was not quoted', () => {
    expect(
      describeQuoteRequest({
        lastRequest: {
          vehicle: 'HONDA WAVE 110S NEW BASE',
          manufactureYear: 2026,
          postalCode: 2152,
        },
      }),
    ).toBe(
      'Lo último que pidió cotizar: HONDA WAVE 110S NEW BASE, año 2026, CP 2152.',
    );
    expect(
      describeQuoteRequest({
        lastRequest: {
          vehicle: 'FIAT PALIO 1.4',
          manufactureYear: 2015,
          postalCode: 2000,
          problem: 'la compañía no lo cotizó online',
        },
      }),
    ).toBe(
      'Lo último que pidió cotizar: FIAT PALIO 1.4, año 2015, CP 2000 (no se pudo: la compañía no lo cotizó online).',
    );
  });

  it('says nothing without a quote request', () => {
    expect(describeQuoteRequest(undefined)).toBeNull();
    expect(describeQuoteRequest({ candidates: [] })).toBeNull();
    expect(
      describeQuoteRequest({
        lastRequest: { vehicle: '', manufactureYear: 2020 },
      }),
    ).toBeNull();
  });
});
