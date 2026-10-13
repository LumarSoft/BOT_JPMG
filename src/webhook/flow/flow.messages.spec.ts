import type { EstadoCuentaPoliza, PolizaSummary } from '../../api/api.types';
import {
  displayName,
  formatEstadoCuenta,
  gncAnswer,
  gncButtons,
  leadMenu,
  polizaPicker,
  returningGreeting,
  toWhatsAppMarkdown,
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
