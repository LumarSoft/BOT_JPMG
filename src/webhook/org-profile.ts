import type { ConfigService } from '@nestjs/config';
import type { BotOrgProfile } from '../api/api.types';
import type { TransferInfo } from './flow/flow.messages';
import { TRIUNFO_CLAIMS_PHONE, TRIUNFO_TRANSFER } from './constants/business';

/**
 * What the bot says that changes from one organization to another: how it
 * names the organization, the grúa and claims lines, the account an
 * installment can be transferred to and where cash is paid with the coupon.
 */
export interface OrgProfile {
  /** "John Pellegrini Management Group" — the greeting names the org with it. */
  orgName: string;
  /** "JPMG", shown next to the name when the bot has no name of its own. */
  orgShortName: string | null;
  /** "John Pellegrini Management Group SRL" — what the model says it works for. */
  orgLegalName: string | null;
  /** Null: the bot says the number is being confirmed and offers an advisor. */
  towTruckPhone: string | null;
  claimsPhone: string;
  /** "Rapipago, Pago Fácil o Santa Fe Servicios". */
  cashPaymentPlaces: string;
  /** Null: no account is given, the office passes the data. */
  transfer: TransferInfo | null;
}

/** Where a Triunfo coupon is paid in cash when the organization did not say. */
export const DEFAULT_CASH_PAYMENT_PLACES = 'Rapipago o Pago Fácil';

/**
 * What the bot said before organizations had a profile: JPMG's names, the
 * TOW_TRUCK_PHONE / CLAIMS_PHONE / TRANSFER_* settings and Triunfo's account.
 * Only used when the API sends no profile (an older API, or the default
 * organization before its profile is saved), so JPMG never changes by surprise.
 */
export function legacyOrgProfile(config: ConfigService): OrgProfile {
  const setting = (name: string) =>
    config.get<string>(name)?.trim() || undefined;
  return {
    orgName: 'John Pellegrini Management Group',
    orgShortName: 'JPMG',
    orgLegalName: 'John Pellegrini Management Group SRL',
    towTruckPhone: setting('TOW_TRUCK_PHONE') ?? null,
    claimsPhone: setting('CLAIMS_PHONE') ?? TRIUNFO_CLAIMS_PHONE,
    cashPaymentPlaces: 'Rapipago, Pago Fácil o Santa Fe Servicios',
    transfer: {
      alias: setting('TRANSFER_ALIAS') ?? TRIUNFO_TRANSFER.alias,
      cbu: setting('TRANSFER_CBU') ?? TRIUNFO_TRANSFER.cbu,
      holder: setting('TRANSFER_HOLDER') ?? TRIUNFO_TRANSFER.holder,
      bank: setting('TRANSFER_BANK') ?? TRIUNFO_TRANSFER.bank,
    },
  };
}

/**
 * The organization's profile from GET /bot/context, completed with the
 * insurer's own data where it left a field empty. Nothing of another
 * organization ever fills a gap.
 */
export function resolveOrgProfile(
  profile: BotOrgProfile | null | undefined,
  legacy: OrgProfile,
): OrgProfile {
  if (!profile) return legacy;
  const t = profile.transfer;
  return {
    orgName: profile.orgName,
    orgShortName: profile.orgShortName ?? null,
    orgLegalName: profile.orgLegalName ?? null,
    towTruckPhone: profile.towTruckPhone ?? null,
    claimsPhone: profile.claimsPhone ?? TRIUNFO_CLAIMS_PHONE,
    cashPaymentPlaces: profile.cashPaymentPlaces ?? DEFAULT_CASH_PAYMENT_PLACES,
    transfer:
      t && (t.alias || t.cbu)
        ? {
            alias: t.alias ?? undefined,
            cbu: t.cbu ?? undefined,
            holder: t.holder ?? undefined,
            bank: t.bank ?? undefined,
          }
        : null,
  };
}

/** "John Pellegrini Management Group SRL (JPMG)" — what the model works for. */
export function orgIdentity(org: OrgProfile): string {
  const name = org.orgLegalName ?? org.orgName;
  return org.orgShortName ? `*${name}* (${org.orgShortName})` : `*${name}*`;
}
