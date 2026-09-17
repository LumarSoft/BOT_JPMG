import { buildCotizacionPrompt } from './prompts';

describe('buildCotizacionPrompt', () => {
  const base = {
    today: '17 de septiembre de 2026',
  };

  it('forbids asking about GNC when quoting a motorcycle', () => {
    const prompt = buildCotizacionPrompt({
      ...base,
      vehicleType: 'moto',
    });

    expect(prompt).toContain(
      'El tipo de vehículo ya está definido por el flujo: *moto*.',
    );
    expect(prompt).toContain(
      'Si es *moto*, NUNCA preguntes ni menciones GNC: no corresponde.',
    );
    expect(prompt).toContain('Para motos omitila siempre.');
    expect(prompt).not.toContain('¿Tu moto tiene GNC?');
  });

  it('keeps the GNC question only for car quotes', () => {
    const prompt = buildCotizacionPrompt({
      ...base,
      vehicleType: 'auto',
    });

    expect(prompt).toContain(
      'El tipo de vehículo ya está definido por el flujo: *auto*.',
    );
    expect(prompt).toContain('Es obligatorio para autos');
    expect(prompt).toContain('¿Tu auto tiene GNC?');
  });
});
