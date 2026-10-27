import type { ConfigService } from '@nestjs/config';
import { buildCotizacionPrompt, buildFaqPrompt } from './prompts';
import { legacyOrgProfile, resolveOrgProfile } from '../org-profile';

const JPMG = legacyOrgProfile({
  get: () => undefined,
} as unknown as ConfigService);

describe('buildCotizacionPrompt', () => {
  const base = {
    today: '17 de septiembre de 2026',
    org: JPMG,
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
  const base = { today: '19 de octubre de 2026', org: JPMG };

  it('keeps JPMG identity and payment facts word for word', () => {
    const prompt = buildFaqPrompt({ ...base, botName: 'NICO' });

    expect(prompt).toContain(
      'Sos *NICO*, el asistente de *John Pellegrini Management Group SRL* (JPMG), una productora de seguros',
    );
    expect(prompt).toContain(
      'Teléfono de Triunfo para denuncias y asistencia: 0810-666-0302 (al entrar se elige la opción).',
    );
    expect(prompt).toContain(
      'transferencia a la cuenta de Triunfo (alias TRUENO.VUELO.DELTA, Banco Galicia), mandando el comprobante por este chat; en efectivo con el cupón en Rapipago, Pago Fácil o Santa Fe Servicios;',
    );
    expect(buildFaqPrompt(base)).toContain(
      'Sos *el asistente de John Pellegrini Management Group SRL* (JPMG), una productora',
    );
  });

  it("uses another organization's own name and data, and nothing of JPMG", () => {
    const norte = resolveOrgProfile(
      {
        orgName: 'Seguros Norte',
        orgShortName: null,
        orgLegalName: null,
        towTruckPhone: '0800-111-2222',
        claimsPhone: null,
        cashPaymentPlaces: null,
        transfer: null,
      },
      JPMG,
    );
    const prompt = buildFaqPrompt({ ...base, botName: 'Sofi', org: norte });

    expect(prompt).toContain(
      'Sos *Sofi*, el asistente de *Seguros Norte*, una productora',
    );
    expect(prompt).toContain(
      'transferencia con los datos que le pasa la oficina',
    );
    expect(prompt).toContain(
      'en efectivo con el cupón en Rapipago o Pago Fácil;',
    );
    expect(prompt).toContain('0810-666-0302');
    expect(prompt).not.toMatch(/Pellegrini|JPMG|TRUENO|Santa Fe Servicios/);
    expect(buildCotizacionPrompt({ ...base, org: norte })).not.toMatch(
      /Pellegrini|JPMG/,
    );
  });

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
