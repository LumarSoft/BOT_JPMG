import type { OutgoingMessage } from './flow.types';

/**
 * The data a claim needs, asked in ONE message and read back by the model
 * (SiniestroExtractor). Everything about the list lives here: the checklist the
 * customer sees, what counts as complete, the follow-up for what is missing and
 * the description the office receives. The field list is provisional until the
 * office sends the exact data Triunfo needs to file a claim.
 */

export const SENTIDOS = ['norte', 'sur', 'este', 'oeste', 'no_sabe'] as const;
export type Sentido = (typeof SENTIDOS)[number];

export interface SiniestroDatos {
  /** YYYY-MM-DD. Validated by the flow (real date, not in the future). */
  fecha: string | null;
  /** HH:MM, or an approximation as the customer said it ("a la tarde"). */
  hora: string | null;
  localidad: string | null;
  /** Street where it happened, without the number. */
  calle: string | null;
  /** Street number on `calle`. */
  altura: string | null;
  /** Cross street(s) when the customer gave a corner instead of a number. */
  entreCalles: string | null;
  /** The customer said they don't know the street number. */
  alturaDesconocida: boolean | null;
  /** Direction the insured vehicle was driving. */
  sentido: Sentido | null;
  /** How it happened, in the customer's words. */
  relato: string | null;
  /** People in the insured vehicle, driver included. */
  personas: number | null;
  lesionados: boolean | null;
  lesionesDetalle: string | null;
  otroVehiculo: boolean | null;
  terceroPatente: string | null;
  terceroConductor: string | null;
  terceroCompania: string | null;
}

export type SiniestroCampo = keyof SiniestroDatos;

export const SINIESTRO_DATOS_VACIOS: SiniestroDatos = {
  fecha: null,
  hora: null,
  localidad: null,
  calle: null,
  altura: null,
  entreCalles: null,
  alturaDesconocida: null,
  sentido: null,
  relato: null,
  personas: null,
  lesionados: null,
  lesionesDetalle: null,
  otroVehiculo: null,
  terceroPatente: null,
  terceroConductor: null,
  terceroCompania: null,
};

/** Overlays what the latest message added; a null never erases a known value. */
export function mergeDatos(
  prev: SiniestroDatos,
  next: Partial<SiniestroDatos>,
): SiniestroDatos {
  const merged = { ...prev };
  for (const key of Object.keys(SINIESTRO_DATOS_VACIOS) as SiniestroCampo[]) {
    const value = next[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    (merged as Record<SiniestroCampo, unknown>)[key] =
      typeof value === 'string' ? value.trim() : value;
  }
  return merged;
}

// Where a labelled value ends: the next label, a separator or the end.
const TERCERO_STOP =
  '(?=\\s*(?:[,;.\\n]|\\b(?:dni|documento|doc\\.?|seguro|aseguradora|compa[nñ][ií]a|cia\\.?|p[óo]liza|patente|dominio|chapa|conductora?|chofer|tel[ée]fono|cel(?:ular)?)\\b)|\\s*$)';
const TERCERO_CONDUCTOR_RE = new RegExp(
  `\\b(?:conductora?|chofer|quien manejaba|lo manejaba|manejaba)\\b(?:\\s+del?\\s+(?:otro\\s+)?(?:auto|veh[ií]culo|tercero))?\\s*[:\\-]?\\s*(?:es|era|se llama)?\\s*([^,;.\\n]+?)${TERCERO_STOP}`,
  'i',
);
const TERCERO_DNI_RE =
  /\b(?:dni|documento|doc\.?)\s*[:-]?\s*(?:n(?:[°ºu]|ú|umero|úmero)?\.?\s*)?(\d{1,2}[.\s]?\d{3}[.\s]?\d{3}|\d{7,8})\b/i;
const TERCERO_COMPANIA_RE = new RegExp(
  `\\b(?:asegurad[oa]\\s+(?:en|con|por)|aseguradora|compa[nñ][ií]a(?:\\s+de\\s+seguros?)?|cia\\.?|seguro)\\s*[:\\-]?\\s*(?:es|era)?\\s*([^,;.\\n]+?)${TERCERO_STOP}`,
  'i',
);
const TERCERO_POLIZA_RE =
  /\bp[óo]liza\s*[:-]?\s*(?:n(?:[°ºu]|ú|umero|úmero)?\.?\s*)?(\d[\d\s/.-]{3,}\d)/i;
const TERCERO_PATENTE_RE =
  /\b(?:patente|dominio|chapa)\b(?:\s+del?\s+(?:otro\s+)?(?:auto|veh[ií]culo|tercero))?\s*[:-]?\s*(?:es|era)?\s*((?:[a-z]\s?){2,3}\d{3}(?:\s?[a-z]){0,2}|\d{3}(?:\s?[a-z]){3})\b/i;

/**
 * The other vehicle's data written with labels at the confirmation card
 * ("Conductor: Ingaramo Juan Pablo dni: número 27336047", "seguro Victoria
 * seguros póliza 04 3061667"), read without the model: the model left those
 * three messages empty and the claim was never filed (#330). A DNI or policy
 * number alone joins the name or insurer already known.
 */
export function terceroDesdeTexto(
  text: string,
  known: SiniestroDatos = SINIESTRO_DATOS_VACIOS,
): Partial<SiniestroDatos> {
  const t = text.replace(/\s+/g, ' ').trim();
  const out: Partial<SiniestroDatos> = {};
  const conductor = TERCERO_CONDUCTOR_RE.exec(t)?.[1]?.trim();
  const dni = TERCERO_DNI_RE.exec(t)?.[1]?.replace(/[.\s]/g, '');
  if (conductor && /\p{L}/u.test(conductor))
    out.terceroConductor = dni ? `${conductor} (DNI ${dni})` : conductor;
  else if (dni)
    out.terceroConductor = known.terceroConductor
      ? known.terceroConductor.includes(dni)
        ? known.terceroConductor
        : `${known.terceroConductor} (DNI ${dni})`
      : `DNI ${dni}`;
  const compania = TERCERO_COMPANIA_RE.exec(t)?.[1]?.trim();
  const poliza = TERCERO_POLIZA_RE.exec(t)?.[1]?.trim();
  if (compania && /\p{L}/u.test(compania))
    out.terceroCompania = poliza ? `${compania} (póliza ${poliza})` : compania;
  else if (poliza)
    out.terceroCompania = known.terceroCompania
      ? known.terceroCompania.includes(poliza)
        ? known.terceroCompania
        : `${known.terceroCompania} (póliza ${poliza})`
      : `póliza ${poliza}`;
  const patente = TERCERO_PATENTE_RE.exec(t)?.[1];
  if (patente) out.terceroPatente = patente.replace(/[\s-]/g, '').toUpperCase();
  if (Object.keys(out).length) out.otroVehiculo = true;
  return out;
}

/**
 * Whether free text at the confirmation card carries a detail worth keeping
 * even when nothing could be read into a field: a number such as a DNI or a
 * policy, a name (a capital after the first word) or a sentence of six words
 * or more. "ok", "sí" or "los datos del otro vehículo" (an announcement of
 * what comes next) are not.
 */
export function traeDetalles(text: string): boolean {
  const t = text.trim();
  if (/\d{4,}/.test(t)) return true;
  const words = t.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.slice(1).some((w) => /^\p{Lu}/u.test(w))) return true;
  return words.length >= 6;
}

/**
 * Pending items, each with the follow-up line to ask for it. The location is
 * the one people get wrong: a corner ("Pellegrini y Oroño") is not enough, so
 * it asks once for the number on that street; after that (`alturaYaPedida`)
 * whatever reference the customer gave is the place.
 */
export function pendientes(
  d: SiniestroDatos,
  opts: { alturaYaPedida?: boolean } = {},
): Array<{ campo: SiniestroCampo; pregunta: string }> {
  const out: Array<{ campo: SiniestroCampo; pregunta: string }> = [];
  const add = (campo: SiniestroCampo, pregunta: string) =>
    out.push({ campo, pregunta });

  if (!d.fecha) add('fecha', '📅 Fecha del hecho (DD/MM/AAAA, *hoy* o *ayer*)');
  if (!d.hora) add('hora', '🕐 Hora aproximada');
  if (!d.localidad) add('localidad', '📍 Localidad');
  if (!d.calle) {
    add('calle', '🛣️ Calle donde ocurrió y su altura (ej.: San Martín 1250)');
  } else if (!d.altura && !opts.alturaYaPedida) {
    if (d.entreCalles && !d.alturaDesconocida) {
      add(
        'altura',
        `🔢 Altura (número) sobre *${d.calle}*: me dijiste la esquina con ${d.entreCalles}. Si no sabés el número, decime *no sé*`,
      );
    } else if (!d.entreCalles) {
      add(
        'altura',
        `🔢 Altura (número) sobre *${d.calle}*. Si no la sabés, decime entre qué calles fue`,
      );
    }
  }
  if (!d.sentido)
    add('sentido', '🧭 Hacia dónde circulabas: norte, sur, este u oeste');
  if (!d.relato) add('relato', '📝 Cómo ocurrió');
  if (d.personas === null)
    add('personas', '👥 Cuántas personas iban en tu vehículo (contándote)');
  if (d.lesionados === null) add('lesionados', '🚑 Si hubo lesionados (sí/no)');
  else if (d.lesionados && !d.lesionesDetalle)
    add('lesionesDetalle', '🚑 Quiénes resultaron lesionados y cómo');
  if (d.otroVehiculo === null)
    add('otroVehiculo', '🚗 Si hubo otro vehículo involucrado (sí/no)');
  return out;
}

export function siniestroChecklist(): OutgoingMessage {
  return {
    kind: 'text',
    body:
      '📝 Para cargar la denuncia necesito estos datos. *Respondé todo en un solo mensaje* (podés copiar la lista y completarla):\n\n' +
      '1️⃣ Fecha y hora del hecho\n' +
      '2️⃣ Localidad\n' +
      '3️⃣ Calle y altura exacta (ej.: San Martín 1250). Si no sabés la altura, entre qué calles\n' +
      '4️⃣ Hacia dónde circulabas (norte, sur, este u oeste)\n' +
      '5️⃣ Cómo ocurrió\n' +
      '6️⃣ Cuántas personas iban en tu vehículo\n' +
      '7️⃣ ¿Hubo lesionados? ¿Quiénes?\n' +
      '8️⃣ Si hubo otro vehículo: patente, conductor y compañía de seguro\n\n' +
      '_Si no sabés algún dato, decilo y seguimos. Escribí *menú* para volver._',
  };
}

export function siniestroFaltantes(
  faltan: Array<{ pregunta: string }>,
): OutgoingMessage {
  return {
    kind: 'text',
    body:
      `Gracias 🙌. Para completar la denuncia me falta${faltan.length > 1 ? 'n' : ''}:\n\n` +
      faltan.map((f) => `• ${f.pregunta}`).join('\n') +
      '\n\n_Respondé en un solo mensaje._',
  };
}

const SENTIDO_TEXTO: Record<Sentido, string> = {
  norte: 'hacia el norte',
  sur: 'hacia el sur',
  este: 'hacia el este',
  oeste: 'hacia el oeste',
  no_sabe: 'no lo sabe',
};

/** The claim description the office receives (panel + e-mail). */
export function siniestroDescripcion(d: SiniestroDatos): string {
  const lugar =
    `${d.calle ?? ''} ${d.altura ?? 's/n'}`.trim() +
    (d.entreCalles ? ` (esquina / referencia: ${d.entreCalles})` : '');
  const tercero = d.otroVehiculo
    ? `Sí — patente: ${d.terceroPatente ?? 'no informada'}; conductor: ${d.terceroConductor ?? 'no informado'}; compañía: ${d.terceroCompania ?? 'no informada'}`
    : 'No';
  return [
    d.relato ?? '',
    `Hora: ${d.hora ?? ''}`,
    `Localidad: ${d.localidad ?? ''}`,
    `Lugar: ${lugar}`,
    `Sentido de circulación: ${d.sentido ? SENTIDO_TEXTO[d.sentido] : ''}`,
    `Personas en el vehículo: ${d.personas ?? ''}`,
    `Lesionados: ${d.lesionados ? `Sí — ${d.lesionesDetalle ?? ''}` : 'No'}`,
    `Otro vehículo: ${tercero}`,
  ].join('\n');
}

// ─── Pólizas que no son un vehículo (hogar, comercio, vida, otro) ────────────
//
// What the office asks for a home or shop claim (John, 20/10): the kind of
// event (robo, incendio, daños, responsabilidad civil), for damage what got
// damaged (cristales, electrodomésticos, la propiedad), then date, time, the
// address where it happened (even if it is on the policy) and what happened.
// The coverages are optional per policy, so the office checks them by hand.

export const BIEN_TIPOS = [
  'robo',
  'incendio',
  'danios',
  'responsabilidad_civil',
] as const;
export type BienTipo = (typeof BIEN_TIPOS)[number];

export const BIEN_DANIOS = [
  'cristales',
  'electrodomesticos',
  'propiedad',
] as const;
export type BienDanio = (typeof BIEN_DANIOS)[number];

export const BIEN_TIPO_LABEL: Record<BienTipo, string> = {
  robo: 'Robo',
  incendio: 'Incendio',
  danios: 'Daños',
  responsabilidad_civil: 'Responsabilidad civil',
};

export const BIEN_DANIO_LABEL: Record<BienDanio, string> = {
  cristales: 'Daños a cristales',
  electrodomesticos: 'Daños a electrodomésticos',
  propiedad: 'Daños a la propiedad',
};

/** The kind of event, read from what the customer typed instead of tapping. */
export function matchBienTipo(folded: string): BienTipo | null {
  const t = folded.trim();
  if (!t) return null;
  if (/\brobo|\brobar|\brobaron|\bhurto|\bme entraron|\bsustra/.test(t))
    return 'robo';
  // A burnt TV is damage; fire is "incendio", "fuego", "llamas", "se prendió".
  if (/\bincendi|\bfuego\b|\bse (?:me )?prendio|\bllamas\b/.test(t))
    return 'incendio';
  if (/responsabilidad civil|\brc\b|\btercero/.test(t))
    return 'responsabilidad_civil';
  if (
    /\bdan(?:o|io|os|ios)\b|\brompi|\broto|\brajo|\brajad|\bcristal|\bvidrio|\belectro|\bse (?:me )?quemo|\bquemad|\binund|\bgoter|\bfiltrac/.test(
      t,
    )
  )
    return 'danios';
  return null;
}

/** What got damaged, read from text ("se rajó el vidrio", "el lavarropas"). */
export function matchBienDanio(folded: string): BienDanio | null {
  const t = folded.trim();
  if (!t) return null;
  if (/\bcristal|\bvidrio|\bventana|\bespejo|\bmampara|\bvitr/.test(t))
    return 'cristales';
  if (
    /\belectro|\bheladera|\blavarropa|\btelevis|\btv\b|\blcd\b|\bmicroondas|\bhorno\b|\baire\b|\bcomputador|\bnotebook|\bequipo|\bartefacto/.test(
      t,
    )
  )
    return 'electrodomesticos';
  if (
    /\bpropiedad|\bcasa\b|\bdepartamento|\bdepto|\blocal\b|\bpared|\btecho|\bpiso\b|\bpuerta|\bedificio|\binmueble|\bestructura/.test(
      t,
    )
  )
    return 'propiedad';
  return null;
}

export interface BienDatos {
  /** YYYY-MM-DD. Validated by the flow (real date, not in the future). */
  fecha: string | null;
  /** HH:MM, or an approximation as the customer said it. */
  hora: string | null;
  /** Where it happened: street and number, city if given. */
  domicilio: string | null;
  /** What happened, in the customer's words. */
  relato: string | null;
}

export type BienCampo = keyof BienDatos;

export const BIEN_DATOS_VACIOS: BienDatos = {
  fecha: null,
  hora: null,
  domicilio: null,
  relato: null,
};

/** Overlays what the latest message added; a null never erases a known value. */
export function mergeBienDatos(
  prev: BienDatos,
  next: Partial<BienDatos>,
): BienDatos {
  const merged = { ...prev };
  for (const key of Object.keys(BIEN_DATOS_VACIOS) as BienCampo[]) {
    const value = next[key];
    if (value === null || value === undefined) continue;
    if (!value.trim()) continue;
    merged[key] = value.trim();
  }
  return merged;
}

export function pendientesBien(
  d: BienDatos,
): Array<{ campo: BienCampo; pregunta: string }> {
  const out: Array<{ campo: BienCampo; pregunta: string }> = [];
  if (!d.fecha)
    out.push({
      campo: 'fecha',
      pregunta: '📅 Fecha del hecho (DD/MM/AAAA, *hoy* o *ayer*)',
    });
  if (!d.hora) out.push({ campo: 'hora', pregunta: '🕐 Hora aproximada' });
  if (!d.domicilio)
    out.push({
      campo: 'domicilio',
      pregunta: '📍 Domicilio donde ocurrió (calle y número, localidad)',
    });
  if (!d.relato)
    out.push({ campo: 'relato', pregunta: '📝 Qué pasó, con tus palabras' });
  return out;
}

/** The one-message checklist for a home / shop / other non-vehicle claim. */
export function bienChecklist(tipo: string | null): OutgoingMessage {
  return {
    kind: 'text',
    body:
      (tipo ? `Anoté: *${tipo}*.\n\n` : '') +
      '📝 Para cargar la denuncia necesito estos datos. *Respondé todo en un solo mensaje*:\n\n' +
      '1️⃣ Fecha y hora del hecho\n' +
      '2️⃣ Domicilio donde ocurrió (calle y número, localidad), aunque sea el de la póliza\n' +
      '3️⃣ Qué pasó, con tus palabras\n\n' +
      '_Si no sabés algún dato, decilo y seguimos. Escribí *menú* para volver._',
  };
}

/** The claim description the office receives for a non-vehicle policy. */
export function bienDescripcion(tipo: string | null, d: BienDatos): string {
  return [
    ...(tipo ? [`Tipo de siniestro: ${tipo}`] : []),
    d.relato ?? '',
    `Hora: ${d.hora ?? ''}`,
    `Domicilio: ${d.domicilio ?? ''}`,
  ].join('\n');
}

/** "Daños a cristales" / "Robo" / null: what the office sees as the kind. */
export function bienTipoLabel(
  tipo: BienTipo | null | undefined,
  danio: BienDanio | null | undefined,
): string | null {
  if (!tipo) return null;
  if (tipo === 'danios' && danio) return BIEN_DANIO_LABEL[danio];
  return BIEN_TIPO_LABEL[tipo];
}
