import { freeTextIntent } from './free-text-intent';

describe('freeTextIntent', () => {
  it.each([
    ['art', 'art'],
    ['coti ART', 'art'],
    ['Seguro de riesgo de trabajo', 'art'],
    ['Me podés comunicar con Milagros?', 'human'],
    ['Quiero hablar con una persona', 'human'],
    ['Asesor', 'human'],
    ['¿Cuándo tengo que pagar la cuota?', 'pagos'],
    ['Necesito mi póliza', 'documentos'],
    ['Vos podrías pasarme la póliza de ese camión?', 'documentos'],
    ['Quiero cotizar mi auto, cuánto tengo que pagar?', null],
    ['Quiero contratar un seguro, necesito la póliza', null],
    ['No quiero hablar con un asesor', null],
    ['Tengo la tarjeta verde', null],
    ['Milagros', null],
    ['me chocaron', null],
    ['confirmar', null],
    ['Quiero dar de baja mi póliza', null],
    ['Solicito la cancelación póliza de la moto por venta', null],
    ['2000 es el código postal', null],
    ['¿Incluye cobertura de robo?', null],
  ])('routes only an explicit supported request: %s', (text, intent) => {
    expect(freeTextIntent(text)).toBe(intent);
  });
});
