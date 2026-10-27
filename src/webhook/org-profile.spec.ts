import type { ConfigService } from '@nestjs/config';
import {
  DEFAULT_CASH_PAYMENT_PLACES,
  legacyOrgProfile,
  orgIdentity,
  resolveOrgProfile,
} from './org-profile';
import { TRIUNFO_CLAIMS_PHONE, TRIUNFO_TRANSFER } from './constants/business';

const config = (env: Record<string, string> = {}) =>
  ({ get: (name: string) => env[name] }) as unknown as ConfigService;

describe('org profile', () => {
  it('keeps what the bot said before profiles existed when the API sends none', () => {
    const legacy = legacyOrgProfile(
      config({ TOW_TRUCK_PHONE: ' 3415690470 ' }),
    );

    expect(resolveOrgProfile(undefined, legacy)).toBe(legacy);
    expect(resolveOrgProfile(null, legacy)).toBe(legacy);
    expect(legacy).toMatchObject({
      orgName: 'John Pellegrini Management Group',
      orgShortName: 'JPMG',
      towTruckPhone: '3415690470',
      claimsPhone: TRIUNFO_CLAIMS_PHONE,
      cashPaymentPlaces: 'Rapipago, Pago Fácil o Santa Fe Servicios',
      transfer: { alias: TRIUNFO_TRANSFER.alias, cbu: TRIUNFO_TRANSFER.cbu },
    });
    expect(orgIdentity(legacy)).toBe(
      '*John Pellegrini Management Group SRL* (JPMG)',
    );
  });

  it("takes an organization's profile as is, completing only the insurer's data", () => {
    const legacy = legacyOrgProfile(config({ TOW_TRUCK_PHONE: '3415690470' }));
    const org = resolveOrgProfile(
      {
        orgName: 'Seguros Norte',
        orgShortName: null,
        orgLegalName: null,
        towTruckPhone: null,
        claimsPhone: null,
        cashPaymentPlaces: null,
        transfer: { alias: null, cbu: null, holder: 'X', bank: null },
      },
      legacy,
    );

    expect(org).toEqual({
      orgName: 'Seguros Norte',
      orgShortName: null,
      orgLegalName: null,
      towTruckPhone: null,
      claimsPhone: TRIUNFO_CLAIMS_PHONE,
      cashPaymentPlaces: DEFAULT_CASH_PAYMENT_PLACES,
      transfer: null,
    });
    expect(orgIdentity(org)).toBe('*Seguros Norte*');
  });

  it('keeps an account given only by CBU', () => {
    const org = resolveOrgProfile(
      {
        orgName: 'Seguros Norte',
        orgShortName: 'SN',
        orgLegalName: 'Seguros Norte SA',
        towTruckPhone: '0800',
        claimsPhone: '0810',
        cashPaymentPlaces: 'Pago Fácil',
        transfer: {
          alias: null,
          cbu: '0170',
          holder: 'Seguros Norte SA',
          bank: null,
        },
      },
      legacyOrgProfile(config()),
    );

    expect(org.transfer).toEqual({
      alias: undefined,
      cbu: '0170',
      holder: 'Seguros Norte SA',
      bank: undefined,
    });
    expect(orgIdentity(org)).toBe('*Seguros Norte SA* (SN)');
  });
});
