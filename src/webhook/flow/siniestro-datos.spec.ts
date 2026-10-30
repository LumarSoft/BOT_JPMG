import {
  BIEN_DATOS_VACIOS,
  SINIESTRO_DATOS_VACIOS,
  bienDescripcion,
  bienTipoLabel,
  matchBienDanio,
  matchBienTipo,
  mergeBienDatos,
  mergeDatos,
  pendientes,
  pendientesBien,
  siniestroDescripcion,
  terceroDesdeTexto,
  traeDetalles,
} from './siniestro-datos';
import { fold } from '../text';

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

describe('the other vehicle typed with labels at the confirmation card (#330)', () => {
  it('reads the driver and their DNI', () => {
    expect(
      terceroDesdeTexto('Conductor: Ingaramo Juan Pablo dni: número 27336047'),
    ).toEqual({
      otroVehiculo: true,
      terceroConductor: 'Ingaramo Juan Pablo (DNI 27336047)',
    });
  });

  it('reads driver, DNI, insurer and policy from one line', () => {
    expect(
      terceroDesdeTexto(
        'Conductor Ingaramo Juan Pablo dni 27336047 seguro Victoria seguros póliza   04 3061667',
      ),
    ).toEqual({
      otroVehiculo: true,
      terceroConductor: 'Ingaramo Juan Pablo (DNI 27336047)',
      terceroCompania: 'Victoria seguros (póliza 04 3061667)',
    });
  });

  it('reads a plate written with spaces', () => {
    expect(terceroDesdeTexto('Patente del otro vehículo es J R M973')).toEqual({
      otroVehiculo: true,
      terceroPatente: 'JRM973',
    });
    expect(terceroDesdeTexto('dominio: ab 123 cd')).toEqual({
      otroVehiculo: true,
      terceroPatente: 'AB123CD',
    });
  });

  it('joins a DNI or a policy number alone to what is already known', () => {
    const known = {
      ...SINIESTRO_DATOS_VACIOS,
      otroVehiculo: true,
      terceroConductor: 'Juan Pablo Ingaramo',
      terceroCompania: 'Victoria',
    };
    expect(terceroDesdeTexto('dni 27.336.047', known)).toEqual({
      otroVehiculo: true,
      terceroConductor: 'Juan Pablo Ingaramo (DNI 27336047)',
    });
    expect(terceroDesdeTexto('póliza nº 04-3061667', known)).toEqual({
      otroVehiculo: true,
      terceroCompania: 'Victoria (póliza 04-3061667)',
    });
    expect(terceroDesdeTexto('dni 27336047')).toEqual({
      otroVehiculo: true,
      terceroConductor: 'DNI 27336047',
    });
  });

  it('reads nothing from text without those labels', () => {
    expect(terceroDesdeTexto('iba con mi hijo')).toEqual({});
    expect(terceroDesdeTexto('Confirmar')).toEqual({});
    expect(terceroDesdeTexto('asegurado en Sancor')).toEqual({
      otroVehiculo: true,
      terceroCompania: 'Sancor',
    });
  });

  it('tells a detail worth keeping from a tap-like word or an announcement', () => {
    expect(traeDetalles('ok')).toBe(false);
    expect(traeDetalles('los datos del otro vehículo')).toBe(false);
    expect(traeDetalles('Sí')).toBe(false);
    expect(traeDetalles('venía lloviendo y el otro auto frenó de golpe')).toBe(
      true,
    );
    expect(traeDetalles('el otro era un Focus')).toBe(true);
    expect(traeDetalles('siniestro 1070308')).toBe(true);
  });
});

describe('siniestro de hogar / comercio (bien)', () => {
  const completo = {
    fecha: '2026-10-03',
    hora: '20:00',
    domicilio: 'Eva Perón 8615 P1 D10, Rosario',
    relato: 'Se quemó el LCD del televisor y se rajó el vidrio de la ventana',
  };

  it('asks only date, time, address and what happened', () => {
    expect(pendientesBien(BIEN_DATOS_VACIOS).map((p) => p.campo)).toEqual([
      'fecha',
      'hora',
      'domicilio',
      'relato',
    ]);
    expect(pendientesBien(completo)).toEqual([]);
  });

  it('reads the kind of event from what the customer typed', () => {
    expect(matchBienTipo(fold('me robaron en casa'))).toBe('robo');
    expect(matchBienTipo(fold('hubo un incendio en la cocina'))).toBe(
      'incendio',
    );
    expect(matchBienTipo(fold('se rajó el vidrio de la ventana'))).toBe(
      'danios',
    );
    expect(matchBienTipo(fold('se me quemó el LCD'))).toBe('danios');
    expect(matchBienTipo(fold('daños a un tercero'))).toBe(
      'responsabilidad_civil',
    );
    expect(matchBienTipo(fold('hola'))).toBeNull();
  });

  it('reads what got damaged', () => {
    expect(matchBienDanio(fold('se rajó el vidrio de la ventana'))).toBe(
      'cristales',
    );
    expect(matchBienDanio(fold('se me quemó el lcd del tv'))).toBe(
      'electrodomesticos',
    );
    expect(matchBienDanio(fold('se cayó parte del techo'))).toBe('propiedad');
    expect(matchBienDanio(fold('no sé'))).toBeNull();
  });

  it('labels the kind the office sees', () => {
    expect(bienTipoLabel('danios', 'cristales')).toBe('Daños a cristales');
    expect(bienTipoLabel('danios', null)).toBe('Daños');
    expect(bienTipoLabel('robo', null)).toBe('Robo');
    expect(bienTipoLabel(null, null)).toBeNull();
  });

  it('never erases a known value and trims the rest', () => {
    const merged = mergeBienDatos(completo, {
      hora: null,
      domicilio: '  ',
      relato: ' otro relato ',
    });
    expect(merged.hora).toBe('20:00');
    expect(merged.domicilio).toBe(completo.domicilio);
    expect(merged.relato).toBe('otro relato');
  });

  it('writes the description the office receives', () => {
    expect(bienDescripcion('Daños a cristales', completo)).toBe(
      'Tipo de siniestro: Daños a cristales\n' +
        'Se quemó el LCD del televisor y se rajó el vidrio de la ventana\n' +
        'Hora: 20:00\n' +
        'Domicilio: Eva Perón 8615 P1 D10, Rosario',
    );
    expect(bienDescripcion(null, completo).startsWith('Se quemó')).toBe(true);
  });
});
