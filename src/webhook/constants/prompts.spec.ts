import { buildCotizacionPrompt, buildFaqPrompt } from './prompts';

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

  it('requires quote details and exact benefits in results and follow-ups', () => {
    const prompt = buildCotizacionPrompt({
      ...base,
      vehicleType: 'moto',
    });

    expect(prompt).toContain('*código + nombre*');
    expect(prompt).toContain('los puntos de "incluye"');
    expect(prompt).toContain('una línea "No incluye:"');
    expect(prompt).toContain(
      'respondé SOLO con la descripción, "incluye" y "noIncluye" de quote_vehicle',
    );
    expect(prompt).toContain('reconstruí la cotización con las tools');
  });

  it('shows every car coverage and never infers what one covers from its name', () => {
    const prompt = buildCotizacionPrompt({ ...base, vehicleType: 'auto' });

    expect(prompt).toContain('presentá TODAS las coberturas');
    expect(prompt).not.toContain('hasta 4 coberturas');
    expect(prompt).toContain('no lo deduzcas del nombre');
  });

  it('maps client words to coverage terms and answers follow-ups without quoting again', () => {
    const prompt = buildCotizacionPrompt({ ...base, vehicleType: 'auto' });

    expect(prompt).toContain(
      'parabrisas, luneta, ventanillas o vidrios = *cristales*',
    );
    expect(prompt).toContain('no la vuelvas a llamar');
    expect(prompt).toContain('Una pregunta sobre una cobertura NO es elegirla');
  });
});

describe('buildFaqPrompt', () => {
  const base = { today: '19 de octubre de 2026' };

  it('acts through its tools instead of handing out phrases to type or promising', () => {
    const prompt = buildFaqPrompt(base);

    // 15–19/10: "escribime 'quiero la documentación'" and "te envío la tarjeta" with nothing sent.
    expect(prompt).not.toContain('decile que te escriba');
    expect(prompt).toContain('llamá la herramienta en vez de escribir');
    expect(prompt).toContain('abrir_opcion');
    expect(prompt).toContain('pasar_a_la_oficina');
    expect(prompt).toContain('ni prometas que vos, el sistema o la oficina');
    expect(prompt).not.toContain('## LISTA EN PANTALLA');
  });

  it('shows the list on screen so the model can pick from it', () => {
    const prompt = buildFaqPrompt({
      ...base,
      onScreen: {
        question: '¿De qué póliza querés la documentación?',
        options: [{ id: 'pol_1', title: 'FORD RANGER' }],
      },
    });

    expect(prompt).toContain('## LISTA EN PANTALLA');
    expect(prompt).toContain('- pol_1: FORD RANGER');
    expect(prompt).toContain('elegir_de_la_lista');
  });
});
