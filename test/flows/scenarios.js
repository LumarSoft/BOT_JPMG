// Full-flow scenarios (npm run test:flows). Synthetic data only (data/seed.sql):
// DNI 99000001 Ana (1 auto, al día, phone → waId 5493419990001), 99000002 Lucas
// (auto plan de pago + moto con débito en proceso, waId 5493419990002), CUIT
// 30712345671 empresa (2 camiones), 99000004 Marta (débito rechazado), 99000006
// Gustavo (1 auto, waId 5493419990006), 99000008 Jorge (no policies, waId
// 5493419990008, says he is someone else), and a chat the office answered by hand
// (waId 5493419990120).
//
// Each scenario: `steps` are what the customer (or the office, `echo`) sends;
// `expect` checks what the bot answered to that step (`any`/`none` regexes,
// `silent`, `count`, `reply`); `db` checks the database afterwards ($WA is the
// scenario's number). `drive` answers a model-led quote until `until` shows up.
// `regression` names the real chat a case comes from; `known` marks a gap not
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
      { select: 'sin_consultar', title: 'Consultar una', expect: { any: [/No tenés denuncias/i] } },
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
      { select: 'confirmar', title: 'Solicitar baja', expect: { any: [/Registré tu solicitud de baja/, /m_siniestros/] } },
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
      { select: 'confirmar', title: 'Confirmar', expect: { any: [/Registré tu denuncia/, /tarjeta verde/] } },
      { image: true, expect: { any: [/carnet de conducir/], count: 1 } },
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
      { text: '99000002', expect: { any: [/No tenés denuncias/i], none: [/Respondé todo/] } },
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

  // ─── Pendientes conocidos (no implementados todavía) ─────────────
  {
    id: 'G01', area: 'Pendientes conocidos', name: 'Respuesta automática de otra empresa: no contestar', wa: wa(), regression: '#118', known: 'guard anti-autorespuestas (pendiente)',
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
