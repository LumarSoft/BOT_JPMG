import { identificationFromText, isCuit } from './identification';

describe('identificationFromText', () => {
  it.each([
    ['37334584', '37334584'],
    ['Mi DNI es 37334584.', '37334584'],
    ['Mi documento es 37.334.584', '37334584'],
    ['Treinta y siete, tres tres cuatro cinco ocho cuatro.', '37334584'],
    ['Mi DNI es tres siete tres tres cuatro cinco ocho cuatro', '37334584'],
    [
      'treinta y siete millones trescientos treinta y cuatro mil quinientos ochenta y cuatro',
      '37334584',
    ],
    ['30123456781', '30123456781'],
    ['Es empresa te paso cuit 30-12345678-1', '30123456781'],
    ['Mi CUIL es 20-37334584-9', '20373345849'],
    ['DNI 37334584, CUIL 20-37334584-9', '37334584'],
  ])('reads %s', (text, dni) =>
    expect(identificationFromText(text)).toEqual({ dni }),
  );
  it.each(['Mi patente es AB 123 CD', 'AB123CD', 'abc 123'])(
    'reads plate %s',
    (text) => {
      expect(identificationFromText(text)).toEqual({
        plate: text.includes('abc') ? 'ABC123' : 'AB123CD',
      });
    },
  );
  it.each([
    'Quiero hacer un siniestro.',
    'no me acuerdo',
    '123',
    '20373345848',
    '01112345678',
    '37334584 o 30123456781',
    '37334584 o 12345678',
    'asesor',
  ])('rejects %s', (text) => expect(identificationFromText(text)).toBeNull());
});

describe('isCuit', () => {
  it.each(['30123456781', '20373345849', '27123456780'])('accepts %s', (d) =>
    expect(isCuit(d)).toBe(true),
  );
  it.each(['30123456782', '3012345678', '11373345849', 'abcdefghijk'])(
    'rejects %s',
    (d) => expect(isCuit(d)).toBe(false),
  );
});
