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

/**
 * Pending items, each with the follow-up line to ask for it. The location is
 * the one people get wrong: a corner ("Pellegrini y Oroño") is not enough, so
 * it asks for the number on that street and only accepts the corner when the
 * customer says they don't know it.
 */
export function pendientes(
  d: SiniestroDatos,
): Array<{ campo: SiniestroCampo; pregunta: string }> {
  const out: Array<{ campo: SiniestroCampo; pregunta: string }> = [];
  const add = (campo: SiniestroCampo, pregunta: string) =>
    out.push({ campo, pregunta });

  if (!d.fecha) add('fecha', '📅 Fecha del hecho (DD/MM/AAAA, *hoy* o *ayer*)');
  if (!d.hora) add('hora', '🕐 Hora aproximada');
  if (!d.localidad) add('localidad', '📍 Localidad');
  if (!d.calle) {
    add('calle', '🛣️ Calle donde ocurrió y su altura (ej.: San Martín 1250)');
  } else if (!d.altura) {
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
    (d.entreCalles ? ` (esquina / entre ${d.entreCalles})` : '');
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
