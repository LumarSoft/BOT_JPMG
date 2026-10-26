// Full-flow scenarios (npm run test:flows). Synthetic data only (data/seed.sql):
// DNI 99000001 Ana (1 auto, al día, phone → waId 5493419990001), 99000002 Lucas
// (auto plan de pago + moto con débito en proceso, waId 5493419990002), CUIT
// 30712345671 empresa (2 camiones), 99000004 Marta (débito rechazado), 99000006
// Gustavo (1 auto, waId 5493419990006), 99000008 Jorge (no policies, waId
// 5493419990008, says he is someone else), 99000009 Carla (hogar + comercio, sin
// vehículo, waId 5493419990009), 99000010 Mariela (1 auto con cupón, waId
// 5493419990010, chat atendido por la oficina hace 3 h), 99000011 Fabián (auto +
// moto con cupón, waId 5493419990011), 99000012 Rocío (dos pólizas con débito
// rechazado), 99000013 Silvia (1 auto con cupón, waId 5493419990013), 99000014
// Hernán (sin pólizas, waId 5493419990014), and chats the office answered by hand: 5493419990120 (3 h),
// 5493419990122 (20 h), 5493419990123 (60 h), 5493419990124 (24 h) and
// 5493419990121 with the bot paused.
//
// Each scenario: `steps` are what the customer (or the office, `echo`) sends;
// `expect` checks what the bot answered to that step (`any`/`none` regexes,
// `silent`, `count`, `reply`); `db` checks the database afterwards ($WA is the
// scenario's number). `drive` answers a model-led quote until `until` shows up.
// `docs` counts the PDFs sent in that step. `regression` names the real chat a case comes from; `known` marks a gap not
// fixed yet (reported, but it does not fail the run). `stage: 'inactivity'`
// scenarios are checked again once the local session timeout (2 min) passes:
// `afterIdle.goodbye` says whether the inactivity goodbye must go out.

const ident = (dni) => [
  { text: 'Hola', expect: { any: [/ya sos cliente/i] } },
  { select: 'cliente', title: 'Sí, soy cliente', expect: { any: [/DNI/] } },
  { text: dni, expect: { any: [/te identifiqué/i] } },
];
const handoffs = (name, test) => ({
  name,
  sql: "SELECT REPLACE(REPLACE(n.body,'\\n',' '),'\\t',' ') FROM Notification n JOIN Conversation c ON c.id=n.refId WHERE c.waId='$WA' AND n.type='handoff' AND n.deletedAt IS NULL ORDER BY n.id",
  test,
});
const noMenuWord = /escrib[ií]\s*\*?men[uú]\*?\s*y\s*eleg/i;
// What the bot must never say (15–19/10): a phrase to type or a promise of
// something only text can't do.
const promise = /escrib[ií](?:me)?\s*\*?[“"'‘]|te (?:lo |la |los |las )?env[ií]o\b|el sistema te va a|se env[ií]a autom[aá]ticamente|la oficina te va a (?:enviar|mandar)/i;

// One number per scenario, all under the 5493419990 prefix the cleanup removes.
let n = 0;
const wa = () => `54934199902${String(n++).padStart(2, '0')}`;
let rn = 0;
const rwa = () => `54934199903${String(rn++).padStart(2, '0')}`;
// Answers a model-led quote: GNC button, first (or `pick`) version of a list, postal code, or the vehicle again.
const quoteAnswer = (vehicle, gnc = false, pick = '1') => (prev) =>
  /\|gnc_no\]/.test(prev) ? (gnc ? { select: 'gnc_si', title: 'Sí, tiene GNC' } : { select: 'gnc_no', title: 'No tiene GNC' })
    : /(^|\n)\s*\*?1[.)]/.test(prev) ? { text: pick }
      : /•[^\n]*puertas/.test(prev) ? { text: '5 puertas Trendline' }
      : /c[oó]digo postal|localidad/i.test(prev) ? { text: '2000' }
        : { text: vehicle };

module.exports = [
  // ─── Primer mensaje e identificación ─────────────────────────────
  {
    id: 'P01', area: 'Primer mensaje e identificación', name: 'Saludo → ¿sos cliente? → DNI → menú', wa: wa(),
    steps: [
      { text: 'Hola buen día', expect: { any: [/NICO/, /ya sos cliente/i] } },
      { select: 'cliente', title: 'Sí, soy cliente', expect: { any: [/DNI del titular/] } },
      { text: '99.000.001', expect: { any: [/te identifiqué/i, /m_siniestros/, /m_pagos/] } },
    ],
  },
  {
    id: 'P02', area: 'Primer mensaje e identificación', name: 'Empresa se identifica con CUIT', wa: wa(),
    steps: [
      { text: 'Hola' },
      { select: 'cliente', title: 'Sí, soy cliente' },
      { text: '30-71234567-1', expect: { any: [/te identifiqué/i], none: [/TRANSPORTES PRUEBA SRL/] } },
    ],
  },
  {
    id: 'P03', area: 'Primer mensaje e identificación', name: 'Identificación por patente', wa: wa(),
    steps: [
      { text: 'Hola' },
      { select: 'cliente', title: 'Sí, soy cliente' },
      { text: 'ZZ902AA', expect: { any: [/te identifiqué/i] } },
    ],
  },
  {
    id: 'P04', area: 'Primer mensaje e identificación', name: 'DNI que no existe', wa: wa(),
    steps: [
      { text: 'Hola' },
      { select: 'cliente', title: 'Sí, soy cliente' },
      { text: '12345678', expect: { any: [/No encontré/i], none: [/te identifiqué/i] } },
    ],
  },
  {
    id: 'P05', area: 'Primer mensaje e identificación', name: 'Primer mensaje con pedido y DNI: no vuelve a pedir el DNI', wa: wa(), regression: '#168 (13/10)',
    steps: [
      { text: 'Hola quiero dar de baja la póliza del auto que vendí, mi dni es 99000001', expect: { any: [/te identifiqué/i, /baja/i], none: [/Pasame el \*DNI/] } },
    ],
  },
  {
    id: 'P06', area: 'Primer mensaje e identificación', name: '"Me chocaron" → DNI → directo a la denuncia', wa: wa(),
    steps: [
      { text: 'Hola, me chocaron recién estacionado', expect: { any: [/DNI/], none: [/ya sos cliente/i] } },
      { text: '99000001', expect: { any: [/te identifiqué/i, /Para cargar la denuncia/i], none: [/Denuncia nueva\|/] } },
    ],
  },
  {
    id: 'P07', area: 'Primer mensaje e identificación', name: 'Número conocido: ¿Hablo con Ana? → Sí', wa: '5493419990001',
    steps: [
      { text: 'Hola', expect: { any: [/Hablo con \*Ana\*/] } },
      { select: 'id_phone_si', title: 'Sí, soy Ana', expect: { any: [/te identifiqué/i, /m_pagos/] } },
    ],
  },
  {
    id: 'P08', area: 'Primer mensaje e identificación', name: 'Número conocido: "No, soy otra persona"', wa: '5493419990002',
    steps: [
      { text: 'Buenas tardes', expect: { any: [/Hablo con \*Lucas\*/] } },
      { select: 'id_phone_no', title: 'No, soy otra persona', expect: { any: [/ya sos cliente/i], none: [/te identifiqué/i] } },
    ],
  },
  {
    id: 'P09', area: 'Primer mensaje e identificación', name: 'Escribe un pedido en vez de responder "¿Hablo con…?"', wa: '5493419990006', regression: '#195 (14/10)',
    steps: [
      { text: 'Hola buenas tardes', expect: { any: [/Hablo con \*Gustavo\*/] } },
      { text: 'Me podrías enviar la cuponera de pagos', expect: { any: [/Gustavo/], none: [/DNI/] } },
      { select: 'id_phone_si', title: 'Sí, soy Gustavo', expect: { any: [/cupones/i, /oficina/i] } },
    ],
    db: [handoffs('aviso de cupones', (r) => r.some(([b]) => /cupones/i.test(b)))],
  },
  {
    id: 'P10', area: 'Primer mensaje e identificación', name: '"No, gracias" no es "no soy cliente"', wa: wa(), regression: 'revisión 14/10',
    steps: [
      { text: 'Hola' },
      { text: 'No, gracias', expect: { none: [/Cotizar un seguro/] } },
    ],
  },
  {
    id: 'P11', area: 'Primer mensaje e identificación', name: 'Tema ajeno al seguro', wa: wa(),
    steps: [
      { text: 'Hola' },
      { text: '¿Me pasás una receta de pizza casera?', expect: { any: [/seguro/i], none: [/harina|levadura|muzzarella/i] } },
    ],
  },
  {
    id: 'P12', area: 'Primer mensaje e identificación', name: 'Pregunta por el horario', wa: wa(),
    steps: [
      { text: 'Hola' },
      { text: '¿Hasta qué hora atienden?', expect: { any: [/8/, /16/] } },
    ],
  },
  {
    id: 'P13', area: 'Primer mensaje e identificación', name: 'Finalizar la charla', wa: wa(),
    steps: [
      { text: 'Hola' },
      { select: 'finalizar', title: 'Finalizar', expect: { any: [/Cerramos la conversación/] } },
    ],
  },
  {
    id: 'P14', area: 'Primer mensaje e identificación', name: 'Mensaje para Mili: avisa y sigue atendiendo', wa: wa(), regression: 'revisión 12/10',
    steps: [
      { text: 'Hola Mili, ¿cómo estás?', expect: { any: [/Ya le avisé a Mili/] } },
    ],
    db: [handoffs('aviso para Mili', (r) => r.some(([b]) => /Mensaje para Mili/.test(b)))],
  },
  {
    id: 'P15', area: 'Primer mensaje e identificación', name: 'Pólizas que el bot no ve (nómina) → oficina', wa: wa(), regression: '#111 (14/10)',
    steps: [
      ...ident('99000001'),
      { text: 'Necesito las pólizas de los choferes que tengo en nómina', expect: { any: [/oficina/i], none: [/ONIX/] } },
    ],
    db: [handoffs('aviso de nómina', (r) => r.some(([b]) => /nómina/i.test(b)))],
  },

  // ─── Menú de clientes ───────────────────────────────────────────
  {
    id: 'M01', area: 'Menú de clientes', name: 'Siniestros → consultar (sin denuncias)', wa: wa(),
    steps: [
      ...ident('99000002'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true, expect: { any: [/sin_nueva/, /sin_consultar/] } },
      { select: 'sin_consultar', title: 'Consultar una', expect: { any: [/No veo denuncias hechas por este chat/, /m_asesor/] } },
    ],
  },
  {
    id: 'M02', area: 'Menú de clientes', name: 'Estado de cuenta: débito en proceso, no "vencida"', wa: wa(), regression: '#140 (14/10)',
    steps: [
      ...ident('99000002'),
      { select: 'm_pagos', title: '💳 Pagos y cobranzas', list: true, expect: { any: [/en proceso de débito/, /dejá el dinero disponible/, /m_cupones/], none: [/vencida/] } },
    ],
  },
  {
    id: 'M03', area: 'Menú de clientes', name: '"¿Por qué no se debitó?" responde por forma de pago', wa: wa(), regression: '#184 (14/10)',
    steps: [
      ...ident('99000002'),
      { text: 'Quería saber por qué no se debitó la cuota del seguro', expect: { any: [/Sobre el débito/, /cupón/i] } },
    ],
  },
  {
    id: 'M04', area: 'Menú de clientes', name: 'Rechazo de débito: avisa a la oficina', wa: wa(), regression: 'revisión 14/10',
    steps: [
      ...ident('99000004'),
      { select: 'm_pagos', title: '💳 Pagos y cobranzas', list: true, expect: { any: [/rechazo de débito/i, /Ya le avisé a la oficina/] } },
    ],
    db: [handoffs('aviso de rechazo', (r) => r.some(([b]) => /Rechazo de débito/.test(b)))],
  },
  {
    id: 'M05', area: 'Menú de clientes', name: 'Cupones con varias pólizas: manda la que Triunfo tiene, la otra a la oficina, sin repetir el pedido', wa: wa(), regression: 'revisión 12/10 (cupones en bucle)',
    steps: [
      ...ident('99000002'),
      { text: 'Necesito el cupón de pago', expect: { any: [/pol_todas/, /pol_otra/] } },
      { select: 'pol_todas', title: 'Todas mis pólizas', list: true, expect: { any: [/\[documento Cuponera de pago - ZZ902AA\.pdf\]/, /Ahí te mandé la cuponera de pago de tu FIAT PALIO/, /Ya les pasé tu pedido para tu HONDA STORM/] } },
      { text: 'me mandás el cupón?', expect: { any: [/Ya le pasé/] } },
    ],
    db: [handoffs('un solo aviso de cupones', (r) => r.filter(([b]) => /cupones/i.test(b)).length === 1)],
  },
  {
    id: 'M06', area: 'Menú de clientes', name: 'Documentación con una sola póliza: lista de papeles y "Todos" los manda en PDF', wa: wa(),
    steps: [
      ...ident('99000001'),
      { select: 'm_documentos', title: '📄 Documentación', list: true, expect: { any: [/ONIX/, /Tarjeta verde \(Mercosur\)\|doc_1050/, /doc_todos/], none: [/pol_\d+/, /No tengo los documentos/] } },
      { select: 'doc_todos', title: 'Todos los documentos', list: true, expect: { any: [/\[documento Tarjeta verde \(Mercosur\) - ZZ901AA\.pdf\]/, /\[documento Cláusulas - ZZ901AA\.pdf\]/, /Ahí te mandé/], none: [/No pude bajar/] } },
    ],
    db: [handoffs('sin aviso a la oficina', (r) => r.length === 0)],
  },
  {
    id: 'M06b', area: 'Menú de clientes', name: 'Pide la tarjeta verde antes de identificarse: la manda sin lista', wa: wa(),
    steps: [
      { text: 'Hola, me mandás la tarjeta verde del auto?', expect: { any: [/DNI/] } },
      { text: '99000001', expect: { any: [/\[documento Tarjeta verde \(Mercosur\) - ZZ901AA\.pdf\]/, /Ahí te mandé \*Tarjeta verde/], none: [/doc_todos/, /Certificado de cobertura - /] } },
    ],
    db: [handoffs('sin aviso a la oficina', (r) => r.length === 0)],
  },
  {
    id: 'M06c', area: 'Menú de clientes', name: '"La constancia de pago" manda el PDF, no el estado de cuenta', wa: wa(),
    steps: [
      ...ident('99000001'),
      { text: 'necesito la constancia de pago', expect: { any: [/\[documento Constancia de pago - ZZ901AA\.pdf\]/], none: [/Estado de cuenta/] } },
    ],
  },
  {
    id: 'M06d', area: 'Menú de clientes', name: 'Documentación de una póliza que Triunfo no tiene: a la oficina', wa: wa(),
    steps: [
      ...ident('99000004'),
      { select: 'm_documentos', title: '📄 Documentación', list: true, expect: { any: [/SANDERO/, /No tengo los documentos/] } },
    ],
    db: [handoffs('aviso de documentación', (r) => r.some(([b]) => /documentación/i.test(b)))],
  },
  {
    id: 'M07', area: 'Menú de clientes', name: 'Documentación de "Otra póliza" (empresa)', wa: wa(),
    steps: [
      ...ident('30712345671'),
      { select: 'm_documentos', title: '📄 Documentación', list: true, expect: { any: [/pol_otra/] } },
      { select: 'pol_otra', title: 'Otra póliza', list: true, expect: { any: [/Contame cuál es/] } },
      { text: 'La de accidentes personales de los choferes', expect: { any: [/tomé nota/i] } },
    ],
    db: [handoffs('aviso dice que es documentación de otra póliza', (r) => r.some(([b]) => /Pide la documentación de otra póliza/.test(b)))],
  },
  {
    id: 'M08', area: 'Menú de clientes', name: 'Baja con una sola póliza: confirma y registra', wa: wa(),
    steps: [
      ...ident('99000001'),
      { select: 'm_baja_poliza', title: 'Baja de póliza', list: true, expect: { any: [/Solicitar baja/, /Es otra póliza/] } },
      // Since 21/10 the office wants the motive before the request goes out.
      { select: 'confirmar', title: 'Solicitar baja', expect: { any: [/motivo/i, /bm_venta/] } },
      { select: 'bm_venta', title: 'Vendí el vehículo', list: true, expect: { any: [/todavía no fue dada de baja/, /Vendí el vehículo/, /m_siniestros/] } },
    ],
    db: [{ name: 'pedido de baja', sql: "SELECT COUNT(*) FROM Notification n JOIN Conversation c ON c.id=n.refId WHERE c.waId='$WA' AND n.type='baja_poliza'", test: (r) => r[0][0] === '1' }],
  },
  {
    id: 'M09', area: 'Menú de clientes', name: 'Baja con varias pólizas: elegir y cancelar', wa: wa(),
    steps: [
      ...ident('99000002'),
      { select: 'm_baja_poliza', title: 'Baja de póliza', list: true, expect: { any: [/PALIO/, /STORM/] } },
      { drive: { max: 1, until: /Solicitar baja/, answer: (prev) => ({ select: (prev.match(/\[HONDA STORM\|(pol_\d+)\]/) || [])[1], title: 'HONDA STORM', list: true }), expect: { any: [/Solicitar baja/, /9900003/] } } },
      { select: 'cancelar', title: 'Cancelar', expect: { any: [/Cancelé el pedido de baja/] } },
    ],
  },
  {
    id: 'M10', area: 'Menú de clientes', name: 'Auxilio / Grúa', wa: wa(),
    steps: [
      ...ident('99000001'),
      { select: 'm_grua', title: '🆘 Auxilio / Grúa', list: true, expect: { any: [/Grúa/] } },
    ],
  },
  {
    id: 'M11', area: 'Menú de clientes', name: 'Asesor: avisa enseguida y suma el motivo', wa: wa(), regression: '#196 (14/10)',
    steps: [
      ...ident('99000001'),
      { select: 'm_asesor', title: '👤 Hablar con un asesor', list: true, expect: { any: [/ya le avisé a la oficina/i] } },
      { text: 'Necesito cambiar el domicilio de la póliza', expect: { any: [/tomé nota/i] } },
    ],
    db: [handoffs('un solo aviso con el motivo', (r) => r.length === 1 && /Motivo: Necesito cambiar el domicilio/.test(r[0][0]))],
  },
  {
    id: 'M12', area: 'Menú de clientes', name: 'Asesor: "gracias" no es motivo y el menú sigue andando', wa: wa(), regression: '#154 (13/10)',
    steps: [
      ...ident('99000001'),
      { select: 'm_asesor', title: '👤 Hablar con un asesor', list: true },
      { text: 'Gracias!', expect: { any: [/aviso ya está en la oficina/i] } },
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true, expect: { any: [/sin_nueva/] } },
    ],
    db: [handoffs('sin "Gracias" como motivo', (r) => r.length === 1 && !/Gracias/.test(r[0][0]))],
  },
  {
    id: 'M13', area: 'Menú de clientes', name: '"¿Mi póliza cubre granizo?" es una pregunta, no Documentación', wa: wa(), regression: 'revisión 14/10',
    steps: [
      ...ident('99000001'),
      { text: '¿Mi póliza cubre granizo?', expect: { reply: true, none: [/No tengo los documentos/, /documentación de tu/i] } },
    ],
  },
  {
    id: 'M14', area: 'Menú de clientes', name: '"Descuento de la cuota" no abre una baja', wa: wa(), regression: '#159 (14/10)',
    steps: [
      ...ident('99000002'),
      { text: 'Necesito urgente hacer el descuento del vehículo cuota', expect: { reply: true, none: [/Solicitar baja/, /\|confirmar\]/] } },
    ],
  },
  {
    id: 'M15', area: 'Menú de clientes', name: 'Baja que no dice "baja": pregunta antes', wa: wa(), regression: 'revisión 14/10',
    steps: [
      ...ident('99000001'),
      { text: 'Quiero sacar el seguro del auto que vendí', expect: { any: [/dar de baja/i] } },
      { select: 'baja_no', title: 'No, es otra cosa', expect: { any: [/te entendí mal/i] } },
    ],
  },
  {
    id: 'M16', area: 'Menú de clientes', name: 'La IA muestra el menú en vez de "escribí menú"', wa: wa(), regression: 'revisión 14/10 (24 veces)',
    steps: [
      { text: 'Hola' },
      { select: 'no_cliente', title: 'Todavía no' },
      { select: 'l_consultas', title: '💬 Otras consultas', list: true },
      { text: '¿Qué tengo que hacer si me rompen el parabrisas del auto estacionado?', max: 60000, expect: { reply: true, any: [/m_siniestros/], none: [noMenuWord, /Modificaciones|Asistencia\b|Asesoría/] } },
    ],
  },

  // ─── Siniestros ──────────────────────────────────────────────────
  {
    id: 'S01', area: 'Siniestros', name: 'Denuncia completa: una póliza, sin repreguntar tercero, fotos', wa: wa(), regression: 'revisión 14/10',
    steps: [
      ...ident('99000001'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { select: 'sin_nueva', title: 'Denuncia nueva', expect: { any: [/La denuncia es sobre tu CHEVROLET ONIX/, /Respondé todo en un solo mensaje/], none: [/pol_\d+/] } },
      { text: 'Fue ayer a las 18 hs en Rosario, en Bv. Oroño 1500, iba hacia el norte. Me chocó de atrás un auto en el semáforo. Iba sola, sin lesionados. Fue un Fiat Uno patente AB123CD, conductor Juan Pérez, seguro La Segunda', max: 60000, expect: { any: [/Revisá la denuncia/, /Oroño/] } },
      { select: 'confirmar', title: 'Confirmar', expect: { any: [/Registré tu denuncia/, /tarjeta verde/, /dorso/] } },
      { image: true, burst: 2, expect: { any: [/carnet de conducir/, /frente/], count: 1 } },
      { text: 'no la tengo', expect: { any: [/tarjeta verde del tercero/], none: [/¿Hubo un \*tercero/] } },
      { text: 'no la tengo' },
      { text: 'no la tengo', expect: { any: [/fotos del siniestro/] } },
      { text: 'listo', expect: { any: [/Sumé todo a tu denuncia/], none: [/a la brevedad/] } },
    ],
    db: [{ name: 'denuncia creada', sql: "SELECT COUNT(*) FROM Claim cl JOIN Client c ON c.id=cl.clientId WHERE c.dni='99000001' AND cl.description LIKE '%Oroño%'", test: (r) => Number(r[0][0]) >= 1 }],
  },
  {
    id: 'S02', area: 'Siniestros', name: 'Parabrisas: referencia en vez de altura y "Buenas" a mitad', wa: wa(), regression: '#196 (14/10)',
    steps: [
      ...ident('99000001'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { select: 'sin_nueva', title: 'Denuncia nueva' },
      { text: 'Buenas', expect: { any: [/Seguimos con la denuncia/] } },
      { text: 'Fue el 30/09 a las 18 en Rosario, por av circunvalación hacia el norte, nos saltó una piedra y se rajó el parabrisas. Íbamos 3, sin lesionados', max: 60000, expect: { any: [/Altura|otro vehículo/i] } },
      { text: 'cerca de la intersección con av San Martín. No hubo otro vehículo', max: 60000, expect: { any: [/Revisá la denuncia/, /San Martín/], none: [/Altura \(número\)/] } },
    ],
  },
  {
    id: 'S03', area: 'Siniestros', name: '"Asesor" con los botones de Siniestros en pantalla', wa: wa(), regression: '#196 (14/10)',
    steps: [
      ...ident('99000001'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { text: 'Asesor', expect: { any: [/ya le avisé a la oficina/i], none: [/denuncia nueva/i] } },
    ],
    db: [handoffs('aviso con contexto', (r) => r.some(([b]) => /Venía con siniestros/.test(b)))],
  },
  {
    id: 'S04', area: 'Siniestros', name: 'Ubicación compartida como lugar del hecho', wa: wa(),
    steps: [
      ...ident('99000001'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { select: 'sin_nueva', title: 'Denuncia nueva' },
      { text: 'Hoy a las 9 me chocaron de atrás en Rosario, iba hacia el sur, iba solo, sin heridos, el otro auto se fue', max: 60000, expect: { any: [/Calle/i] } },
      { location: { latitude: -32.94, longitude: -60.65, name: 'Esquina', address: 'Av. Pellegrini 1500, Rosario' }, max: 60000, expect: { any: [/Revisá la denuncia/, /Pellegrini/] } },
    ],
  },
  {
    id: 'S05', area: 'Siniestros', name: 'Póliza con débito rechazado: igual toma la denuncia (el bloqueo está apagado a propósito)', wa: wa(),
    steps: [
      ...ident('99000004'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { select: 'sin_nueva', title: 'Denuncia nueva', expect: { any: [/RENAULT SANDERO/, /Respondé todo/] } },
    ],
  },
  {
    id: 'S06', area: 'Siniestros', name: '"¿Cómo va mi denuncia?" no abre una nueva', wa: wa(), regression: 'prueba 13/10',
    steps: [
      { text: 'Hola, ¿cómo va mi denuncia?', expect: { any: [/DNI/] } },
      // Since 19/10 the question also reaches the office (the claim may have been filed by phone).
      { text: '99000002', expect: { any: [/No tengo denuncias tuyas registradas/i], none: [/Respondé todo/] } },
    ],
  },
  {
    id: 'S07', area: 'Siniestros', name: 'Varias fotos del daño juntas: una sola respuesta', wa: wa(), regression: 'revisión 12/10 (foto repetida)',
    steps: [
      ...ident('99000001'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { select: 'sin_nueva', title: 'Denuncia nueva' },
      { text: 'Ayer 10 hs en Rosario, Córdoba 1200, iba al este, me rayaron la puerta estacionado, iba solo, sin heridos, no hubo otro vehículo', max: 60000 },
      { select: 'confirmar', title: 'Confirmar' },
      { text: 'no la tengo' },
      { text: 'no la tengo', expect: { any: [/fotos del siniestro/] } },
      { image: true, burst: 4, expect: { count: 1 } },
    ],
  },
  {
    id: 'S08', area: 'Siniestros', name: 'Hogar: tipo de siniestro y qué se dañó, sin preguntas de auto', wa: wa(), regression: '#242 Valderramo (20/10)',
    steps: [
      ...ident('99000009'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { select: 'sin_nueva', title: 'Denuncia nueva', expect: { any: [/\[Hogar\|pol_\d+\]/, /\[Comercio\|pol_\d+\]/] } },
      { drive: { max: 1, until: /bt_danios/, answer: (prev) => ({ select: (prev.match(/\[Hogar\|(pol_\d+)\]/) || [])[1], title: 'Hogar', list: true }), expect: { any: [/bt_robo/, /bt_danios/, /bt_responsabilidad_civil/], none: [/circulabas/, /vehículo/] } } },
      { select: 'bt_danios', title: 'Daños', list: true, expect: { any: [/Qué se dañó/, /bd_cristales/, /bd_electrodomesticos/] } },
      { select: 'bd_cristales', title: 'Cristales', expect: { any: [/Daños a cristales/, /Respondé todo en un solo mensaje/, /Domicilio donde ocurrió/], none: [/circulabas/, /vehículo/] } },
      { text: 'Fue el 03/10 a las 20 hs en Eva Perón 8615 piso 1 depto 10, Rosario. Se rajó el vidrio de la ventana que da al sur.', max: 60000, expect: { any: [/Tipo de siniestro: Daños a cristales/, /Domicilio: Eva Per/, /\|confirmar\]/], none: [/Sentido de circulación/, /me faltan/] } },
      { select: 'confirmar', title: 'Confirmar', expect: { any: [/Registré tu denuncia/, /fotos/], none: [/tarjeta verde/, /carnet/] } },
      { image: true, expect: { count: 1 } },
      { text: 'listo', expect: { any: [/Sumé todo a tu denuncia/] } },
    ],
    db: [
      { name: 'denuncia de hogar creada', sql: "SELECT cl.type FROM Claim cl JOIN Client c ON c.id=cl.clientId WHERE c.dni='99000009' AND cl.description LIKE '%Daños a cristales%' AND cl.description LIKE '%Eva Per%'", test: (r) => r.length === 1 && r[0][0] === 'hogar' },
      { name: 'aviso de siniestro a la oficina', sql: "SELECT COUNT(*) FROM Notification n JOIN Claim cl ON cl.id=n.refId JOIN Client c ON c.id=cl.clientId WHERE c.dni='99000009' AND n.type='siniestro' AND n.deletedAt IS NULL", test: (r) => Number(r[0][0]) >= 1 },
    ],
  },
  {
    id: 'S09', area: 'Siniestros', name: 'Comercio: robo escrito en texto, un solo mensaje, cancelar', wa: wa(),
    steps: [
      ...ident('99000009'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { select: 'sin_nueva', title: 'Denuncia nueva', expect: { any: [/\[Comercio\|pol_\d+\]/] } },
      { drive: { max: 1, until: /bt_robo/, answer: (prev) => ({ select: (prev.match(/\[Comercio\|(pol_\d+)\]/) || [])[1], title: 'Comercio', list: true }), expect: { any: [/bt_robo/, /bt_incendio/] } } },
      { text: 'Me robaron en el local, entraron de noche', expect: { any: [/Anoté: \*Robo\*/, /Respondé todo en un solo mensaje/], none: [/Qué se dañó/] } },
      { text: 'Anoche a las 3 de la mañana, en Córdoba 1200, Rosario. Forzaron la persiana y se llevaron la caja registradora y mercadería.', max: 60000, expect: { any: [/Tipo de siniestro: Robo/, /Domicilio: /, /\|confirmar\]/], none: [/Sentido de circulación/] } },
      { select: 'cancelar', title: 'Cancelar', expect: { any: [/Cancelé la denuncia/] } },
    ],
    db: [{ name: 'sin denuncia', sql: "SELECT COUNT(*) FROM Claim cl JOIN Client c ON c.id=cl.clientId WHERE c.dni='99000009' AND cl.description LIKE '%Robo%'", test: (r) => Number(r[0][0]) === 0 }],
  },

  // ─── Cotización ──────────────────────────────────────────────────
  {
    id: 'C01', area: 'Cotización', name: 'Auto online de punta a punta (Triunfo, sin presupuesto)', wa: wa(),
    steps: [
      { text: 'Hola' },
      { select: 'no_cliente', title: 'Todavía no' },
      { select: 'l_cotizar', title: '💰 Cotizar un seguro', list: true, expect: { any: [/cot_auto/] } },
      { select: 'cot_auto', title: 'Auto', list: true, expect: { any: [/marca, modelo, año/] } },
      { text: 'Volkswagen Gol Trend 1.6 2015, código postal 2000', max: 90000, quiet: 5000 },
      {
        drive: {
          max: 4,
          until: /por mes/,
          answer: (prev) => /\|gnc_no\]/.test(prev) ? { select: 'gnc_no', title: 'No tiene GNC' }
            : /(^|\n)\s*\*?1[.)]/.test(prev) ? { text: '1' }
            : /c[oó]digo postal|localidad/i.test(prev) ? { text: '2000' }
            : { text: 'Volkswagen Gol Trend 1.6 2015, Rosario' },
          expect: { any: [/por mes/, /Responsabilidad Civil|\bA\b/], none: [noMenuWord] },
        },
      },
      { text: 'Me interesa la A', max: 90000, quiet: 5000, expect: { any: [/DNI/] } },
    ],
  },
  {
    id: 'C02', area: 'Cotización', name: 'Moto online en el primer mensaje', wa: wa(),
    steps: [
      { text: 'Hola quiero cotizar una moto Honda Wave 110 2023, soy de Rosario', max: 90000, quiet: 5000 },
      {
        drive: {
          max: 4,
          until: /por mes/,
          answer: (prev) => /(^|\n)\s*\*?1[.)]/.test(prev) ? { text: '1' }
            : /c[oó]digo postal|localidad/i.test(prev) ? { text: '2000' }
            : { text: 'Honda Wave 110 S 2023, código postal 2000' },
          expect: { any: [/por mes/, /B1/], none: [/GNC/] },
        },
      },
    ],
  },
  {
    id: 'C03', area: 'Cotización', name: 'Hogar: plan fijo → nombre → teléfono', wa: wa(),
    steps: [
      { text: 'Hola' },
      { select: 'no_cliente', title: 'Todavía no' },
      { select: 'l_cotizar', title: '💰 Cotizar un seguro', list: true },
      { select: 'cot_hogar', title: 'Hogar', list: true, expect: { any: [/plan_\d+/] } },
      { drive: { max: 1, until: /nombre y apellido/, answer: (prev) => ({ select: (prev.match(/\|(plan_\d+)\]/) || [])[1], title: 'Plan', list: true }), expect: { any: [/nombre y apellido/] } } },
      { text: 'Juan Prueba', expect: { any: [/teléfono/] } },
      { text: '341 555-0000', expect: { any: [/Registré tu pedido de cotización/] } },
    ],
  },
  {
    id: 'C04', area: 'Cotización', name: '"Que me llamen" (no cliente)', wa: wa(),
    steps: [
      { text: 'Hola' },
      { select: 'no_cliente', title: 'Todavía no' },
      { select: 'l_vendedor', title: '📞 Que me llamen', list: true, expect: { any: [/nombre/] } },
      { text: 'Juan Prueba, a la tarde', expect: { any: [/representante/i] } },
    ],
    db: [handoffs('aviso de contacto', (r) => r.some(([b]) => /Juan Prueba/.test(b)))],
  },

  // ─── No clientes ─────────────────────────────────────────────────
  {
    id: 'L01', area: 'No clientes', name: '"Todavía no" → "Ya soy cliente"', wa: wa(), regression: 'revisión 14/10',
    steps: [
      { text: 'Hola' },
      { select: 'no_cliente', title: 'Todavía no', expect: { any: [/Ya soy cliente/] } },
      { select: 'cliente', title: '👤 Ya soy cliente', list: true, expect: { any: [/DNI del titular/] } },
      { text: '99000001', expect: { any: [/te identifiqué/i] } },
    ],
  },
  {
    id: 'L02', area: 'No clientes', name: 'Pide su deuda desde el menú de no clientes', wa: wa(), regression: 'revisión 14/10',
    steps: [
      { text: 'Hola' },
      { select: 'no_cliente', title: 'Todavía no' },
      { text: 'En realidad quiero saber cuánto debo de mi seguro', expect: { any: [/DNI/] } },
      { text: '99000002', expect: { any: [/Estado de cuenta/] } },
    ],
  },
  {
    id: 'L03', area: 'No clientes', name: 'Consulta sobre coberturas sin dar precios', wa: wa(),
    steps: [
      { text: 'Hola' },
      { select: 'no_cliente', title: 'Todavía no' },
      { select: 'l_consultas', title: '💬 Otras consultas', list: true },
      { text: '¿Qué cubre el seguro de bicicleta?', max: 60000, expect: { reply: true, none: [/\$\s?\d/, noMenuWord] } },
    ],
  },

  // ─── Fotos, archivos y audios ────────────────────────────────────
  {
    id: 'X01', area: 'Fotos, archivos y audios', name: 'Foto suelta: pregunta para qué es una sola vez', wa: wa(), regression: 'revisión 12/10',
    steps: [
      ...ident('99000002'),
      { image: true, burst: 3, expect: { any: [/Recibí tus 3 fotos/, /Contame para qué/], count: 1 } },
    ],
  },
  {
    id: 'X02', area: 'Fotos, archivos y audios', name: 'PDF con "este es el comprobante": va a la oficina', wa: wa(), regression: 'revisión 14/10',
    steps: [
      ...ident('99000002'),
      { pdf: 'transferencia.pdf', caption: 'este es el comprobante de pago', expect: { any: [/tomé nota/i] } },
    ],
    db: [
      handoffs('aviso del comprobante', (r) => r.some(([b]) => /comprobante/.test(b))),
      { name: 'PDF en la charla', sql: "SELECT COUNT(*) FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.waId='$WA' AND m.content LIKE '%transferencia.pdf%'", test: (r) => r[0][0] === '1' },
    ],
  },
  {
    id: 'X03', area: 'Fotos, archivos y audios', name: 'Video, contacto, archivo y ubicación quedan y se responden', wa: wa(),
    steps: [
      ...ident('99000001'),
      { video: true, expect: { any: [/Recibí tu video/] } },
      { contact: 'Taller Norte', phone: '+54 341 555-0000', expect: { any: [/Recibí el contacto/] } },
      { doc: 'nota.doc', expect: { any: [/no lo puedo abrir/] } },
      { location: { latitude: -32.95, longitude: -60.66, name: 'Taller', address: 'Bv. Rondeau 1500, Rosario' }, expect: { any: [/Recibí tu ubicación/] } },
    ],
    db: [{ name: 'los 4 en la charla', sql: "SELECT COUNT(*) FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.waId='$WA' AND m.role='user' AND (m.content LIKE '%video%' OR m.content LIKE '%contacto%' OR m.content LIKE '%nota.doc%' OR m.content LIKE '%Ubicación%')", test: (r) => r[0][0] === '4' }],
  },
  {
    id: 'X04', area: 'Fotos, archivos y audios', name: 'Audio: se transcribe y se responde', wa: wa(),
    steps: [
      { text: 'Hola' },
      // fixtures/voz.m4a says "Hola, quería saber cuánto debo de mi seguro".
      { audio: true, max: 60000, expect: { reply: true, none: [/No pude (entender|descargar) el audio/, /¿Qué querés cotizar\?/] } },
    ],
  },

  {
    id: 'M17', area: 'Menú de clientes', name: '"No se pudo realizar el pago": avisa a la oficina y no dice "en proceso"', wa: wa(), regression: '#242 y #172 (20/10)',
    steps: [
      ...ident('99000002'),
      { text: 'Hola, me llegó una notificación de que no se pudo realizar el pago. ¿Te puedo transferir a este alias?', expect: { any: [/sin debitar/, /Ya le avisé a la oficina/], none: [/en proceso de débito/, /dejá el dinero disponible/] } },
    ],
    db: [handoffs('aviso con las palabras del cliente', (r) => r.some(([b]) => /Dice que el débito no se realizó/.test(b) && /no se pudo realizar el pago/.test(b)))],
  },

  // ─── Mejoras del 20/10: cobertura, pagos, denuncias ──────────────
  {
    id: 'V01', area: 'Cobertura y pagos (20/10)', name: '"¿Tengo cubierto el parabrisas?" se responde con la cobertura de la póliza', wa: wa(), regression: '#87 (cristales 4 veces)',
    steps: [
      ...ident('99000001'),
      { text: '¿Tengo cubierta la rotura del parabrisas?', max: 60000, expect: { any: [/parabrisas|cristales/i, /500\.000/, /m_siniestros/, /m_asesor/], none: [/Respondé todo en un solo mensaje/, /circulabas/] } },
    ],
  },
  {
    id: 'V02', area: 'Cobertura y pagos (20/10)', name: 'Hogar: "¿me cubre los vidrios?" con las coberturas que manda Triunfo, eligiendo la póliza', wa: wa(),
    steps: [
      ...ident('99000009'),
      { text: '¿Mi seguro me cubre si se rompe un vidrio de la ventana?', max: 60000, expect: { any: [/\[Hogar\|pol_\d+\]/, /\[Comercio\|pol_\d+\]/] } },
      { drive: { max: 1, until: /cristales|vidrio/i, answer: (prev) => ({ select: (prev.match(/\[Hogar\|(pol_\d+)\]/) || [])[1], title: 'Hogar', list: true }), expect: { any: [/cristales/i, /300\.000/, /m_siniestros/] } } },
    ],
  },
  {
    id: 'V03', area: 'Cobertura y pagos (20/10)', name: '"¿Hasta cuándo puedo pagar?" responde la regla de la oficina con las cuotas', wa: wa(),
    steps: [
      ...ident('99000002'),
      { text: '¿Hasta cuándo puedo pagar la cuota sin quedarme sin seguro?', expect: { any: [/Hasta cuándo pagar/, /hasta el vencimiento de la cuota/], none: [/del 10\b/, /1 y el 10/] } },
    ],
  },
  {
    id: 'V04', area: 'Cobertura y pagos (20/10)', name: '"¿Puedo pagar con Mercado Pago?" lista las formas de pago', wa: wa(),
    steps: [
      ...ident('99000002'),
      { text: '¿Puedo pagar la cuota con Mercado Pago?', expect: { any: [/Formas de pago/, /Mercado Pago con el cupón/, /TRUENO\.VUELO\.DELTA/] } },
    ],
  },
  {
    id: 'V07', area: 'Cobertura y pagos (20/10)', name: 'Cupón de una cuota rechazada: pasa el pedido y ofrece transferir a Triunfo', wa: wa(), regression: 'John 20/10',
    steps: [
      ...ident('99000004'),
      { text: 'Necesito el cupón para pagar la cuota que me rechazaron', expect: { any: [/Si querés pagarla ya, podés transferir/, /cuota 5/, /TRUENO\.VUELO\.DELTA/, /comprobante/], none: [/0 hs/] } },
    ],
    db: [handoffs('aviso con los datos de transferencia', (r) => r.some(([b]) => /Se le pasaron los datos para transferir/.test(b)))],
  },
  {
    id: 'V05', area: 'Cobertura y pagos (20/10)', name: 'Copia de la denuncia: a la oficina, sin abrir una denuncia nueva', wa: wa(), regression: '#205, #209',
    steps: [
      ...ident('99000001'),
      { text: 'Necesito la copia de la denuncia del choque de la semana pasada', expect: { any: [/La copia de la denuncia te la manda la oficina/], none: [/Respondé todo en un solo mensaje/] } },
    ],
    db: [handoffs('aviso de copia de denuncia', (r) => r.some(([b]) => /Pide copia de la denuncia/.test(b)))],
  },
  {
    id: 'V06', area: 'Cobertura y pagos (20/10)', name: '"¿Cuál es el 0800 para denunciar?" no abre el formulario', wa: wa(), regression: '#148',
    steps: [
      ...ident('99000001'),
      { text: '¿Cuál es el 0800 para hacer la denuncia?', expect: { any: [/0810-666-0302/, /la podés hacer por acá/, /sin_nueva/], none: [/Respondé todo en un solo mensaje/] } },
    ],
  },

  // ─── Oficina ─────────────────────────────────────────────────────
  {
    id: 'O01', area: 'Oficina', name: 'La oficina escribe desde el celular: el bot se calla', wa: wa(),
    steps: [
      { text: 'Hola' },
      { echo: 'Hola, soy Mili de la oficina. ¿En qué te ayudo?', expect: { silent: true } },
      { text: 'Necesito hablar por mi póliza', expect: { silent: true } },
    ],
    db: [{ name: 'mensaje guardado para la oficina', sql: "SELECT COUNT(*) FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.waId='$WA' AND m.content='Necesito hablar por mi póliza'", test: (r) => r[0][0] === '1' }],
  },
  {
    id: 'O02', area: 'Oficina', name: 'Sigue una charla que atendía la oficina (sin "¿sos cliente?")', wa: '5493419990120', regression: '#180 (14/10)',
    steps: [
      { text: 'Hola, ya te mandé las fotos que me pediste', expect: { none: [/ya sos cliente/i, /DNI/] } },
    ],
    db: [handoffs('aviso para quien atendía', (r) => r.length >= 1)],
  },

  // ─── Pedidos escritos en vez de tocar la lista (revisión 19/10) ───
  // The bot used to answer these with "escribime 'quiero la documentación'"
  // or promise papers it never sent.
  {
    id: 'W01', area: 'Pedidos escritos (19/10)', name: '"Tarjeta verde" en la lista de pólizas: pregunta de cuál y la manda', wa: wa(), regression: '#87 (15/10)',
    steps: [
      ...ident('99000002'),
      { select: 'm_documentos', title: '📄 Documentación', list: true, expect: { any: [/pol_otra/] } },
      { text: 'tarjeta verde', expect: { any: [/¿De qué póliza querés la tarjeta verde\?/], none: [promise] } },
      { text: 'la del palio', expect: { any: [/\[documento Tarjeta verde \(Mercosur\) - ZZ902AA\.pdf\]/], none: [promise] } },
    ],
  },
  {
    id: 'W02', area: 'Pedidos escritos (19/10)', name: '"La espero" / "no me llegó" en la lista: responde sin prometer y vuelve a mostrar la lista', wa: wa(), regression: '#87 (15/10)',
    steps: [
      ...ident('99000002'),
      { select: 'm_documentos', title: '📄 Documentación', list: true },
      { text: 'la espero', expect: { any: [/pol_otra/], none: [promise] } },
      { text: 'no me llego', expect: { any: [/pol_otra|\[documento/], none: [promise] } },
    ],
  },
  {
    id: 'W03', area: 'Pedidos escritos (19/10)', name: '"Cupón" en la lista de papeles: pide los cupones a la oficina', wa: wa(), regression: '#87 (16/10)',
    steps: [
      ...ident('99000001'),
      { select: 'm_documentos', title: '📄 Documentación', list: true, expect: { any: [/doc_todos/] } },
      { text: 'Cupon', expect: { any: [/cupones de pago te los manda la oficina/i], none: [promise] } },
    ],
    db: [handoffs('aviso de cupones', (r) => r.some(([b]) => /cupones/i.test(b)))],
  },
  {
    id: 'W04', area: 'Pedidos escritos (19/10)', name: '"Quiero de otra póliza" con los papeles en pantalla: vuelve a la lista sin mandar la Póliza', wa: wa(), regression: '#87 (16/10)',
    steps: [
      ...ident('99000002'),
      { select: 'm_documentos', title: '📄 Documentación', list: true },
      { text: 'el palio', expect: { any: [/doc_todos/] } },
      { text: 'Quiero de otra poliza', expect: { any: [/pol_otra/], none: [/\[documento Póliza/] } },
    ],
  },
  {
    id: 'W05', area: 'Pedidos escritos (19/10)', name: 'En "¿Qué querés cotizar?" pide la póliza ya emitida: se la manda', wa: wa(), regression: '#201 (16/10)',
    steps: [
      ...ident('99000001'),
      { select: 'm_cotizacion', title: '💰 Cotización', list: true, expect: { any: [/cot_auto/] } },
      { text: 'No, que me envíes una póliza que ya está emitida!!', expect: { any: [/doc_1020|\[documento Póliza/], none: [promise, /cot_auto/] } },
    ],
  },
  {
    id: 'W06', area: 'Pedidos escritos (19/10)', name: '"Cómo tendría que hacer" para pagar: no le dice qué frase escribir', wa: wa(), regression: '#224 (16/10)',
    steps: [
      ...ident('99000001'),
      { select: 'm_pagos', title: '💳 Pagos y cobranzas', list: true, expect: { any: [/Estado de cuenta/] } },
      { text: 'Mañana se me vence, cómo tendría que hacer para pagar?', expect: { reply: true, none: [promise] } },
    ],
  },
  {
    id: 'W07', area: 'Pedidos escritos (19/10)', name: 'Agregar a una persona a la póliza: va a la oficina con el pedido', wa: wa(), regression: '#198 (15/10)',
    steps: [
      ...ident('99000001'),
      { text: 'Te paso para agregar a la póliza a una persona más', expect: { any: [/tomé nota/i], none: [promise, /tocá \*?Hablar con un asesor/i] } },
    ],
    db: [handoffs('aviso con el pedido', (r) => r.some(([b]) => /agregar/i.test(b)))],
  },
  {
    id: 'W08', area: 'Pedidos escritos (19/10)', name: 'Cambio de orden de parabrisas: va a la oficina con el pedido', wa: wa(), regression: '#123 (16/10)',
    steps: [
      ...ident('99000001'),
      { text: 'perdon que te joda, queria saber si se pudo cambiar la orden de parabrisas que salio para un taller y tenia que ser para otro', expect: { any: [/tomé nota/i], none: [promise, /tocá \*?Hablar con un asesor/i] } },
    ],
    db: [handoffs('aviso con el pedido', (r) => r.some(([b]) => /parabrisas/i.test(b)))],
  },
  {
    id: 'W09', area: 'Pedidos escritos (19/10)', name: '"Decime si está vigente": lo responde con sus datos', wa: wa(), regression: '#200 (15/10)',
    steps: [
      ...ident('99000001'),
      { text: 'decime si esta vigente', expect: { any: [/Estado de cuenta|al día|vigente/i], none: [promise, /tocá \*?Pagos/i] } },
    ],
  },
  {
    id: 'W10', area: 'Pedidos escritos (19/10)', name: '"Quiero cupones" escrito en la lista de papeles avisa de verdad a la oficina', wa: wa(), regression: '#87 (16/10)',
    steps: [
      ...ident('99000002'),
      { select: 'm_documentos', title: '📄 Documentación', list: true },
      { text: 'Quiero cupones', expect: { any: [/pol_todas|cupones de pago/i], none: [promise] } },
    ],
  },

  // ─── Identificación (revisión 19/10) ──────────────────────────────
  {
    id: 'D01', area: 'Identificación (19/10)', name: '"No, soy otra persona": no vuelve a preguntar "¿Hablo con…?"', wa: '5493419990008', regression: '#87, #200 (15–16/10)',
    steps: [
      { text: 'Hola', expect: { any: [/Hablo con \*Jorge\*/] } },
      { select: 'id_phone_no', title: 'No, soy otra persona', expect: { any: [/ya sos cliente/i] } },
      { select: 'cliente', title: 'Sí, soy cliente', expect: { any: [/DNI/], none: [/Hablo con/] } },
      { text: '99000001', expect: { any: [/te identifiqué/i] } },
    ],
  },
  {
    id: 'D02', area: 'Identificación (19/10)', name: 'Patente en vez de contestar "¿ya sos cliente?": identifica', wa: wa(), regression: '#200 (15/10)',
    steps: [
      { text: 'Hola buenos dias', expect: { any: [/ya sos cliente/i] } },
      { text: 'ZZ901AA', expect: { any: [/te identifiqué/i, /m_pagos/] } },
    ],
  },
  {
    id: 'D03', area: 'Identificación (19/10)', name: 'Patente con letra O en vez de cero como primer mensaje: identifica', wa: wa(), regression: '#143 (16/10)',
    steps: [{ text: 'ZZ9O1AA', expect: { any: [/te identifiqué/i] } }],
  },
  {
    id: 'D04', area: 'Identificación (19/10)', name: 'Dos datos que no existen: "no encontré" y ofrece asesor, sin "no te entiendo"', wa: wa(), regression: '#223 (16/10)',
    steps: [
      { text: 'Hola' },
      { select: 'cliente', title: 'Sí, soy cliente' },
      { text: '30111222', expect: { any: [/No encontré/] } },
      { text: 'ZZ999ZZ', expect: { any: [/Tampoco encontré/, /stuck_asesor/], none: [/no te estoy entendiendo/i] } },
    ],
  },
  {
    id: 'D05', area: 'Identificación (19/10)', name: '"Necesito asegurar otro auto" donde pide el DNI: va a cotizar', wa: wa(), regression: '#225 (16/10)',
    steps: [
      { text: 'Hola' },
      { select: 'cliente', title: 'Sí, soy cliente' },
      { text: 'Necesito asegurar otro auto', expect: { reply: true, none: [/DNI/] } },
    ],
  },

  // ─── Cotización y pedidos (revisión 19/10, grupos 4 y 6) ──────────
  {
    id: 'Q01', area: 'Cotización y pedidos (19/10)', name: '"Necesito otra póliza con otro DNI" no abre Cotización', wa: wa(), regression: '#87 (15/10)',
    steps: [
      ...ident('99000002'),
      { text: 'necesito otra poliza con otro dni', expect: { reply: true, none: [/cot_auto/, /¿Qué querés cotizar/] } },
    ],
  },
  {
    id: 'Q02', area: 'Cotización y pedidos (19/10)', name: '"Quiero una póliza" de un cliente: documentación, no Cotización', wa: wa(), regression: '#201 (16/10)',
    steps: [
      ...ident('99000001'),
      { text: 'Quiero una póliza', expect: { any: [/doc_\d+|\[documento/], none: [/cot_auto/] } },
    ],
  },
  {
    id: 'Q03', area: 'Cotización y pedidos (19/10)', name: 'Etios: elige "4 puertas manual" una sola vez; descuento a la oficina; "dale" contrata la recomendada', wa: wa(), regression: '#217, #222 (16/10)',
    steps: [
      { text: 'Hola' },
      { select: 'no_cliente', title: 'Todavía no' },
      { select: 'l_cotizar', title: '💰 Cotizar un seguro', list: true },
      { select: 'cot_auto', title: 'Auto', list: true },
      { text: 'Toyota etios 1.5 xls 2017, Rosario', max: 90000, quiet: 5000 },
      {
        drive: {
          // List → GNC → quote: a version asked again needs a fourth turn.
          max: 3,
          until: /por mes/,
          answer: (prev) => {
            if (/\|gnc_no\]/.test(prev)) return { select: 'gnc_no', title: 'No tiene GNC' };
            const line = prev.split('\n').map((l) => l.match(/^\s*\*?(\d+)[.)]\*?\s*(.+)$/)).find((m) => m && /\b4\s*(p|puertas)/i.test(m[2]) && !/aut|\bAT\b|CVT/i.test(m[2]));
            if (line) return { text: line[1] };
            return /c[oó]digo postal|localidad/i.test(prev) ? { text: '2000' } : { text: '4 puertas manual' };
          },
          expect: { any: [/por mes/] },
        },
      },
      { text: 'Por emerger tengo descuento?', expect: { any: [/oficina/i], none: [/Solo puedo ayudarte con la cotización/i] } },
      { text: 'cual me recomendas?', expect: { reply: true } },
      { text: 'dale', expect: { any: [/DNI/], none: [/Hablar con un asesor/] } },
    ],
    db: [handoffs('aviso de contratación con la cobertura', (r) => r.some(([b]) => /Quiere contratar/.test(b)))],
  },
  {
    id: 'Q04', area: 'Cotización y pedidos (19/10)', name: 'Bolso: pregunta por el Plus y qué hay que presentar, sin "No reconocí ese plan"', wa: wa(), regression: '#202 (15/10)',
    steps: [
      { text: 'Hola' },
      { select: 'no_cliente', title: 'Todavía no' },
      { select: 'l_cotizar', title: '💰 Cotizar un seguro', list: true },
      { select: 'cot_bolso', title: 'Bolso protegido', list: true, expect: { any: [/plan_\d+/] } },
      { text: 'Me podrás explicar bien el bolso plus', expect: { any: [/plan_\d+/], none: [/No reconocí ese plan/, /no te estoy entendiendo/i] } },
      { text: 'Y que hay que presentar', expect: { reply: true, none: [/No reconocí ese plan/, /no te estoy entendiendo/i] } },
    ],
  },
  {
    id: 'Q05', area: 'Cotización y pedidos (19/10)', name: 'Después del pedido de cupones, los 👍 no se contestan', wa: wa(), regression: '#224 (16/10)',
    steps: [
      ...ident('99000001'),
      { text: 'me pasás el cupón de pago?', expect: { any: [/cupones de pago te los manda la oficina/i] } },
      { text: '👍👍', expect: { silent: true } },
      { text: '👍', expect: { silent: true } },
    ],
  },
  {
    id: 'Q06', area: 'Cotización y pedidos (19/10)', name: '"Tarjeta de circulación": manda la tarjeta y aclara que es esa', wa: wa(), regression: '#220 (16/10)',
    steps: [
      ...ident('99000001'),
      { text: 'me podrias enviar la tarjeta de circulación', expect: { any: [/\[documento Tarjeta verde/, /es tu tarjeta de circulación/] } },
    ],
  },

  // ─── Lo que va a la oficina (revisión 19/10, grupo 5) ─────────────
  {
    id: 'K01', area: 'A la oficina (19/10)', name: 'Foto de un comprobante suelta: la reconoce y avisa a la oficina', wa: wa(), regression: '#86 (16/10)',
    steps: [
      // Jorge: no claim of his own, which a loose photo would be added to.
      ...ident('99000008'),
      { image: true, receipt: true, max: 60000, expect: { any: [/pasé a la oficina/], none: [/Contame para qué/] } },
    ],
    db: [handoffs('aviso del comprobante', (r) => r.some(([b]) => /comprobante de pago/i.test(b)))],
  },
  {
    id: 'K02', area: 'A la oficina (19/10)', name: 'Foto y después "Pago de septiembre de la patente…": comprobante a la oficina', wa: wa(), regression: '#86 (16/10)',
    steps: [
      ...ident('99000008'),
      { image: true, max: 60000, expect: { any: [/Contame para qué/] } },
      { text: 'Pago del septiembre de la patente ZZ901AA', expect: { any: [/Le pasé el comprobante/], none: [/Estado de cuenta/] } },
    ],
    db: [handoffs('aviso del comprobante', (r) => r.some(([b]) => /comprobante de pago/i.test(b)))],
  },
  {
    id: 'K03', area: 'A la oficina (19/10)', name: 'Sin pólizas vigentes: avisa con lo que pidió y el asesor recibe la consulta', wa: wa(), regression: '#226 (17/10)',
    steps: [
      { text: 'Hola' },
      { select: 'cliente', title: 'Sí, soy cliente' },
      { text: '99000008', expect: { any: [/te identifiqué/i] } },
      { text: 'Quiero que me pasen la póliza de este mes para pagar', expect: { any: [/ya le pasé tu consulta a la oficina/] } },
      { select: 'm_asesor', title: '👤 Hablar con un asesor', list: true, expect: { reply: true, none: [/contame brevemente el motivo/i] } },
    ],
    db: [handoffs('aviso con lo que pidió', (r) => r.some(([b]) => /no tiene pólizas vigentes/.test(b) && /póliza de este mes/.test(b)))],
  },
  {
    id: 'K04', area: 'A la oficina (19/10)', name: 'Pregunta sobre un siniestro sin denuncias cargadas: va a la oficina', wa: wa(), regression: '#211 (16/10)',
    steps: [
      ...ident('99000001'),
      { text: 'Hola, ¿cómo va? Iba a llamar al seguro por los vidrios rotos de la casa pero pagué tarde la cuota, ¿habrá algún problema?', expect: { any: [/oficina|tomé nota/], none: [/No tenés denuncias de siniestro registradas\. Si querés iniciar una/] } },
    ],
    db: [handoffs('aviso con la pregunta', (r) => r.some(([b]) => /vidrios/.test(b)))],
  },

  // ─── Pendientes conocidos (no implementados todavía) ─────────────
  {
    id: 'G01', area: 'Oficina', name: 'Respuesta automática de otra empresa: no contestar', wa: wa(), regression: '#118',
    steps: [
      { text: 'Gracias por comunicarte con Inmobiliaria Ejemplo. En breve te responderemos. Horario de atención: lunes a viernes de 9 a 18.', expect: { silent: true } },
    ],
  },

  {
    id: 'P16', area: 'Primer mensaje e identificación', name: '"¿Cuánto debo de mi seguro?" en el "¿ya sos cliente?" pide el DNI, no abre Cotización', wa: wa(), regression: 'encontrado por esta batería (15/10)',
    steps: [
      { text: 'Hola' },
      { text: 'Quería saber cuánto debo de mi seguro', expect: { any: [/DNI/], none: [/¿Qué querés cotizar\?/] } },
    ],
  },

  // ─── Revisión de chats 20/9–26/10 (R01–R53) ──────────────────────
  // Primer mensaje e identificación
  {
    id: 'R01', area: 'Revisión 26/10 · Identificación', name: 'Pedido con nombre y patente en el primer mensaje: identifica y manda toda la documentación', wa: rwa(), regression: '#258',
    steps: [
      { text: 'Buenos días soy Antonio tengo una póliza del vehículo PALIO dominio ZZ902AA que ya venció, agradecería la nueva renovación', expect: { any: [/te identifiqué/i, /documentaci[oó]n|Qué documento/], none: [/DNI/] } },
      { text: 'Bueno sería toda la documentación del seguro', expect: { docs: 5, any: [/Ahí te mandé/] } },
    ],
  },
  {
    id: 'R02', area: 'Revisión 26/10 · Identificación', name: 'Patente que no está en cartera dos veces: "no encontré" y asesor, sin "no te entiendo"', wa: rwa(), regression: '#265, #284',
    steps: [
      { text: 'Hola ayer intenté pagar y hoy también y no me deja', expect: { any: [/DNI|patente/] } },
      { text: 'ZZ999ZZ', expect: { any: [/No encontré/] } },
      { text: 'ZZ998ZZ', expect: { any: [/asesor/], none: [/no te (estoy )?entiendo/i] } },
    ],
  },
  {
    id: 'R02b', area: 'Revisión 26/10 · Identificación', name: 'Póliza nueva que no está en cartera "para pagar por primera vez"', wa: rwa(), regression: '#284',
    steps: [
      { text: 'Hola, quiero pagar por primera vez la póliza nueva del auto y no me deja', expect: { any: [/DNI|patente/] } },
      { text: 'ZZ997ZZ', expect: { any: [/No encontré/] } },
      { text: 'ZZ996ZZ', expect: { any: [/asesor/], none: [/no te (estoy )?entiendo/i] } },
    ],
  },
  {
    id: 'R03', area: 'Revisión 26/10 · Identificación', name: 'Otra persona con el DNI del titular: documentos y después cotizar otro auto', wa: '5493419990014', regression: '#261',
    steps: [
      { text: 'Hola', expect: { any: [/Hablo con \*Hernan\*/] } },
      { select: 'id_phone_no', title: 'No, soy otra persona', expect: { any: [/ya sos cliente/i] } },
      { select: 'cliente', title: 'Sí, soy cliente', expect: { any: [/DNI/] } },
      { text: '99000001', expect: { any: [/te identifiqué/i] } },
      { select: 'm_documentos', title: '📄 Documentación', list: true, expect: { any: [/doc_todos/] } },
      { text: 'le quiero poner el seguro a otro auto', expect: { any: [/marca, modelo/], none: [/DNI/, /Qué documento/] } },
    ],
  },
  {
    id: 'R04', area: 'Revisión 26/10 · Identificación', name: 'El mismo mensaje dos veces seguidas: contesta una sola vez', wa: rwa(), regression: '#272', known: 'contesta dos veces el mensaje duplicado',
    steps: [
      { text: 'Hola buenas tardes, necesito la póliza del auto que la tengo que presentar mañana en el trabajo', expect: { reply: true } },
      { text: 'Hola buenas tardes, necesito la póliza del auto que la tengo que presentar mañana en el trabajo', expect: { silent: true } },
    ],
  },
  {
    id: 'R05', area: 'Revisión 26/10 · Identificación', name: 'DNI, patente, RC y cambio a cupón en el primer mensaje', wa: rwa(), regression: '#272', known: 'pasa el cambio de pago pero no contesta lo de la RC',
    steps: [
      { text: 'Hola soy Lucas 99000002 tengo la moto Z902AAA, la moto no la estoy usando y quería saber cuánto sale solo contra terceros y pagarla con cuponera y sacarla del débito', max: 60000, expect: { any: [/te identifiqué/i, /terceros|Responsabilidad Civil/i] } },
    ],
    db: [handoffs('aviso de cambio de forma de pago', (r) => r.some(([b]) => /forma de pago/i.test(b)))],
  },
  {
    id: 'R06', area: 'Revisión 26/10 · Identificación', name: '"Consulta" y una pregunta general sin identificarse', wa: rwa(), regression: '#252',
    steps: [
      { text: 'Consulta', expect: { reply: true } },
      { text: 'Qué significa eso de premio trimestral', max: 60000, expect: { any: [/tres meses|trimestr/i], none: [/DNI/] } },
    ],
  },
  {
    id: 'R07', area: 'Revisión 26/10 · Identificación', name: 'Un mail como único mensaje', wa: rwa(), regression: '#144',
    steps: [{ text: 'sperez@ejemplo.com', expect: { any: [/correo|mail/i], none: [/No te (estoy )?entiendo/i] } }],
  },
  {
    id: 'R08', area: 'Revisión 26/10 · Identificación', name: '"No sé con quién estoy hablando": aclara que es Nico, el asistente', wa: rwa(), regression: '#188, #159', known: 'asksIfTalkingTo no cubre esta forma (pasa solo cuando es el primer mensaje: el saludo ya dice que es Nico)',
    steps: [{ text: 'Hola Mili, Nico, no sé con quién estoy hablando', expect: { any: [/Nico/i, /asistente/i] } }],
  },

  // Oficina y seguimiento
  {
    id: 'R09', area: 'Revisión 26/10 · Oficina', name: 'Saludo mientras Mili atiende, con número conocido: no pregunta "¿Hablo con…?" y avisa', wa: '5493419990010', regression: '#215 (arreglado 26/10)',
    steps: [
      // The first message is answered once: it goes to the person who was attending.
      { text: 'Buenos días como estás?', expect: { any: [/persona que te venía atendiendo/], none: [/Hablo con/] } },
      { text: 'sisi la idea es transferir entre hoy y lunes', expect: { silent: true, none: [/Hablo con/] } },
    ],
    db: [handoffs('aviso a quien atendía', (r) => r.length >= 1)],
  },
  {
    id: 'R10', area: 'Revisión 26/10 · Oficina', name: '"¿Hablo con Mili?": no, es Nico, y le avisa a Mili', wa: rwa(), regression: '#282 (arreglado 26/10)',
    steps: [{ text: 'Hola, ¿hablo con Mili?', expect: { any: [/No, por ahora hablás con \*Nico\*/i, /Ya le avisé a Mili/] } }],
    db: [handoffs('aviso para Mili', (r) => r.some(([b]) => /Mensaje para Mili/.test(b)))],
  },
  {
    id: 'R10b', area: 'Revisión 26/10 · Oficina', name: '"Quiero hablar con Mili" no es una pregunta: solo avisa', wa: rwa(), regression: '#282 (arreglado 26/10)',
    steps: [{ text: 'Quiero hablar con Mili', expect: { any: [/Ya le avisé a Mili/], none: [/No, por ahora/] } }],
  },
  {
    id: 'R11', area: 'Revisión 26/10 · Oficina', name: 'Cupón mandado por la oficina ayer y "¿este no se realizó por débito?"', wa: '5493419990122', regression: '#242',
    steps: [{ text: 'Buenas tardes, este no se realizó por débito automático?', expect: { any: [/Le pasé tu consulta a la persona de la oficina/], none: [/Estado de cuenta/, /en proceso de débito/] } }],
  },
  {
    id: 'R12', area: 'Revisión 26/10 · Oficina', name: 'Foto mientras la oficina conversa: se calla y la guarda', wa: rwa(), regression: '#172',
    steps: [
      { text: 'Hola' },
      { echo: 'Pasame la foto de la tarjeta', expect: { silent: true } },
      { image: true, expect: { silent: true } },
    ],
    db: [{ name: 'foto guardada', sql: "SELECT COUNT(*) FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.waId='$WA' AND m.role='user' AND m.content LIKE '%foto%'", test: (r) => Number(r[0][0]) >= 1 }],
  },
  {
    id: 'R13', area: 'Revisión 26/10 · Oficina', name: 'Chat con el bot pausado: no contesta y guarda', wa: '5493419990121', regression: '#87',
    steps: [{ text: 'Hola', expect: { silent: true } }],
    db: [{ name: 'mensaje guardado', sql: "SELECT COUNT(*) FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.waId='$WA' AND m.content='Hola'", test: (r) => r[0][0] === '1' }],
  },
  {
    id: 'R14', area: 'Revisión 26/10 · Oficina', name: 'La oficina pide el comprobante y llega un PDF: no pregunta para qué es', wa: rwa(), regression: '#235',
    steps: [
      { text: 'Hola' },
      { echo: 'si transferís pasame el comprobante', expect: { silent: true } },
      { pdf: 'comprobante_123.pdf', max: 20000, expect: { none: [/Contame para qué/] } },
    ],
  },
  {
    id: 'R15', area: 'Revisión 26/10 · Oficina', name: '"Gracias, saludos" después de que atendió la oficina: se calla', wa: rwa(), regression: '#111, #253',
    steps: [
      { text: 'Hola' },
      { echo: 'Aplicado, muchas gracias', expect: { silent: true } },
      { text: 'Gracias, saludos', expect: { silent: true } },
    ],
  },
  {
    id: 'R16', area: 'Revisión 26/10 · Oficina', name: 'Insulto suelto después de una charla con la oficina: no lo pasa como consulta', wa: '5493419990124', regression: '#233', known: 'a definir: hoy lo pasa como "Consulta sobre lo que venía viendo la oficina"',
    steps: [{ text: 'trolo' }],
    db: [handoffs('sin aviso con el insulto', (r) => !r.some(([b]) => /trolo/.test(b)))],
  },

  // Pagos y cupones
  {
    id: 'R17', area: 'Revisión 26/10 · Pagos', name: '"Se me cobró dos veces": avisa a la oficina del cobro doble', wa: rwa(), regression: '#124 (arreglado 26/10)',
    steps: [...ident('99000002'), { text: 'Quería consultar porque se me cobró dos veces el seguro este mes', expect: { any: [/Le pasé a la oficina lo del cobro doble/, /Estado de cuenta/] } }],
    db: [handoffs('aviso de cobro doble', (r) => r.some(([b]) => /cobraron de más o dos veces/.test(b)))],
  },
  {
    id: 'R18', area: 'Revisión 26/10 · Pagos', name: '"No se debitó septiembre pero octubre sí": sin debitar y aviso', wa: rwa(), regression: '#269',
    steps: [...ident('99000002'), { text: 'No sé por qué no se debitó la de septiembre y la de octubre sí', expect: { any: [/sin debitar/, /Ya le avisé a la oficina/], none: [/en proceso/] } }],
  },
  {
    id: 'R19', area: 'Revisión 26/10 · Pagos', name: 'Quitar el débito y pagar a mano: cambio de forma de pago a la oficina', wa: rwa(), regression: '#259',
    steps: [...ident('99000002'), { text: 'Habrá forma de quitar el débito automático? Lo pago yo manualmente cuando cobro', expect: { any: [/cambiar la forma de pago/] } }],
    db: [handoffs('aviso de forma de pago', (r) => r.some(([b]) => /forma de pago/i.test(b)))],
  },
  {
    id: 'R20', area: 'Revisión 26/10 · Pagos', name: '"Si paso plata al banco, ¿no me lo debitan?" con débito al día: no ofrece transferir', wa: rwa(), regression: '#246',
    steps: [...ident('99000001'), { text: 'Si paso plata al banco, ¿no me lo debitan?', expect: { any: [/débito/i], none: [/transferir/, /alias/i] } }],
  },
  {
    id: 'R21', area: 'Revisión 26/10 · Pagos', name: '"Ya pagué, ¿me lo vuelven a cobrar?": sin promesas', wa: rwa(), regression: '#132',
    steps: [...ident('99000001'), { text: 'Ya pagué, ¿me lo vuelven a cobrar por la tarjeta?', max: 60000, expect: { reply: true, none: [promise] } }],
  },
  {
    id: 'R22', area: 'Revisión 26/10 · Pagos', name: '"Pago de cuota" y después la foto del comprobante: a la oficina', wa: rwa(), regression: '#163',
    steps: [...ident('99000002'), { text: 'Pago de cuota' }, { image: true, receipt: true, max: 60000, expect: { any: [/pasé a la oficina|Le pasé el comprobante/] } }],
    db: [handoffs('aviso del comprobante', (r) => r.some(([b]) => /comprobante/i.test(b)))],
  },
  {
    id: 'R23', area: 'Revisión 26/10 · Pagos', name: '"Boletas de pago" son los cupones', wa: rwa(), regression: '#299 (arreglado 26/10)',
    steps: [...ident('99000001'), { text: 'Necesito que me pases las boletas de pago', expect: { any: [/cupones de pago te los manda la oficina/i], none: [/Qué documento/] } }],
  },
  {
    id: 'R23b', area: 'Revisión 26/10 · Pagos', name: '"Talonario de pago" son los cupones', wa: rwa(), regression: '#282 (arreglado 26/10)',
    steps: [...ident('99000001'), { text: 'Me podés pasar el talonario de pago', expect: { any: [/cupones de pago te los manda la oficina/i], none: [/Qué documento/] } }],
  },
  {
    id: 'R24', area: 'Revisión 26/10 · Pagos', name: 'Número de póliza escrito en la lista de cupones', wa: rwa(), regression: '#286 (arreglado 26/10)',
    steps: [
      ...ident('99000011'),
      { select: 'm_pagos', title: '💳 Pagos y cobranzas', list: true },
      { select: 'm_cupones', title: 'Cupones de pago', list: true, expect: { any: [/pol_\d+/] } },
      { text: '9900022', expect: { any: [/cupones de pago/i], none: [/No reconocí/] } },
    ],
    db: [handoffs('aviso de cupones de la moto', (r) => r.some(([b]) => /moto|9900022|XTZ|Z912AAA/i.test(b)))],
  },
  {
    id: 'R25', area: 'Revisión 26/10 · Pagos', name: 'Tap tardío de "Sí, soy X" después de identificarse por patente: no repite el pedido', wa: '5493419990013', regression: '#292 (arreglado 26/10)',
    steps: [
      { text: 'Hola', expect: { any: [/Hablo con \*Silvia\*/] } },
      { text: 'Me pueden enviar la cuponera', expect: { any: [/Antes confirmame/] } },
      { text: 'ZZ915AA', expect: { any: [/te identifiqué/i, /cupones de pago/i] } },
      { select: 'id_phone_si', title: 'Sí, soy Silvia', expect: { any: [/Perfecto 👍/], none: [/cupones de pago de tu/] } },
    ],
    db: [handoffs('un solo aviso', (r) => r.length === 1)],
  },
  {
    id: 'R26', area: 'Revisión 26/10 · Pagos', name: 'Cupón fuera de horario: lo dice y da los datos para transferir (solo después de las 16 o fin de semana)', wa: rwa(), regression: '#278, #292',
    // Mariela: one auto with a pending installment (the offer is for the next one).
    steps: [...ident('99000010'), { text: 'me pasás el cupón de pago?', expect: { any: [/fuera de horario/i, /transferir/] } }],
  },
  {
    id: 'R27', area: 'Revisión 26/10 · Pagos', name: '"¿Cuánto es en total?" con dos pólizas rechazadas: cada cuota con su importe', wa: rwa(), regression: '#172',
    steps: [
      ...ident('99000012'),
      { text: 'Necesito el cupón para pagar las cuotas que me rechazaron', expect: { any: [/transferir/] } },
      { text: 'Decime cuánto es en total', max: 60000, expect: { any: [/61\.000/, /19\.000/] } },
    ],
  },
  {
    id: 'R28', area: 'Revisión 26/10 · Pagos', name: '"¿Hasta cuándo se puede pagar?" con un rechazo: plazo y aviso', wa: rwa(), regression: '#297',
    steps: [...ident('99000004'), { text: '¿Hasta cuándo se puede pagar?', expect: { any: [/Hasta cuándo pagar/, /Ya le avisé a la oficina/] } }],
  },

  // Documentación
  {
    id: 'R29', area: 'Revisión 26/10 · Documentación', name: 'Dos papeles en el primer mensaje con la patente: manda los dos', wa: rwa(), regression: '#286', known: 'manda solo el certificado',
    steps: [{ text: 'Hola buenos días me pasarías certificado de cobertura y póliza del onix ZZ901AA que me chocaron', expect: { any: [/te identifiqué/i], docs: 2 } }],
  },
  {
    id: 'R30', area: 'Revisión 26/10 · Documentación', name: 'Póliza "a mi mail": la manda por el chat sin prometer el mail', wa: rwa(), regression: '#186',
    steps: [{ text: 'Podrías enviarme la póliza de mi auto ZZ901AA a mi mail nombre@ejemplo.com', expect: { any: [/\[documento Póliza/], none: [promise, /te la (env[ií]o|mando) (al|por) mail/i] } }],
  },
  {
    id: 'R31', area: 'Revisión 26/10 · Documentación', name: 'Documentos de todas las pólizas', wa: rwa(), regression: '#129, #238', known: 'Documentación no ofrece "Todas mis pólizas" (pol_todas solo está en cupones)',
    steps: [
      ...ident('99000011'),
      { select: 'm_documentos', title: '📄 Documentación', list: true, expect: { any: [/pol_todas/] } },
      { select: 'pol_todas', title: 'Todas mis pólizas', list: true, expect: { any: [/doc_todos/] } },
      { select: 'doc_todos', title: 'Todos los documentos', list: true, expect: { any: [/\[documento [^\]]*ZZ911AA/, /\[documento [^\]]*Z912AAA/] } },
    ],
  },
  {
    id: 'R32', area: 'Revisión 26/10 · Documentación', name: '"La del Mercosur no, la cédula para circular": aclara que es la misma', wa: rwa(), regression: '#220',
    steps: [
      ...ident('99000001'),
      { text: 'me podrias enviar la tarjeta de circulación', expect: { any: [/\[documento Tarjeta verde/] } },
      { text: 'No, la del Mercosur no, la cédula para circular por la ciudad', max: 60000, expect: { any: [/tarjeta de circulación/i], none: [/\[documento/] } },
    ],
  },
  {
    id: 'R33', area: 'Revisión 26/10 · Documentación', name: '"Necesito el recibo porque pagué por transferencia": constancia de pago', wa: rwa(), regression: '#157',
    steps: [...ident('99000001'), { text: 'Tengo que tener el recibo porque pagué por transferencia pero no tengo lo que emiten ustedes', expect: { any: [/\[documento Constancia de pago/], none: [/Estado de cuenta/] } }],
  },

  // Siniestros
  {
    id: 'R34', area: 'Revisión 26/10 · Siniestros', name: 'Datos del tercero escritos en el paso de confirmación', wa: rwa(), regression: '#289, #286 (arreglado 26/10)',
    steps: [
      ...ident('99000001'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { select: 'sin_nueva', title: 'Denuncia nueva' },
      { text: 'Ayer a las 15 en Rosario, en Mendoza 1500, iba hacia el oeste, me chocó otro auto de costado en la esquina. Iba solo, sin lesionados. Los datos del otro auto te los paso después', max: 60000 },
      { drive: { max: 2, until: /\|confirmar\]/, answer: () => ({ text: 'No los tengo ahora' }), expect: { any: [/\|confirmar\]/] } } },
      { text: 'VW Tiguan ZZ988AA, Diego Prueba DNI 99000099, asegurado en Sancor', max: 60000, expect: { any: [/Anoté eso/, /ZZ988AA/, /\|confirmar\]/], none: [/no te estoy entendiendo/i] } },
      { select: 'confirmar', title: 'Confirmar', expect: { any: [/Registré tu denuncia/] } },
    ],
    db: [{ name: 'tercero en la denuncia', sql: "SELECT COUNT(*) FROM Claim cl JOIN Client c ON c.id=cl.clientId WHERE c.dni='99000001' AND cl.description LIKE '%ZZ988AA%'", test: (r) => Number(r[0][0]) >= 1 }],
  },
  {
    id: 'R35', area: 'Revisión 26/10 · Siniestros', name: 'Gestora denuncia por otro titular con texto pegado de WhatsApp', wa: '5493419990009', regression: '#159',
    steps: [
      { text: 'Hola', expect: { any: [/Hablo con \*Carla\*/] } },
      { select: 'id_phone_no', title: 'No, soy otra persona' },
      { select: 'cliente', title: 'Sí, soy cliente' },
      { text: '99000001', expect: { any: [/te identifiqué/i] } },
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { select: 'sin_nueva', title: 'Denuncia nueva', expect: { any: [/Respondé todo en un solo mensaje/] } },
      { text: '[11:02 a. m., 21/10/2026] Laura: El 20/10 a las 19 hs en Rosario, en San Lorenzo 1200, iba hacia el este\n[11:03 a. m., 21/10/2026] Laura: Me chocó de atrás un Peugeot 208 patente ZZ977BB, conductor Pedro Gómez, seguro Federación Patronal. Iba sola, sin lesionados', max: 60000, expect: { any: [/Revisá la denuncia/, /San Lorenzo/, /ZZ977BB/], none: [/\[11:0/] } },
      { select: 'confirmar', title: 'Confirmar', expect: { any: [/Registré tu denuncia/] } },
    ],
    db: [{ name: 'descripción sin los prefijos de WhatsApp', sql: "SELECT cl.description NOT LIKE '%[11:0%' FROM Claim cl JOIN Client c ON c.id=cl.clientId WHERE c.dni='99000001' AND cl.description LIKE '%San Lorenzo%'", test: (r) => r.length === 1 && r[0][0] === '1' }],
  },
  {
    id: 'R36', area: 'Revisión 26/10 · Siniestros', name: '"Rocé un auto" → "Te paso los datos" → "Sí, soy…": sigue en Siniestros', wa: '5493419990011', regression: '#289',
    steps: [
      { text: 'Ayer rocé un auto en una cochera', expect: { any: [/sin_nueva|Hablo con|DNI/] } },
      { text: 'Te paso los datos', expect: { any: [/Respondé todo|Sobre qué póliza|La denuncia es sobre|Hablo con|DNI/], none: [/Consultar una/] } },
      {
        drive: {
          max: 3,
          until: /Respondé todo|Sobre qué póliza|La denuncia es sobre/,
          answer: (prev) => /\|sin_nueva\]/.test(prev) ? { select: 'sin_nueva', title: 'Denuncia nueva' }
            : /\|id_phone_si\]/.test(prev) ? { select: 'id_phone_si', title: 'Sí, soy Fabián' }
              : /DNI/.test(prev) ? { text: '99000011' } : null,
          expect: { any: [/Sobre qué póliza|La denuncia es sobre|Respondé todo/], none: [/m_pagos/] },
        },
      },
    ],
  },
  {
    id: 'R37', area: 'Revisión 26/10 · Siniestros', name: 'Denuncia de choque con la oficina de hace 3 días: abre el flujo', wa: '5493419990123', regression: '#286', known: 'a decidir: hoy va a la oficina ("Le pasé tu consulta…")',
    steps: [{ text: 'Hola buenos días, por una denuncia de choque tengo que ir o te puedo pasar los datos?', expect: { any: [/DNI|denuncia/i], none: [/Le pasé tu consulta a la persona/] } }],
  },
  {
    id: 'R38', area: 'Revisión 26/10 · Siniestros', name: 'Robo parcial estacionado: no pide sentido de circulación', wa: rwa(), regression: '#92', known: 'la lista siempre pide sentido y personas',
    steps: [
      ...ident('99000001'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { select: 'sin_nueva', title: 'Denuncia nueva' },
      { text: 'No fue un choque, me robaron el techo corredizo estacionado en Mitre 900, Rosario, 12/10 a la noche', max: 60000, expect: { any: [/\|confirmar\]/], none: [/circulabas|Sentido de circulación/i] } },
    ],
  },
  {
    id: 'R39', area: 'Revisión 26/10 · Siniestros', name: '"¿Me cubren los días de trabajo perdidos?": consulta a la oficina, no denuncia', wa: rwa(), regression: '#119, #120',
    steps: [...ident('99000001'), { text: 'Quiero saber si con esto del siniestro me cubren algo por los días perdidos de trabajo', max: 60000, expect: { any: [/oficina|tomé nota/i], none: [/Respondé todo en un solo mensaje/] } }],
  },
  {
    id: 'R40', area: 'Revisión 26/10 · Siniestros', name: 'Altura desconocida dos veces y localidad fuera de Rosario', wa: rwa(), regression: '#286',
    steps: [
      ...ident('99000001'),
      { select: 'm_siniestros', title: '🛡️ Siniestros', list: true },
      { select: 'sin_nueva', title: 'Denuncia nueva' },
      { text: 'Fue ayer a las 8 en Buenos Aires, en la bajada de la autopista Arturo Frondizi y Av Suárez, iba hacia el sur, me chocó de atrás un camión que se fue. Iba solo, sin heridos', max: 60000 },
      { drive: { max: 3, until: /\|confirmar\]/, answer: () => ({ text: 'No sé' }), expect: { any: [/Arturo Frondizi s\/n/, /Localidad: Buenos Aires/] } } },
    ],
  },

  // Cotización
  {
    id: 'R41', area: 'Revisión 26/10 · Cotización', name: 'Fotos en medio de la cotización: avisa una vez y repite qué necesita', wa: rwa(), regression: '#232 (arreglado 26/10)',
    steps: [
      { text: 'Quiero cotizar una moto', expect: { any: [/marca, modelo/] } },
      { image: true, expect: { any: [/📸 Recibí/, /Para cotizar necesito/] } },
      { image: true, expect: { silent: true } },
    ],
  },
  {
    id: 'R42', area: 'Revisión 26/10 · Cotización', name: '"Sacar el seguro de la otra compañía y poner el de ustedes": cotiza', wa: rwa(), regression: '#295 (arreglado 26/10)',
    steps: [
      { text: 'Hola' },
      { select: 'no_cliente', title: 'Todavía no' },
      { text: 'Necesito cambiar el seguro, tengo un auto 0km y quiero retirar el seguro de la compañía y poner el de ustedes', expect: { any: [/marca, modelo/], none: [/DNI/] } },
      { text: 'Volkswagen Gol Trend 1.6 2015, código postal 2000', max: 90000, quiet: 5000 },
      { drive: { max: 4, until: /por mes/, answer: quoteAnswer('Volkswagen Gol Trend 1.6 2015, Rosario'), expect: { any: [/por mes/] } } },
    ],
  },
  {
    id: 'R43', area: 'Revisión 26/10 · Cotización', name: 'Cliente identificado cotiza otro auto sin dar localidad (documenta si pide el CP)', wa: rwa(), regression: '#255',
    steps: [
      ...ident('99000001'),
      { text: 'Quisiera saber el precio para asegurar un auto', expect: { any: [/marca/i] } },
      { text: 'Palio 1.6 modelo 98 5p con GNC', max: 90000, quiet: 5000 },
      { drive: { max: 4, until: /por mes/, answer: quoteAnswer('Fiat Palio 1.6 1998 5 puertas', true), expect: { any: [/por mes/] } } },
    ],
  },
  {
    id: 'R44', area: 'Revisión 26/10 · Cotización', name: 'Versión vieja sin precio en InfoAuto: cotiza solo RC y avisa', wa: rwa(), regression: '#263 (mejora #112)',
    steps: [
      { text: 'Hola, quiero cotizar una Toyota Hilux 1996, cp 2000', max: 90000, quiet: 5000 },
      { drive: { max: 4, until: /por mes|no se puede cotizar/, answer: quoteAnswer('Toyota Hilux 1996, código postal 2000', false, '2'), expect: { any: [/Responsabilidad Civil/, /por mes/], none: [/no se puede cotizar online/] } } },
    ],
    db: [handoffs('aviso de valuación', (r) => r.some(([b]) => /valua|sin precio/i.test(b)))],
  },
  {
    id: 'R45', area: 'Revisión 26/10 · Cotización', name: '"La quiero" sin decir cuál cobertura: pregunta cuál', wa: rwa(), regression: '#274', known: 'anota la última cobertura (B1)',
    steps: [
      { text: 'Hola quiero cotizar una moto Honda Wave 110 2023, soy de Rosario', max: 90000, quiet: 5000 },
      { drive: { max: 4, until: /por mes/, answer: quoteAnswer('Honda Wave 110 S 2023, código postal 2000'), expect: { any: [/por mes/] } } },
      { text: 'La quiero', expect: { any: [/cu[aá]l (cobertura|de las|te interesa|quer[eé]s)/i] } },
    ],
  },
  {
    id: 'R46', area: 'Revisión 26/10 · Cotización', name: '"¿Tiene GNC?" → "Solo" → "No" → "El gas es para la cocina"', wa: rwa(), regression: '#276',
    steps: [
      { text: 'Hola quiero cotizar un auto Volkswagen Gol Trend 1.6 2015, código postal 2000', max: 90000, quiet: 5000 },
      { drive: { max: 5, until: /\|gnc_no\]/, answer: (prev) => /\|gnc_no\]/.test(prev) ? null : quoteAnswer('Volkswagen Gol Trend 1.6 2015, Rosario')(prev), expect: { any: [/\|gnc_no\]/] } } },
      { text: 'Solo', expect: { any: [/GNC/] , none: [/por mes/] } },
      { text: 'No', max: 90000, quiet: 5000, expect: { any: [/por mes/] } },
      { text: 'El gas es para la cocina', expect: { reply: true, none: [/por mes/] } },
    ],
  },
  {
    id: 'R47', area: 'Revisión 26/10 · Cotización', name: '"¿Realizan pólizas para automóviles?" y después "¿Qué seguro es?"', wa: rwa(), regression: '#276, #250',
    steps: [
      { text: 'Hola, ¿realizan pólizas para automóviles?', expect: { any: [/marca, modelo/] } },
      { text: 'Volkswagen Gol Trend 1.6 2015, código postal 2000', max: 90000, quiet: 5000 },
      { drive: { max: 6, until: /por mes/, answer: quoteAnswer('Volkswagen Gol Trend 1.6 2015, Rosario'), expect: { any: [/por mes/] } } },
      { text: 'Que seguro es', expect: { any: [/Triunfo/] } },
    ],
  },
  {
    id: 'R48', area: 'Revisión 26/10 · Cotización', name: 'Lead de bicicleta: ofrece usar el número del chat en vez de pedir el teléfono', wa: rwa(), regression: '#288', known: 'pide un teléfono que ya tiene',
    steps: [
      { text: 'Hola' },
      { select: 'no_cliente', title: 'Todavía no' },
      { select: 'l_cotizar', title: '💰 Cotizar un seguro', list: true },
      { select: 'cot_bici', title: 'Bicicleta', list: true },
      {
        drive: {
          max: 6,
          until: /tel[eé]fono|este n[uú]mero/i,
          answer: (prev) => {
            const opt = prev.match(/\[[^|\]]+\|((?!m_|l_|finalizar|menu)[a-z0-9_]+)\]/);
            if (opt) return { select: opt[1], title: opt[1], list: true };
            if (/nombre/i.test(prev)) return { text: 'Juan Prueba' };
            if (/valor|precio|monto|suma/i.test(prev)) return { text: '800000' };
            if (/marca/i.test(prev)) return { text: 'Venzo' };
            return { text: 'Mountain bike rodado 29' };
          },
          expect: { any: [/este n[uú]mero/i] },
        },
      },
    ],
  },

  // Bajas y trámites
  {
    id: 'R49', area: 'Revisión 26/10 · Bajas', name: 'Baja con motivo: lo pregunta y lo manda en el aviso', wa: rwa(), regression: '#266, #271 (mejora #113)',
    steps: [
      ...ident('99000001'),
      { select: 'm_baja_poliza', title: 'Baja de póliza', list: true, expect: { any: [/Solicitar baja/] } },
      { select: 'confirmar', title: 'Solicitar baja', expect: { any: [/motivo/i, /bm_venta/] } },
      { select: 'bm_venta', title: 'Vendí el vehículo', list: true, expect: { any: [/todavía no fue dada de baja|Registré tu solicitud de baja/] } },
    ],
    db: [{ name: 'baja con motivo', sql: "SELECT COUNT(*) FROM Notification n JOIN Conversation c ON c.id=n.refId WHERE c.waId='$WA' AND n.type='baja_poliza' AND n.body LIKE '%Motivo:%'", test: (r) => r[0][0] === '1' }],
  },
  {
    id: 'R50', area: 'Revisión 26/10 · Bajas', name: '"Dar de baja la moto y dar de alta otra": primero la baja, después cotiza', wa: rwa(), regression: '#124',
    steps: [
      ...ident('99000002'),
      { text: 'Quería dar de baja mi seguro de la moto y dar de alta otra moto', expect: { any: [/baja/i] } },
      { drive: { max: 2, until: /Solicitar baja|\|confirmar\]/, answer: (prev) => { const pol = prev.match(/\[HONDA STORM\|(pol_\d+)\]/); return pol ? { select: pol[1], title: 'HONDA STORM', list: true } : /baja_si/.test(prev) ? { select: 'baja_si', title: 'Sí' } : null; }, expect: { any: [/STORM|9900003/] } } },
      { select: 'confirmar', title: 'Solicitar baja', expect: { any: [/motivo/i] } },
      { select: 'bm_venta', title: 'Vendí el vehículo', list: true, expect: { any: [/todavía no fue dada de baja|Registré tu solicitud de baja/] } },
      { text: 'Ahora la nueva moto', expect: { any: [/marca/i] } },
    ],
  },
  {
    id: 'R51', area: 'Revisión 26/10 · Bajas', name: 'Baja de accidentes personales (no la ve): a la oficina', wa: rwa(), regression: '#149, #156',
    steps: [...ident('99000001'), { text: 'Quería dar de baja el seguro de accidentes personales', expect: { any: [/pasé tu pedido|tomé nota|oficina/i], none: [/De qué póliza querés solicitar la baja/, /Solicitar baja/] } }],
  },
  {
    id: 'R52', area: 'Revisión 26/10 · Bajas', name: '"Es otra moto": pregunta cuál y avisa', wa: rwa(), regression: '#264 (arreglado 26/10)',
    steps: [
      ...ident('99000011'),
      { text: 'Es otra moto', expect: { any: [/Contame cuál es/] } },
      { text: 'Es la moto de mi sobrina, patente ZZ977AA', expect: { reply: true } },
    ],
    db: [handoffs('aviso de otro vehículo', (r) => r.some(([b]) => /Habla de otra póliza o vehículo/.test(b)))],
  },
  {
    id: 'R53', area: 'Revisión 26/10 · Bajas', name: 'Pedido de AP de Sancor con CUIT y cláusula: a la oficina con el texto completo', wa: rwa(), regression: '#107, #108, #144',
    steps: [{ text: 'Incorporame a este muchacho a la AP de Sancor, CUIT 30712345671, cláusula de no repetición', max: 60000, expect: { reply: true, none: [/DNI del titular/] } }],
    db: [handoffs('aviso con la cláusula', (r) => r.some(([b]) => /no repetición/.test(b)))],
  },

  // ─── Inactividad (etapa aparte, timeout local de 2 min) ──────────
  {
    id: 'I01', stage: 'inactivity', afterIdle: { goodbye: true }, area: 'Inactividad', name: 'Charla común: cierre por inactividad guardado en el panel', wa: wa(),
    steps: [{ text: 'Hola', expect: { any: [/ya sos cliente/i] } }],
  },
  {
    id: 'I02', stage: 'inactivity', afterIdle: { goodbye: false }, area: 'Inactividad', name: 'Con pedido a la oficina: no manda el cierre', wa: wa(), regression: '#187/#195 (14/10)',
    steps: [...ident('99000004'), { select: 'm_documentos', title: '📄 Documentación', list: true, expect: { any: [/No tengo los documentos/] } }],
  },
];
