import type { OrgProfile } from './org-profile';
import {
  quoteReturnedPrices,
  withQuoteClosingNote,
} from './quote-closing-note';

const org = (quoteClosingNote: string | null): OrgProfile => ({
  orgName: 'Seguros Norte',
  orgShortName: null,
  orgLegalName: null,
  towTruckPhone: null,
  claimsPhone: '0810',
  cashPaymentPlaces: 'Rapipago',
  transfer: null,
  quoteClosingNote,
});

const NOTE =
  'Un asesor seguro te va a poder mejorar el precio con una bonificación';

describe('quoteReturnedPrices', () => {
  const priced = JSON.stringify({
    sumaAsegurada: '$ 5.000.000',
    coberturas: [{ nombre: 'RC', conTarjeta: '$ 10.000 por mes' }],
    avisos: [],
  });

  it('is true only when the company gave prices', () => {
    expect(quoteReturnedPrices(priced)).toBe(true);
    expect(quoteReturnedPrices(JSON.stringify({ coberturas: [] }))).toBe(false);
    expect(quoteReturnedPrices(JSON.stringify({ error: 'Falta el GNC' }))).toBe(
      false,
    );
    expect(
      quoteReturnedPrices(
        JSON.stringify({ coberturas: [{}], sinCotizacion: true }),
      ),
    ).toBe(false);
    expect(
      quoteReturnedPrices(
        JSON.stringify({ coberturas: [{}], cotizacionIncompleta: true }),
      ),
    ).toBe(false);
    expect(quoteReturnedPrices('not json')).toBe(false);
  });
});

describe('withQuoteClosingNote', () => {
  const reply = 'Te paso los precios 🚗\n• RC: $ 10.000 por mes';

  it("adds the organization's line under a quote with prices", () => {
    expect(withQuoteClosingNote(reply, org(NOTE), true)).toBe(
      `${reply}\n\n${NOTE}`,
    );
  });

  it('leaves the reply alone without a line, without prices or when it is already there', () => {
    expect(withQuoteClosingNote(reply, org(null), true)).toBe(reply);
    expect(withQuoteClosingNote(reply, org(NOTE), false)).toBe(reply);
    expect(withQuoteClosingNote(`${reply}\n${NOTE}`, org(NOTE), true)).toBe(
      `${reply}\n${NOTE}`,
    );
    expect(withQuoteClosingNote('', org(NOTE), true)).toBe('');
  });
});
