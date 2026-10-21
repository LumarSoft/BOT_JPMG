import type { EstadoCuentaPoliza, PolizaSummary } from '../../api/api.types';
import { fold } from '../text';
import {
  displayName,
  formatEstadoCuenta,
  gncAnswer,
  paymentAnswer,
  gncButtons,
  leadMenu,
  polizaPicker,
  returningGreeting,
  toWhatsAppMarkdown,
  DEBIT_FAILED_RE,
  debitNotDone,
  CLAIM_COPY_RE,
  CLAIMS_PHONE_RE,
  coverageSummary,
  docPicker,
  formatSiniestros,
  polizaTitles,
  transferOffer,
} from './flow.messages';

describe('leadMenu', () => {
  it('does not introduce the bot a second time after the welcome', () => {
    const message = leadMenu();

    expect(message.body).toBe('Perfecto, ¿con qué te puedo ayudar?');
    expect(message.body).not.toContain('Soy');
    expect(message.body).not.toContain('asistente');
  });
});

const ranger: EstadoCuentaPoliza = {
  id: 2,
  certificateNumber: '1905860',
  riskType: 'auto',
  lastMovement: 'VIGENTE',
  paymentMethod: null,
  vehicle: {
    licensePlate: 'AH070ZY',
    brand: 'FORD',
    model: 'RANGER 3.0 TDI DC 4X4',
  },
  paidInstallments: 1,
  unpaidInstallments: [],
  hasRejectedInstallments: false,
};

const sinVehiculo: EstadoCuentaPoliza = {
  id: 1,
  certificateNumber: '1045599',
  riskType: 'other',
  lastMovement: 'VIGENTE',
  paymentMethod: null,
  vehicle: null,
  paidInstallments: 0,
  unpaidInstallments: [
    {
      number: 3,
      amount: '19754',
      dueDate: '2026-07-23',
      status: 'overdue',
    },
  ],
  hasRejectedInstallments: false,
};

describe('formatEstadoCuenta', () => {
  it('heads each policy with the insured asset, not the certificate number', () => {
    const text = formatEstadoCuenta([ranger]);

    expect(text).toContain('*FORD RANGER 3.0 TDI DC 4X4*');
    // The certificate stays as a secondary reference, with the plate.
    expect(text).toContain('_Póliza 1905860 · AH070ZY_');
    expect(text).not.toMatch(/^\*Póliza/m);
  });

  it('falls back to a human risk label when the policy has no vehicle', () => {
    const text = formatEstadoCuenta([sinVehiculo]);

    expect(text).toContain('*Otro riesgo*');
    expect(text).not.toContain('other');
  });
});

describe('polizaPicker', () => {
  it('labels rows by vehicle and never leaks the raw risk type', () => {
    const polizas = [
      { ...ranger, vehicle: ranger.vehicle } as unknown as PolizaSummary,
      { ...sinVehiculo, vehicle: null } as unknown as PolizaSummary,
    ];

    const message = polizaPicker(polizas, '¿Sobre qué póliza?');
    if (message.kind !== 'list') throw new Error('expected a list');

    expect(message.rows[0].title).toBe('FORD RANGER 3.0 TDI DC 4X4');
    expect(message.rows[0].description).toBe('Póliza 1905860 · AH070ZY');
    expect(message.rows[1].title).toBe('Otro riesgo');
  });
});

describe('displayName', () => {
  it('uses the first given name in normal casing (the cartera shouts them)', () => {
    expect(displayName('EVELYN ELIZABETH')).toBe('Evelyn');
    expect(displayName('josé maría')).toBe('José');
    expect(displayName('ANA-LUCÍA PÉREZ')).toBe('Ana-Lucía');
  });

  it('returns null for a company, so it is not greeted by "name"', () => {
    expect(displayName('JOHN PELLEGRINI MANAGEMENT GROUP SRL')).toBeNull();
    expect(displayName('TRANSPORTES DEL SUR S.A.')).toBeNull();
    expect(displayName('   ')).toBeNull();
  });

  it('does not mistake a person for a company', () => {
    expect(displayName('SARA GOMEZ')).toBe('Sara');
    expect(displayName('ROSA SANTIAGO')).toBe('Rosa');
  });

  it('greets without a name when there is no usable one', () => {
    expect(returningGreeting('EVELYN ELIZABETH')).toBe(
      '¡Hola de nuevo, Evelyn!',
    );
    expect(returningGreeting('JOHN PELLEGRINI MANAGEMENT GROUP SRL')).toBe(
      '¡Hola de nuevo!',
    );
  });
});

describe('toWhatsAppMarkdown', () => {
  it('converts standard markdown bold to WhatsApp bold', () => {
    expect(toWhatsAppMarkdown('1. **Cobertura A**: $65.976')).toBe(
      '1. *Cobertura A*: $65.976',
    );
    expect(toWhatsAppMarkdown('__Todo Riesgo__')).toBe('*Todo Riesgo*');
  });

  it('rewrites headings and bullets', () => {
    expect(toWhatsAppMarkdown('## Coberturas\n- Robo\n- Incendio')).toBe(
      '*Coberturas*\n• Robo\n• Incendio',
    );
  });

  it('leaves WhatsApp bold and bare asterisks alone', () => {
    expect(toWhatsAppMarkdown('El *GNC* no afecta el precio')).toBe(
      'El *GNC* no afecta el precio',
    );
  });
});

describe('gncButtons', () => {
  it('renders the GNC question as reply buttons', () => {
    const message = gncButtons(
      'Ya tengo la información de tu Peugeot 308 HDI Feline 2020.\n\n' +
        'Ahora, necesito saber si tu vehículo tiene *GNC* (sí/no).\n¿Tu auto tiene GNC?',
    );

    expect(message?.kind).toBe('buttons');
    if (message?.kind !== 'buttons') throw new Error('expected buttons');
    expect(message.body).not.toContain('(sí/no)');
    expect(message.buttons.map((b) => b.id)).toEqual(['gnc_si', 'gnc_no']);
  });

  it('leaves the reply as text when the last question is not about GNC', () => {
    expect(
      gncButtons('Anoté que tiene GNC. ¿Te muestro las coberturas?'),
    ).toBeNull();
  });

  it('does not hijack a message that is still offering a numbered list', () => {
    expect(
      gncButtons(
        'Encontré varias versiones:\n1. ZB 110 AT NEW\n2. ZB 110 SHARK\n\n' +
          'Decime cuál elegís y si tiene GNC (sí/no)?',
      ),
    ).toBeNull();
  });
});

describe('gncAnswer', () => {
  it.each([
    ['Sí, tiene GNC', true],
    ['No tiene GNC', false],
    ['no tiene gnc', false],
    ['Astra 2009, tiene GNC', true],
    ['es a gnc', true],
    ['corsa 2010 sin gnc, cp 2000', false],
    ['¿qué es el GNC?', undefined],
    ['no sé si tiene GNC', undefined],
    ['quiero saber si conviene el gnc', undefined],
    ['2', undefined],
    ['si', undefined],
  ])('reads %s on its own', (text, expected) =>
    expect(gncAnswer(text)).toBe(expected),
  );

  it.each([
    ['si', true],
    ['Sí claro', true],
    ['no', false],
    ['nop', false],
    ['2000', undefined],
  ])('reads %s right after the bot asked', (text, expected) =>
    expect(gncAnswer(text, 'Perfecto. ¿Tu auto tiene GNC?')).toBe(expected),
  );

  it('reads a typed answer to the question as it is stored, with its buttons', () =>
    expect(
      gncAnswer('no', '¿Tu auto tiene GNC?\n[Sí, tiene GNC] [No tiene GNC]'),
    ).toBe(false));

  it('ignores a yes to a question that was not about GNC', () =>
    expect(gncAnswer('si', '¿El código postal es 2000?')).toBeUndefined());
});

describe('account status answers', () => {
  const base: EstadoCuentaPoliza = {
    id: 1,
    certificateNumber: '1000001',
    riskType: 'auto',
    lastMovement: 'REFACTURACION',
    paymentMethod: 'Convenio',
    validTo: '2027-07-27T00:00:00.000Z',
    vehicle: { licensePlate: 'AB123CD', brand: 'FIAT', model: 'PALIO' },
    nextDueDate: '2026-10-27T00:00:00.000Z',
    paidInstallments: 3,
    unpaidInstallments: [],
    hasRejectedInstallments: false,
  };

  it('shows a due date as the calendar day it was stored as', () => {
    const text = formatEstadoCuenta([
      {
        ...base,
        unpaidInstallments: [
          {
            number: 4,
            amount: '100',
            dueDate: '2026-10-06T00:00:00.000Z',
            status: 'pending',
          },
        ],
      },
    ]);
    expect(text).toContain('vence 06/10/2026');
  });

  it('tells when the next installment is due once everything billed is paid', () => {
    const text = formatEstadoCuenta([base]);
    expect(text).toContain('Próxima cuota: vence alrededor del');
    expect(text).toContain('27/10/2026');
    expect(text).toContain('cupón');
  });

  it('announces nothing when there is no next installment to estimate', () => {
    expect(formatEstadoCuenta([{ ...base, nextDueDate: null }])).not.toContain(
      'Próxima cuota',
    );
  });

  it('does not take an unknown payment method for a debit', () => {
    expect(
      paymentAnswer([{ ...base, paymentMethod: null }], 'no se debitó'),
    ).toContain('no tengo registrada su forma de pago');
  });

  it('adds up the overdue coupons but never a debit still being collected', () => {
    const overdue = [
      {
        number: 2,
        amount: '100.50',
        dueDate: '2026-09-06T00:00:00.000Z',
        status: 'overdue',
      },
      {
        number: 3,
        amount: '100.50',
        dueDate: '2026-10-06T00:00:00.000Z',
        status: 'overdue',
      },
    ];
    expect(
      formatEstadoCuenta([{ ...base, unpaidInstallments: overdue }]),
    ).toContain('Total vencido');
    expect(
      formatEstadoCuenta([
        {
          ...base,
          paymentMethod: 'Débito Tarjeta',
          unpaidInstallments: overdue,
        },
      ]),
    ).not.toContain('Total vencido');
  });

  describe('a debit installment past its due date', () => {
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toISOString();
    const debit = (dueDate: string, status = 'overdue') => ({
      ...base,
      paymentMethod: 'Débito Tarjeta',
      unpaidInstallments: [{ number: 1, amount: '21339.00', dueDate, status }],
    });

    it('shows it in process, not overdue, while the bank collects it', () => {
      // A customer read "⚠️ vencida" on a debit that was still in process.
      const text = formatEstadoCuenta([debit(daysAgo(4))]);
      expect(text).toContain('⏳ en proceso de débito');
      expect(text).not.toContain('vencida');
      expect(text).toContain('dejá el dinero disponible');
    });

    it('calls it overdue once it is too old to be in process', () => {
      const text = formatEstadoCuenta([debit(daysAgo(60))]);
      expect(text).toContain('⚠️ vencida');
      expect(text).not.toContain('en proceso de débito');
    });

    it('keeps a rejection as a rejection', () => {
      const text = formatEstadoCuenta([debit(daysAgo(4), 'rejected')]);
      expect(text).toContain('⛔ rechazo de débito');
      expect(text).not.toContain('en proceso');
    });

    it('never shows a coupon installment in process', () => {
      const text = formatEstadoCuenta([
        { ...debit(daysAgo(4)), paymentMethod: 'Convenio' },
      ]);
      expect(text).toContain('⚠️ vencida');
    });

    it('shows nothing in process once the customer says it was not debited', () => {
      const text = formatEstadoCuenta([debit(daysAgo(4))], {
        debitFailed: true,
      });
      expect(text).toContain('⚠️ sin debitar');
      expect(text).not.toContain('en proceso');
      expect(text).not.toContain('dejá el dinero disponible');
      expect(text).toContain('Ya le avisé a la oficina');
      expect(debitNotDone([debit(daysAgo(4))])).toHaveLength(1);
      // A rejection on record is already its own notice.
      expect(
        debitNotDone([
          { ...debit(daysAgo(4), 'rejected'), hasRejectedInstallments: true },
        ]),
      ).toHaveLength(0);
      expect(debitNotDone([base])).toHaveLength(0);
    });

    it('tells a customer whose debit did not go through that the office was told', () => {
      const text = paymentAnswer([debit(daysAgo(4))], 'no se debitó');
      expect(text).toContain('sin debitar');
      expect(text).toContain('Ya le avisé a la oficina');
      expect(text).not.toContain('dejá el dinero disponible');
    });

    it('reads the ways people say a payment failed', () => {
      for (const said of [
        'este no se realizó por débito automático?',
        'me llegó una notificación de que no se pudo realizar el pago',
        'no me debitaron la cuota',
        'rechazaron el débito',
        'pago fallido',
        'falló el pago de octubre',
      ])
        expect(DEBIT_FAILED_RE.test(fold(said))).toBe(true);
      for (const said of [
        'cuánto debo',
        'ya pagué la cuota',
        'quiero el cupón',
      ])
        expect(DEBIT_FAILED_RE.test(fold(said))).toBe(false);
    });

    it('answers "no me aparece" with the debit in process', () => {
      expect(
        paymentAnswer([debit(daysAgo(4))], 'no me aparece la cuota'),
      ).toContain('cuota 1 en proceso de débito');
    });
  });

  it('answers only the two questions the account status alone does not', () => {
    expect(
      paymentAnswer([base], 'no me aparece la cuota para pagar'),
    ).toContain('todavía no se emitió');
    expect(paymentAnswer([base], 'por qué no se debitó?')).toContain(
      'se paga con *cupón*',
    );
    expect(paymentAnswer([base], 'cuánto debo')).toBeNull();
    expect(paymentAnswer([], 'no se debitó')).toBeNull();
  });
});

describe('readable policy lists (#216, #238)', () => {
  const poliza = (over: Partial<PolizaSummary>): PolizaSummary => ({
    id: 1,
    certificateNumber: '1000001',
    company: 'triunfo',
    riskType: 'auto',
    lastMovement: 'REFACTURACION',
    validFrom: null,
    validTo: null,
    paymentMethod: null,
    vehicle: null,
    ...over,
  });

  it('names a non-vehicle policy by its product and shows where it is', () => {
    const list = polizaPicker(
      [
        poliza({ id: 1, riskType: 'other', product: 'Bicicleta' }),
        poliza({
          id: 2,
          riskType: 'home',
          product: 'Hogar',
          place: 'San Martin 4060',
          certificateNumber: '1044644',
        }),
      ],
      '¿Cuál?',
    );
    if (list.kind !== 'list') throw new Error('expected a list');
    expect(list.rows.map((r) => r.title)).toEqual(['Bicicleta', 'Hogar']);
    expect(list.rows[1].description).toBe('Póliza 1044644 · San Martin 4060');
  });

  it('starts a repeated title with what tells them apart, within 24 characters', () => {
    const titles = polizaTitles([
      poliza({
        vehicle: {
          licensePlate: 'AC690RN',
          brand: 'RENAULT',
          model: 'LOGAN II 1.6',
        },
      }),
      poliza({
        vehicle: {
          licensePlate: 'AD973AV',
          brand: 'RENAULT',
          model: 'LOGAN II 1.6',
        },
      }),
      poliza({
        riskType: 'life',
        product: 'Acc. personales',
        certificateNumber: '1205970',
      }),
      poliza({
        riskType: 'life',
        product: 'Acc. personales',
        certificateNumber: '1205971',
      }),
      poliza({ riskType: 'life', product: 'Sepelio' }),
    ]);
    expect(titles[0]).toBe('AC690RN · RENAULT LOGAN…');
    expect(titles[1].startsWith('AD973AV · ')).toBe(true);
    expect(titles[2]).toBe('Acc. personales 1205970');
    expect(titles.every((t) => t.length <= 24)).toBe(true);
    expect(titles[4]).toBe('Sepelio');
  });
});

describe('coverage summary', () => {
  const base: PolizaSummary = {
    id: 1,
    certificateNumber: '3519342',
    company: 'triunfo',
    riskType: 'auto',
    lastMovement: 'REFACTURACION',
    validFrom: null,
    validTo: null,
    paymentMethod: null,
    vehicle: { licensePlate: 'AB123CD', brand: 'FIAT', model: 'CRONOS' },
  };

  it('writes out what a vehicle code includes and leaves out', () => {
    const text = coverageSummary({
      ...base,
      coverage: {
        code: 'C2',
        name: 'Terceros Completo 2',
        benefits: ['Rotura de cristales hasta $500.000'],
        exclusions: ['Daños parciales por accidente'],
        deductible: null,
      },
    });
    expect(text).toContain('*Terceros Completo 2* (C2)');
    expect(text).toContain('• Rotura de cristales hasta $500.000');
    expect(text).toContain('_No incluye:_');
    expect(text).toContain('Hablar con un asesor');
  });

  it('lists what Triunfo covers on a home, with its sums', () => {
    const text = coverageSummary({
      ...base,
      riskType: 'home',
      vehicle: null,
      product: 'Hogar',
      riesgos: [
        { riesgo: 'CRISTALES', cobertura: 'CRISTALES', sumaAsegurada: 300000 },
        { riesgo: 'ROBO', cobertura: 'CONTENIDO GENERAL', sumaAsegurada: null },
      ],
    });
    expect(text).toContain('Tu *Hogar*');
    expect(text).toMatch(/• Cristales — hasta \$\s?300\.000/);
    expect(text).toContain('• Robo · Contenido general');
  });
});

describe('payment rules the office repeats', () => {
  const debit = (
    over: Partial<EstadoCuentaPoliza> = {},
  ): EstadoCuentaPoliza => ({
    id: 1,
    certificateNumber: '1000001',
    riskType: 'auto',
    lastMovement: 'REFACTURACION',
    paymentMethod: 'Convenio',
    vehicle: { licensePlate: 'AB123CD', brand: 'FIAT', model: 'PALIO' },
    paidInstallments: 1,
    unpaidInstallments: [],
    hasRejectedInstallments: false,
    ...over,
  });

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-20T15:00:00Z'));
  });
  afterAll(() => jest.useRealTimers());

  it('says the due date is the limit, never the internal grace or a debit day', () => {
    const text = paymentAnswer(
      [
        debit({
          unpaidInstallments: [
            {
              number: 3,
              amount: '1000',
              dueDate: '2026-10-26T00:00:00.000Z',
              status: 'pending',
            },
          ],
        }),
        debit({
          id: 2,
          vehicle: { licensePlate: 'CD456EF', brand: 'FORD', model: 'KA' },
          unpaidInstallments: [
            {
              number: 2,
              amount: '1000',
              dueDate: '2026-09-02T00:00:00.000Z',
              status: 'overdue',
            },
          ],
        }),
      ],
      '¿hasta cuándo puedo pagar la cuota?',
    );
    expect(text).toContain('hasta el vencimiento de la cuota');
    expect(text).toContain('*FIAT PALIO*: la cuota 3 vence el 26/10/2026');
    expect(text).toContain(
      '*FORD KA*: la cuota 2 venció el 02/09/2026: pagala cuanto antes',
    );
    // John (20/10): the grace the organization gives is not told to the
    // customer, the debit day varies, and the "0 hs" rule is obsolete.
    expect(text).not.toMatch(/del 10|1 y el 10|0 hs/);
  });

  it('tells a debit customer with no rejection there is nothing to pay by hand', () => {
    const onDebit = debit({
      paymentMethod: 'Débito Tarjeta',
      unpaidInstallments: [
        // Old enough to read "vencida" in the statement: still no rejection.
        {
          number: 2,
          amount: '1000',
          dueDate: '2026-08-02T00:00:00.000Z',
          status: 'overdue',
        },
      ],
    });
    const text = paymentAnswer([onDebit], '¿hasta cuándo puedo pagar?');
    expect(text).toContain(
      'se paga por débito automático: no tenés que hacer nada',
    );
    expect(text).not.toContain('pagala cuanto antes');
    expect(text).not.toMatch(/\b(?:14|24)\b|1 y el 10/);
  });

  it('lists the ways to pay and the card discount', () => {
    expect(
      paymentAnswer([debit()], '¿Puedo pagar con Mercado Pago?'),
    ).toContain('Rapipago, Pago Fácil o Santa Fe Servicios');
    expect(
      paymentAnswer(
        [debit()],
        '¿Es el mismo precio con cupón que con tarjeta?',
      ),
    ).toContain('5 % menos');
  });

  it('answers the stolen vehicle and "sin forma de pago"', () => {
    expect(
      paymentAnswer(
        [debit()],
        'me robaron la moto, ¿tengo que seguir pagando?',
      ),
    ).toContain('convenio');
    expect(
      paymentAnswer(
        [debit()],
        'me dijeron que quedé sin forma de pago, ¿qué es?',
      ),
    ).toContain('tarjeta de crédito o débito, o un CBU');
  });

  it('explains the first installment of a renewal and marks it', () => {
    const renewed = debit({
      lastMovement: 'RENOVACION',
      paymentMethod: 'Débito Tarjeta',
      unpaidInstallments: [
        {
          number: 1,
          amount: '1000',
          dueDate: '2026-10-10T00:00:00.000Z',
          status: 'pending',
        },
      ],
    });
    expect(
      paymentAnswer([renewed], 'pero si ya me debitaron este mes'),
    ).toContain('la cuota 1 es la primera de la póliza nueva');
    expect(formatEstadoCuenta([renewed])).toContain(
      '1ª cuota de la renovación',
    );
    expect(paymentAnswer([debit()], 'pero si ya me debitaron')).toBeNull();
  });
});

describe('claims', () => {
  it('tells the claim copy and the claims phone from the claim number', () => {
    expect(CLAIM_COPY_RE.test(fold('me pasás la copia de la denuncia?'))).toBe(
      true,
    );
    expect(
      CLAIM_COPY_RE.test(fold('necesito la denuncia administrativa')),
    ).toBe(true);
    expect(CLAIMS_PHONE_RE.test(fold('cuál es el 0800 para denunciar?'))).toBe(
      true,
    );
    expect(
      CLAIMS_PHONE_RE.test(fold('a qué número llamo para hacer la denuncia')),
    ).toBe(true);
    expect(CLAIMS_PHONE_RE.test(fold('cuál es el número de siniestro?'))).toBe(
      false,
    );
    expect(CLAIMS_PHONE_RE.test(fold('quiero hacer una denuncia'))).toBe(false);
  });

  it('offers a copy of a claim among the documents', () => {
    const list = docPicker([
      { code: '1050', name: 'Tarjeta verde (Mercosur)', url: '' },
    ]);
    if (list.kind !== 'list') throw new Error('expected a list');
    expect(list.rows.map((r) => r.id)).toContain('doc_denuncia');
  });

  it('does not say a claim made with the office was lost', () => {
    expect(formatSiniestros([])).toContain('Si la hiciste con la oficina');
  });
});

describe('transfer offer (John, 20/10)', () => {
  const transfer = {
    alias: 'ALIAS.DE.PRUEBA',
    cbu: '0000000000000000000000',
    holder: 'Compañía',
  };
  const poliza = (over: Partial<EstadoCuentaPoliza>): EstadoCuentaPoliza => ({
    id: 1,
    certificateNumber: '1000001',
    riskType: 'auto',
    lastMovement: 'REFACTURACION',
    paymentMethod: 'Convenio',
    vehicle: { licensePlate: 'AB123CD', brand: 'FIAT', model: 'PALIO' },
    paidInstallments: 1,
    unpaidInstallments: [],
    hasRejectedInstallments: false,
    ...over,
  });
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString();

  it('offers the next installment with the account', () => {
    const text = transferOffer(
      [
        poliza({
          unpaidInstallments: [
            {
              number: 3,
              amount: '1000',
              dueDate: daysAgo(-20),
              status: 'pending',
            },
            {
              number: 2,
              amount: '39757',
              dueDate: daysAgo(10),
              status: 'overdue',
            },
          ],
        }),
      ],
      transfer,
    );
    expect(text).toContain('cuota 2');
    expect(text).toContain('ALIAS.DE.PRUEBA');
    expect(text).toContain('mandame el comprobante');
    expect(text).toContain(
      'la oficina te manda el cupón en el horario de atención',
    );
    expect(text).not.toContain('0 hs');
  });

  it('adds up what falls due on the same date and skips cancelled ones', () => {
    const text = transferOffer(
      [
        poliza({
          unpaidInstallments: [
            // An installment and an endorsement on the same due date.
            {
              number: 3,
              amount: '70000',
              dueDate: '2026-10-16T00:00:00.000Z',
              status: 'pending',
            },
            {
              number: 1,
              amount: '10000',
              dueDate: '2026-10-16T00:00:00.000Z',
              status: 'pending',
            },
          ],
        }),
        poliza({
          id: 2,
          vehicle: { licensePlate: 'CD456EF', brand: 'FORD', model: 'KA' },
          unpaidInstallments: [
            // A cancelled installment that offsets another one.
            {
              number: 1,
              amount: '-53127',
              dueDate: '2026-04-04T00:00:00.000Z',
              status: 'overdue',
            },
            {
              number: 3,
              amount: '53127',
              dueDate: '2026-04-04T00:00:00.000Z',
              status: 'overdue',
            },
            {
              number: 4,
              amount: '20000',
              dueDate: '2026-11-04T00:00:00.000Z',
              status: 'pending',
            },
          ],
        }),
      ],
      transfer,
    );
    expect(text).toMatch(
      /FIAT PALIO\*: cuotas 3 y 1, \$\s?80\.000,00 en total \(vence 16\/10\/2026\)/,
    );
    expect(text).toMatch(
      /FORD KA\*: cuota 4, \$\s?20\.000,00 \(vence 04\/11\/2026\)/,
    );
    expect(text).not.toContain('53.127');
  });

  it('offers an installment not yet due too', () => {
    const text = transferOffer(
      [
        poliza({
          unpaidInstallments: [
            {
              number: 4,
              amount: '1000',
              dueDate: daysAgo(-10),
              status: 'pending',
            },
          ],
        }),
      ],
      transfer,
    );
    expect(text).toContain('cuota 4');
  });

  it('waits for the rejection of an installment the bank is still debiting', () => {
    const debiting = poliza({
      paymentMethod: 'Débito Tarjeta',
      unpaidInstallments: [
        { number: 1, amount: '1000', dueDate: daysAgo(5), status: 'overdue' },
      ],
    });
    const text = transferOffer([debiting], transfer);
    expect(text).toContain('se está debitando');
    expect(text).not.toContain('ALIAS.DE.PRUEBA');
    // Unless the customer says the debit failed.
    expect(transferOffer([debiting], transfer, true)).toContain(
      'ALIAS.DE.PRUEBA',
    );

    // Covered until a rejection (John, 20/10), however old the installment.
    const old = poliza({
      paymentMethod: 'Débito Caja de Ahorro',
      unpaidInstallments: [
        { number: 1, amount: '1000', dueDate: daysAgo(60), status: 'overdue' },
      ],
    });
    expect(transferOffer([old], transfer)).not.toContain('ALIAS.DE.PRUEBA');
  });

  it('offers nothing without an account or an installment', () => {
    expect(
      transferOffer(
        [
          poliza({
            unpaidInstallments: [
              {
                number: 1,
                amount: '1',
                dueDate: daysAgo(1),
                status: 'pending',
              },
            ],
          }),
        ],
        {},
      ),
    ).toBeNull();
    expect(transferOffer([poliza({})], transfer)).toBeNull();
  });

  it('says the coupon is needed for Rapipago and Mercado Pago, and the transfer is not', () => {
    const text = paymentAnswer(
      [poliza({})],
      '¿puedo pagar por transferencia o con Mercado Pago?',
      transfer,
    );
    expect(text).toContain('Transferencia, mandando el comprobante');
    expect(text).toContain('ALIAS.DE.PRUEBA');
    expect(text).toContain(
      'Por Mercado Pago con el cupón, o desde la app de Triunfo',
    );
  });
});
