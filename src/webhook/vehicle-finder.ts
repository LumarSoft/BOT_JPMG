import type { ApiService } from '../api/api.service';
import type {
  InfoAutoBrand,
  InfoAutoGroup,
  InfoAutoModel,
} from '../api/api.types';
import { fold } from './text';

type VehicleType = 'auto' | 'moto';

export interface FindVehicleArgs {
  vehicleType: VehicleType;
  brand: string;
  model: string;
  year?: number;
  version?: string;
}

/** Brands tried when the name isn't an exact match ("chevrolet" → CHEVROLET
 * and CHEVROLET CAM.); an exact match is always used alone. */
const MAX_BRANDS = 2;
/** Model lines searched per brand ("corsa" can match CORSA and CORSA II). */
const MAX_GROUPS = 3;
/** Versions handed to the model. Enough to choose from, small in tokens. */
const MAX_CANDIDATES = 20;
/** Line names listed back when the model name wasn't found. */
const MAX_AVAILABLE = 60;

type FinderApi = Pick<ApiService, 'searchBrands' | 'getGroups' | 'getModels'>;

/** How people say it → how InfoAuto names it. */
const BRAND_ALIASES: Record<string, string> = {
  vw: 'volkswagen',
  volks: 'volkswagen',
  wolkswagen: 'volkswagen',
  chevy: 'chevrolet',
  chevi: 'chevrolet',
  mercedes: 'mercedes benz',
  benz: 'mercedes benz',
  mb: 'mercedes benz',
};

/** Ways people write a version word → how InfoAuto abbreviates it. */
const VERSION_SYNONYMS: Record<string, string> = {
  puertas: 'p',
  puerta: 'p',
  ptas: 'p',
  pts: 'p',
  diesel: 'd',
  automatico: 'at',
  automatica: 'at',
  aut: 'at',
  pack: 'pk',
};

/** Filler that never identifies a version ("el 1.4 *de* 5 puertas"). */
const VERSION_FILLER = new Set(['de', 'el', 'la', 'con', 'y', 'version']);

function tokens(text: string): string[] {
  return fold(text)
    .trim()
    .split(/[^a-z0-9.]+/)
    .filter(Boolean)
    .map((t) => VERSION_SYNONYMS[t] ?? t);
}

function inYears(
  item: { prices_from?: number | null; prices_to?: number | null },
  year: number,
): boolean {
  const from = item.prices_from;
  const to = item.prices_to;
  if (typeof from !== 'number' || typeof to !== 'number') return true;
  return year >= from && year <= to;
}

/** Keeps the items matching `keep`, unless that would leave nothing. */
function narrow<T>(items: T[], keep: (item: T) => boolean): T[] {
  const kept = items.filter(keep);
  return kept.length > 0 ? kept : items;
}

/**
 * How well a model line ("CORSA CLASSIC") matches what the user typed
 * ("corsa classic 1.4"). 0 = no match; higher = better.
 */
function groupScore(group: string, model: string): number {
  const g = fold(group);
  const m = fold(model);
  if (!g || !m) return 0;
  if (g === m) return 100;
  const gt = tokens(g);
  const mt = tokens(m);
  // Every word of the line appears in what the user typed: longer lines win,
  // so "corsa classic" picks CORSA CLASSIC over CORSA.
  if (gt.every((t) => mt.includes(t))) return 50 + gt.length;
  // What the user typed is the start of the line ("cronos" → CRONOS DRIVE).
  if (g.startsWith(m)) return 20;
  if (mt.every((t) => gt.includes(t))) return 10;
  return 0;
}

function pickBrands(brands: InfoAutoBrand[], query: string): InfoAutoBrand[] {
  const q = fold(query);
  const exact = brands.filter((b) => fold(b.name) === q);
  if (exact.length > 0) return exact.slice(0, 1);
  return brands.slice(0, MAX_BRANDS);
}

/**
 * Keeps the versions matching the most words of what the user said ("1.4 GL
 * 5 puertas" → the three "1.4 5 P GL…"), or all of them when nothing matches.
 */
function bestMatches(models: InfoAutoModel[], words: string[]) {
  const wanted = words.filter((w) => !VERSION_FILLER.has(w));
  if (wanted.length === 0) return models;
  const scored = models.map((m) => {
    const dt = tokens(m.description);
    return { m, score: wanted.filter((w) => dt.includes(w)).length };
  });
  const best = Math.max(...scored.map((s) => s.score));
  return best > 0
    ? scored.filter((s) => s.score === best).map((s) => s.m)
    : models;
}

/**
 * Resolves brand → model line → versions in a single tool call, filtered by the
 * model year InfoAuto lists for each version. The step-by-step tools cost one
 * OpenAI round-trip each (and re-send the whole prompt every time); a real
 * Peugeot 308 quote ran out of rounds before reaching the price.
 */
export async function findVehicle(
  api: FinderApi,
  args: FindVehicleArgs,
): Promise<Record<string, unknown>> {
  const { vehicleType, year } = args;
  const brandQuery = BRAND_ALIASES[fold(args.brand).trim()] ?? args.brand;
  const brands = pickBrands(
    await api.searchBrands(vehicleType, brandQuery),
    brandQuery,
  );
  if (brands.length === 0) {
    // Likely a typo ("wolswagen", "renol"): offer the brands that start the
    // same way so the model can ask "¿quisiste decir…?".
    const prefix = fold(args.brand).trim().slice(0, 3);
    const similar =
      prefix.length === 3
        ? (await api.searchBrands(vehicleType, prefix)).slice(0, 10)
        : [];
    return {
      error: `No encontré la marca "${args.brand}" en el catálogo de ${vehicleType === 'moto' ? 'motos' : 'autos'}.`,
      ...(similar.length > 0
        ? { similarBrands: similar.map((b) => b.name) }
        : {}),
    };
  }

  let available: string[] = [];
  for (const brand of brands) {
    const found =
      vehicleType === 'moto'
        ? await findMoto(api, brand, args)
        : await findAuto(api, brand, args);
    if ('available' in found) {
      available = found.available;
      continue;
    }
    if (found.models.length === 0) continue;

    // Words of the model beyond the line name ("gol *trend*", "308 *feline*")
    // narrow the versions, as long as some version still matches.
    const lineWords = new Set(found.lines.flatMap((l) => tokens(l)));
    const extra = tokens(args.model).filter((t) => !lineWords.has(t));
    let models = bestMatches(found.models, extra);
    models = bestMatches(models, args.version ? tokens(args.version) : []);
    let note: string | undefined;
    if (year) {
      const forYear = models.filter((m) => inYears(m, year));
      if (forYear.length > 0) models = forYear;
      else
        note = `Ninguna versión figura para el año ${year}; revisá el año con la persona.`;
    }
    return {
      brand: { id: brand.id, name: brand.name },
      total: models.length,
      versions: models.slice(0, MAX_CANDIDATES).map((m) => ({
        codia: m.codia,
        description: m.description.replace(/\s+/g, ' ').trim(),
        years:
          typeof m.prices_from === 'number' && typeof m.prices_to === 'number'
            ? `${m.prices_from}-${m.prices_to}`
            : undefined,
      })),
      ...(models.length > MAX_CANDIDATES
        ? {
            note: `Hay ${models.length} versiones; pedile un dato que las distinga (motor, puertas, versión).`,
          }
        : {}),
      ...(note ? { note } : {}),
    };
  }

  return {
    brand: { id: brands[0].id, name: brands[0].name },
    error: `No encontré el modelo "${args.model}" en ${brands[0].name}.`,
    ...(available.length > 0 ? { availableModels: available } : {}),
  };
}

async function findAuto(
  api: FinderApi,
  brand: InfoAutoBrand,
  args: FindVehicleArgs,
): Promise<
  { models: InfoAutoModel[]; lines: string[] } | { available: string[] }
> {
  const groups = await api.getGroups('auto', brand.id);
  const scored = groups
    .map((g) => ({ g, score: groupScore(g.name, args.model) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) {
    return {
      available: groups.slice(0, MAX_AVAILABLE).map((g) => g.name),
    };
  }
  const best = scored[0].score;
  let lines: InfoAutoGroup[] = scored
    .filter((s) => s.score === best)
    .map((s) => s.g);
  if (args.year) lines = narrow(lines, (g) => inYears(g, args.year!));
  lines = lines.slice(0, MAX_GROUPS);
  const perLine = await Promise.all(
    lines.map((g) => api.getModels('auto', brand.id, g.id)),
  );
  return { models: perLine.flat(), lines: lines.map((g) => g.name) };
}

async function findMoto(
  api: FinderApi,
  brand: InfoAutoBrand,
  args: FindVehicleArgs,
): Promise<{ models: InfoAutoModel[]; lines: string[] }> {
  // Moto models are listed per brand (the "groups" are displacement ranges the
  // user doesn't know), so search the model name directly.
  const byQuery = await api.getModels('moto', brand.id, undefined, args.model);
  if (byQuery.length > 0) return { models: byQuery, lines: [args.model] };
  const mt = tokens(args.model);
  const all = await api.getModels('moto', brand.id);
  return {
    models: all.filter((m) => {
      const dt = tokens(m.description);
      return mt.some((t) => dt.includes(t));
    }),
    lines: [args.model],
  };
}
