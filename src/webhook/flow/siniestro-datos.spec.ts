import {
  SINIESTRO_DATOS_VACIOS,
  mergeDatos,
  pendientes,
  siniestroDescripcion,
} from './siniestro-datos';

describe('siniestro datos', () => {
  const completo = {
    ...SINIESTRO_DATOS_VACIOS,
    fecha: '2026-10-03',
    hora: '18:30',
    localidad: 'Rosario',
    calle: 'San Martín',
    altura: '1250',
    sentido: 'sur' as const,
    relato: 'Me chocaron de atrás',
    personas: 1,
    lesionados: false,
    otroVehiculo: false,
  };

  it('has nothing pending for a complete claim', () => {
    expect(pendientes(completo)).toEqual([]);
  });

  it('lists every field on an empty claim', () => {
    expect(pendientes(SINIESTRO_DATOS_VACIOS).map((p) => p.campo)).toEqual([
      'fecha',
      'hora',
      'localidad',
      'calle',
      'sentido',
      'relato',
      'personas',
      'lesionados',
      'otroVehiculo',
    ]);
  });

  it('asks who was injured when there were injuries', () => {
    expect(
      pendientes({ ...completo, lesionados: true }).map((p) => p.campo),
    ).toEqual(['lesionesDetalle']);
  });

  it('needs the street number unless the customer does not know it and gave the corner', () => {
    const esquina = { ...completo, altura: null, entreCalles: 'Oroño' };
    expect(pendientes(esquina).map((p) => p.campo)).toEqual(['altura']);
    expect(pendientes({ ...esquina, alturaDesconocida: true })).toEqual([]);
    expect(
      pendientes({ ...completo, altura: null, alturaDesconocida: true })[0]
        .pregunta,
    ).toContain('entre qué calles');
  });

  it('never erases a known value with an empty one', () => {
    const merged = mergeDatos(completo, {
      localidad: null,
      calle: '  ',
      hora: ' 19:00 ',
      personas: 0,
    });
    expect(merged).toMatchObject({
      localidad: 'Rosario',
      calle: 'San Martín',
      hora: '19:00',
      personas: 0,
    });
  });

  it('writes the description the office receives', () => {
    expect(
      siniestroDescripcion({
        ...completo,
        lesionados: true,
        lesionesDetalle: 'el acompañante, golpe en el cuello',
        otroVehiculo: true,
        terceroPatente: 'AB123CD',
      }),
    ).toBe(
      [
        'Me chocaron de atrás',
        'Hora: 18:30',
        'Localidad: Rosario',
        'Lugar: San Martín 1250',
        'Sentido de circulación: hacia el sur',
        'Personas en el vehículo: 1',
        'Lesionados: Sí — el acompañante, golpe en el cuello',
        'Otro vehículo: Sí — patente: AB123CD; conductor: no informado; compañía: no informada',
      ].join('\n'),
    );
  });
});
