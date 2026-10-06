import { identificationFromText } from './identification';

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
    '20373345849',
    '37334584 o 12345678',
    'asesor',
  ])('rejects %s', (text) => expect(identificationFromText(text)).toBeNull());
});
