import type {
  EstadoCuentaPoliza,
  PolizaDocumento,
  PolizaSummary,
  SiniestroSummary,
} from '../../api/api.types';
import type { ListRow, OutgoingMessage } from './flow.types';

/**
 * Deterministic copy and menu builders. Every message the bot sends in a
 * transactional flow comes from here, so the wording is always the same and the
 * option ids are stable (the flow.service routes on them).
 */

// ─── Option ids (kept in sync with flow.service routing) ────

export const OPT = {
  // root
  cliente: 'cliente',
  noCliente: 'no_cliente',
  // client menu
  siniestros: 'm_siniestros',
  cotizacion: 'm_cotizacion',
  pagos: 'm_pagos',
  documentos: 'm_documentos',
  grua: 'm_grua',
  asesor: 'm_asesor',
  // lead menu
  leadCotizar: 'l_cotizar',
  leadVendedor: 'l_vendedor',
  leadConsultas: 'l_consultas',
  // cotización categories
  cotAuto: 'cot_auto',
  cotMoto: 'cot_moto',
  cotBici: 'cot_bici',
  cotBolso: 'cot_bolso',
  cotComercio: 'cot_comercio',
  cotHogar: 'cot_hogar',
  cotPersonas: 'cot_personas',
  cotPraxis: 'cot_praxis',
  // siniestro
  sinNueva: 'sin_nueva',
  sinConsultar: 'sin_consultar',
  confirmar: 'confirmar',
  cancelar: 'cancelar',
  // global
  menu: 'menu',
  finalizar: 'finalizar',
} as const;

export const POLIZA_PREFIX = 'pol_';
export const DOC_PREFIX = 'doc_';

// ─── Helpers ────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function fmtMoney(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
}

/** Short, human label for a policy, used in list rows and summaries. */
function polizaLabel(p: PolizaSummary): string {
  const v = p.vehiculo;
  if (v && (v.marca || v.modelo)) {
    return [v.marca, v.modelo].filter(Boolean).join(' ');
  }
  return p.riskType;
}

// ─── Menus ──────────────────────────────────────────────────

/**
 * How the bot introduces itself. Uses the per-producer configured name
 * (Producer.botName) and falls back to a generic identity when none is set.
 */
export function botIntro(botName?: string | null): string {
  const name = botName?.trim();
  return name
    ? `Soy *${name}*, el asistente de *John Pellegrini Management Group*`
    : `Soy *el asistente de John Pellegrini Management Group* (JPMG)`;
}

export function welcomeMenu(
  firstName?: string,
  botName?: string | null,
): OutgoingMessage {
  const hi = firstName ? `¡Hola, ${firstName}! ` : '¡Hola! ';
  return {
    kind: 'buttons',
    body:
      `${hi}${botIntro(botName)} 👋 ` +
      `Estoy para darte una mano. Para arrancar, decime: ¿ya sos cliente nuestro?`,
    buttons: [
      { id: OPT.cliente, title: 'Sí, soy cliente' },
      { id: OPT.noCliente, title: 'Todavía no' },
      { id: OPT.finalizar, title: 'Finalizar' },
    ],
  };
}

/** Goodbye sent when the user ends the chat (global "finalizar" command). */
export function goodbyeText(): string {
  return '¡Gracias por escribirnos! 🙌 Cerramos la conversación por acá. Cuando necesites algo, escribime de nuevo y arrancamos al toque.';
}

export function clientMenu(): OutgoingMessage {
  return {
    kind: 'list',
    body: 'Contame, ¿en qué te doy una mano hoy?',
    button: 'Ver opciones',
    rows: [
      {
        id: OPT.siniestros,
        title: '🛡️ Siniestros',
        description: 'Denunciar o consultar un siniestro',
      },
      {
        id: OPT.cotizacion,
        title: '💰 Cotización',
        description: 'Cotizar un seguro',
      },
      {
        id: OPT.pagos,
        title: '💳 Pagos y cobranzas',
        description: 'Estado de cuenta y cuotas',
      },
      {
        id: OPT.documentos,
        title: '📄 Documentación',
        description: 'Tarjeta, póliza, certificado, cupón',
      },
      {
        id: OPT.grua,
        title: '🆘 Auxilio / Grúa',
        description: 'Número de asistencia',
      },
      {
        id: OPT.asesor,
        title: '👤 Hablar con un asesor',
        description: 'Te contacta un asesor',
      },
    ],
  };
}

export function leadMenu(botName?: string | null): OutgoingMessage {
  return {
    kind: 'buttons',
    body: `¡Gracias por escribirnos! ${botIntro(botName)} 👋 ¿Con qué te puedo ayudar?`,
    buttons: [
      { id: OPT.leadCotizar, title: 'Cotizar un seguro' },
      { id: OPT.leadVendedor, title: 'Que me llamen' },
      { id: OPT.leadConsultas, title: 'Otras consultas' },
    ],
  };
}

/**
 * Quote categories. Auto and moto are quoted online (Triunfo + InfoAuto); the
 * rest are quoted by an advisor — same split as the web (only auto/moto have an
 * instant quote; the other risks are a contact form there too).
 */
export const COTIZAR_ONLINE = new Set<string>([OPT.cotAuto, OPT.cotMoto]);

/** Human label per quote category, used in the advisor hand-off copy. */
export const COTIZAR_LABEL: Record<string, string> = {
  [OPT.cotAuto]: 'Auto',
  [OPT.cotMoto]: 'Moto',
  [OPT.cotBici]: 'Bicicleta',
  [OPT.cotBolso]: 'Bolso protegido',
  [OPT.cotComercio]: 'Comercio e Industria',
  [OPT.cotHogar]: 'Hogar',
  [OPT.cotPersonas]: 'Personas (vida/accidentes/salud)',
  [OPT.cotPraxis]: 'Praxis profesional',
};

export function cotizarMenu(): OutgoingMessage {
  return {
    kind: 'list',
    body: '💰 *Cotización*\n¿Qué querés cotizar?',
    button: 'Ver coberturas',
    rows: [
      {
        id: OPT.cotAuto,
        title: '🚗 Auto',
        description: 'Cotización online al instante',
      },
      {
        id: OPT.cotMoto,
        title: '🏍️ Moto',
        description: 'Cotización online al instante',
      },
      {
        id: OPT.cotBici,
        title: '🚲 Bicicleta',
        description: 'Urbanas, MTB y eléctricas',
      },
      {
        id: OPT.cotBolso,
        title: '👜 Bolso protegido',
        description: 'Robo, hurto y contenido',
      },
      {
        id: OPT.cotComercio,
        title: '🏪 Comercio',
        description: 'Locales, depósitos y plantas',
      },
      {
        id: OPT.cotHogar,
        title: '🏠 Hogar',
        description: 'Edificio y contenido',
      },
      {
        id: OPT.cotPersonas,
        title: '🧑 Personas',
        description: 'Vida, accidentes y salud',
      },
      {
        id: OPT.cotPraxis,
        title: '⚕️ Praxis profesional',
        description: 'RC profesional',
      },
    ],
  };
}

export function siniestroTypeMenu(): OutgoingMessage {
  return {
    kind: 'buttons',
    body: '🛡️ *Siniestros*\n¿Qué necesitás?',
    buttons: [
      { id: OPT.sinNueva, title: 'Denuncia nueva' },
      { id: OPT.sinConsultar, title: 'Consultar una' },
    ],
  };
}

export function polizaPicker(
  polizas: PolizaSummary[],
  body: string,
): OutgoingMessage {
  const rows: ListRow[] = polizas.map((p) => ({
    id: `${POLIZA_PREFIX}${p.id}`,
    title: polizaLabel(p),
    description: `Póliza ${p.certificado}${p.vehiculo?.dominio ? ` · ${p.vehiculo.dominio}` : ''}`,
  }));
  return { kind: 'list', body, button: 'Elegir póliza', rows };
}

export function docPicker(docs: PolizaDocumento[]): OutgoingMessage {
  const rows: ListRow[] = docs.map((d) => ({
    id: `${DOC_PREFIX}${d.codigo}`,
    title: d.nombre,
  }));
  return {
    kind: 'list',
    body: '📄 ¿Qué documento querés que te envíe?',
    button: 'Ver documentos',
    rows,
  };
}

export function siniestroConfirm(
  poliza: PolizaSummary | undefined,
  fecha: string,
  descripcion: string,
): OutgoingMessage {
  const polizaTxt = poliza
    ? `${polizaLabel(poliza)} (Póliza ${poliza.certificado})`
    : 'la póliza seleccionada';
  return {
    kind: 'buttons',
    body:
      `Revisá la denuncia antes de registrarla:\n\n` +
      `• *Póliza:* ${polizaTxt}\n` +
      `• *Fecha del hecho:* ${fecha}\n` +
      `• *Descripción:* ${descripcion}\n\n` +
      `¿Confirmás?`,
    buttons: [
      { id: OPT.confirmar, title: 'Confirmar' },
      { id: OPT.cancelar, title: 'Cancelar' },
    ],
  };
}

// ─── Data formatting (free text) ────────────────────────────

export function formatEstadoCuenta(polizas: EstadoCuentaPoliza[]): string {
  if (polizas.length === 0) {
    return 'No encontré pólizas asociadas a tu cuenta. Si creés que es un error, te derivo con un asesor.';
  }

  const blocks = polizas.map((p) => {
    const head = `*Póliza ${p.certificado}* (${p.riskType})`;
    if (p.cuotasImpagas.length === 0) {
      return `${head}\n✅ Sin cuotas impagas. ${p.cuotasPagas} cuota(s) paga(s).`;
    }
    const cuotas = p.cuotasImpagas
      .map((c) => {
        const tag =
          c.status === 'rejected'
            ? '⛔ rechazo de débito'
            : c.status === 'overdue'
              ? '⚠️ vencida'
              : 'pendiente';
        return `  • Cuota ${c.numeroCuota}: ${fmtMoney(c.amount)} — vence ${fmtDate(c.dueDate)} (${tag})`;
      })
      .join('\n');
    const aviso = p.tieneRechazos
      ? '\n⚠️ Hay un rechazo de débito. Un asesor te va a contactar para regularizarlo.'
      : '';
    return `${head}\n${cuotas}${aviso}`;
  });

  return ['💳 *Estado de cuenta*', ...blocks].join('\n\n');
}

export function formatSiniestros(siniestros: SiniestroSummary[]): string {
  if (siniestros.length === 0) {
    return 'No tenés denuncias de siniestro registradas. Si querés iniciar una, elegí *Denuncia nueva*.';
  }

  const estados: Record<string, string> = {
    pendiente: '🟡 Pendiente de carga en la compañía',
    en_proceso: '🔵 En proceso',
    resuelto: '🟢 Resuelto',
  };

  const blocks = siniestros.map((s) => {
    const estado = estados[s.estado] ?? s.estado;
    const oficial = s.nroSiniestroCompania
      ? `\n  N° oficial Triunfo: ${s.nroSiniestroCompania}`
      : '\n  Aún sin número oficial (en carga).';
    return (
      `• *${s.tipo}* — ${fmtDate(s.fecha)}\n` + `  Estado: ${estado}${oficial}`
    );
  });

  return ['🛡️ *Tus siniestros*', ...blocks].join('\n\n');
}

export function formatDocumento(doc: PolizaDocumento): string {
  return (
    `📄 *${doc.nombre}*\n${doc.url}\n\n` +
    `Podés llevarla en el celular, no es obligatorio tenerla impresa.`
  );
}
