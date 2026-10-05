import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ApiService } from '../../api/api.service';
import { FlowService, takeOutDocsState } from './flow.service';
import type { FlowContext, FlowState, UserInput } from './flow.types';
import { OPT } from './flow.messages';
import { SiniestroExtractor } from './siniestro-extractor.service';

/**
 * Covers two things: the flow-switch behaviour (a user parked in a sticky LLM
 * sub-flow who names a different flow must see the deterministic menu again) and
 * the durable-state contract (handle rehydrates from the snapshot it returns, so
 * the flow survives a "restart" — simulated here by only threading `state`, never
 * relying on in-process memory between turns).
 */
describe('FlowService', () => {
  let flow: FlowService;
  let api: {
    resetSession: jest.Mock;
    getEstadoCuenta: jest.Mock;
    requestHandoff: jest.Mock;
    requestPolicyCancellation: jest.Mock;
    getPolizas: jest.Mock;
    createSiniestro: jest.Mock;
    getPricing: jest.Mock;
    getHours: jest.Mock;
    identifyClient: jest.Mock;
  };
  let extractor: { extract: jest.Mock };

  const KEY = 'pn:wa';
  const leadCtx: FlowContext = {
    conversationId: 1,
    client: null,
    newSession: false,
    botName: 'Nico',
    attentionHours: 'Lunes a viernes de 8 a 16 hs',
  };

  // Mirrors the API: the snapshot returned by one turn is fed into the next.
  let stored: FlowState | null;

  /** Sends a message, threading only the persisted snapshot (no in-memory carry-over). */
  async function send(input: UserInput, ctx: FlowContext = leadCtx) {
    const res = await flow.handle(KEY, input, { ...ctx, flowState: stored });
    stored = res.state;
    return res;
  }

  beforeEach(async () => {
    stored = null;
    api = {
      resetSession: jest.fn().mockResolvedValue(undefined),
      getEstadoCuenta: jest.fn().mockResolvedValue([]),
      requestHandoff: jest.fn().mockResolvedValue(undefined),
      requestPolicyCancellation: jest.fn().mockResolvedValue({ id: 11 }),
      getPolizas: jest.fn().mockResolvedValue([
        {
          id: 833,
          certificado: '1741715',
          company: 'Triunfo',
          riskType: 'auto',
          status: 'vigente',
          vigenciaDesde: null,
          vigenciaHasta: null,
          paymentMethod: null,
          vehiculo: { dominio: 'ABC123', marca: 'CHEVROLET', modelo: 'CORSA' },
        },
      ]),
      createSiniestro: jest.fn().mockResolvedValue({ id: 99 }),
      getPricing: jest.fn().mockResolvedValue([]),
      getHours: jest.fn().mockResolvedValue({
        formatted: 'Lunes a viernes de 8 a 16 hs',
        isOpenNow: true,
        todayClosure: null,
        message:
          'Sí, ahora estamos abiertos 🙂. Nuestro horario es: Lunes a viernes de 8 a 16 hs.',
        closedNote: null,
      }),
      identifyClient: jest.fn().mockResolvedValue({
        client: { firstName: 'Ana', lastName: 'Gómez' },
        polizasCount: 1,
      }),
    };
    extractor = { extract: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlowService,
        { provide: ApiService, useValue: api },
        { provide: SiniestroExtractor, useValue: extractor },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('0800-TOW') },
        },
      ],
    }).compile();
    flow = module.get(FlowService);
  });

  it.each(['Ya pagué, adjunto un comprobante', 'No se acreditó mi pago'])(
    'passes a first-message human request with its original reason: %s',
    async (text) => {
      const result = await send({ text });
      expect(api.requestHandoff).toHaveBeenCalledWith(1, text);
      expect(result.handoff).toBeUndefined();
      expect(JSON.stringify(result.messages)).toContain('asesor');
    },
  );

  it('preserves the reason collected in the advisor flow', async () => {
    stored = { step: 'ASESOR_MOTIVO', data: {} };
    await send({ text: 'Necesito modificar mi domicilio' });
    expect(api.requestHandoff).toHaveBeenCalledWith(
      1,
      'Necesito modificar mi domicilio',
    );
  });

  /** Drives the lead into the conversational cotización (LLM_COTIZACION). */
  async function enterCotizacion() {
    await send({ text: 'hola' }); // ROOT welcome
    await send({ text: 'quiero cotizar' }); // COTIZAR_TIPO
    await send({ selectionId: OPT.cotAuto, text: '' }); // LLM_COTIZACION
  }

  /** Declares being a client and identifies by DNI (IDENTIFY → CLIENT_MENU). */
  async function declareClient() {
    await send({ selectionId: OPT.cliente, text: 'Sí, soy cliente' }); // IDENTIFY
    await send({ text: '37334584' }); // CLIENT_MENU
  }

  describe('first message that already asks for a quote', () => {
    it('skips "¿ya sos cliente?" and introduces itself with the category menu', async () => {
      const res = await send({ text: 'Hola, quiero cotizar un seguro' });

      expect(stored?.step).toBe('COTIZAR_TIPO');
      expect((res.messages[0] as { body: string }).body).toContain(
        'Soy *Nico*',
      );
      expect(res.messages.some((m) => m.kind === 'list')).toBe(true);
    });

    it('hands straight to the quote model when the vehicle is in the message', async () => {
      const res = await send({ text: 'quiero cotizar mi auto, corsa 2010' });

      expect(stored?.step).toBe('LLM_COTIZACION');
      expect(res.handoff).toBe('cotizacion');
    });

    it('knows a VW is a car without the word "auto"', async () => {
      const res = await send({
        text: 'Hola! quiero cotizar un seguro para mi vw gol trend 2015',
      });

      expect(res.handoff).toBe('cotizacion');
      expect(stored?.data.vehiculo).toBe('auto');
    });

    it('lets the model sort out auto/moto for a brand that makes both', async () => {
      await send({ selectionId: OPT.noCliente, text: 'Todavía no' });
      const res = await send({
        text: 'cuanto sale asegurar una honda wave 110 2020? cp 2000',
      });

      expect(res.handoff).toBe('cotizacion');
      expect(stored?.step).toBe('LLM_COTIZACION');
      expect(stored?.data.vehiculo).toBeUndefined();
    });

    it('quotes a vehicle typed on the category list instead of bouncing to FAQ', async () => {
      await send({ text: 'quiero cotizar' }); // category list
      const res = await send({ text: 'el gol trend 1.6 5 puertas 2015' });

      expect(res.handoff).toBe('cotizacion');
      expect(stored?.step).toBe('LLM_COTIZACION');
    });

    it('still greets with "¿ya sos cliente?" on a plain hello', async () => {
      const res = await send({ text: 'hola' });

      expect(stored?.step).toBe('ROOT');
      expect(JSON.stringify(res.messages)).toContain('¿ya sos cliente');
    });
  });

  describe('durable state', () => {
    it('persists the step across turns (state survives a restart)', async () => {
      await send({ text: 'hola' });
      expect(stored?.step).toBe('ROOT');
      await send({ text: 'quiero cotizar' });
      expect(stored?.step).toBe('COTIZAR_TIPO');
    });

    it('clears the snapshot when the user finalizes', async () => {
      await enterCotizacion();
      await send({ text: 'finalizar' });
      expect(stored).toBeNull();
      expect(api.resetSession).toHaveBeenCalledWith(leadCtx.conversationId);
    });

    it('starts fresh on a new session, ignoring any stale snapshot', async () => {
      await enterCotizacion();
      const res = await flow.handle(
        KEY,
        { text: 'hola' },
        { ...leadCtx, newSession: true, flowState: stored },
      );
      expect(res.state?.step).toBe('ROOT');
    });

    it('keeps verified vehicle memory unchanged across quote turns and restarts', async () => {
      const quoteVehicle = {
        vehicleType: 'auto',
        brandId: 12,
        brandName: 'CHEVROLET',
        candidates: [
          {
            codia: 120632,
            description: 'ONIX 1.0T PREMIER II AT L/24',
          },
        ],
        selected: {
          codia: 120632,
          description: 'ONIX 1.0T PREMIER II AT L/24',
        },
      };
      stored = {
        step: 'LLM_COTIZACION',
        data: { vehiculo: 'auto', quoteVehicle },
        audience: 'lead',
      };

      const res = await send({ text: 'no, no tiene GNC' });

      expect(res.handoff).toBe('cotizacion');
      expect(res.state).toEqual({
        step: 'LLM_COTIZACION',
        data: { vehiculo: 'auto', quoteVehicle },
        audience: 'lead',
      });
    });
  });

  describe('policy cancellation requests', () => {
    it('identifies the client, selects a policy and notifies only after confirmation', async () => {
      await send({ text: 'quiero dar de baja mi póliza' });
      expect(stored?.step).toBe('IDENTIFY');
      expect(api.requestPolicyCancellation).not.toHaveBeenCalled();
      await send({ text: '37334584' });
      expect(api.identifyClient).toHaveBeenCalledWith(1, { dni: '37334584' });
      expect(stored?.step).toBe('BAJA_POLIZA');
      await send({ selectionId: 'pol_833', text: '' });
      expect(stored?.step).toBe('BAJA_CONFIRM');
      expect(api.requestPolicyCancellation).not.toHaveBeenCalled();
      const result = await send({ selectionId: OPT.confirmar, text: '' });
      expect(api.requestPolicyCancellation).toHaveBeenCalledWith(1, 833);
      expect(result.messages[0].body).toContain('todavía no fue dada de baja');
      expect(stored?.step).toBe('CLIENT_MENU');
    });

    it('does not create a request when the client cancels confirmation', async () => {
      await send({ text: 'quiero darme de baja' });
      await send({ text: '37334584' });
      await send({ selectionId: 'pol_833', text: '' });
      await send({ selectionId: OPT.cancelar, text: '' });
      expect(api.requestPolicyCancellation).not.toHaveBeenCalled();
      expect(stored?.step).toBe('CLIENT_MENU');
    });

    it('leaves a quote when the client asks to cancel a policy', async () => {
      stored = { step: 'LLM_COTIZACION', data: {}, audience: 'lead' };
      const result = await send({ text: 'quiero dar de baja mi seguro' });
      expect(result.handoff).toBeUndefined();
      expect(stored?.step).toBe('IDENTIFY');
    });
  });

  describe('siniestro checklist (model reads the answer)', () => {
    const ctx: FlowContext = {
      ...leadCtx,
      client: {
        firstName: 'Evelyn',
        lastName: 'Benitez',
        dni: '37334584',
      } as FlowContext['client'],
      phoneNumberId: 'P1',
      llmEnabled: true,
    };
    const vacio = {
      fecha: null,
      hora: null,
      localidad: null,
      calle: null,
      altura: null,
      entreCalles: null,
      alturaDesconocida: null,
      sentido: null,
      relato: null,
      personas: null,
      lesionados: null,
      lesionesDetalle: null,
      otroVehiculo: null,
      terceroPatente: null,
      terceroConductor: null,
      terceroCompania: null,
    };
    const completo = {
      ...vacio,
      fecha: '2026-10-03',
      hora: '18:30',
      localidad: 'Rosario',
      calle: 'San Martín',
      altura: '1250',
      sentido: 'norte',
      relato: 'Me chocaron de atrás en el semáforo',
      personas: 2,
      lesionados: false,
      otroVehiculo: true,
      terceroPatente: 'AB123CD',
    };

    async function openChecklist() {
      await send({ text: 'hola' }, ctx);
      await send({ selectionId: OPT.siniestros, text: '' }, ctx);
      await send({ selectionId: OPT.sinNueva, text: '' }, ctx);
      return send({ selectionId: 'pol_833', text: '' }, ctx);
    }

    it('asks for every claim detail in a single message', async () => {
      const result = await openChecklist();

      expect(stored?.step).toBe('SINIESTRO_DATOS');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].body).toContain(
        'Respondé todo en un solo mensaje',
      );
      expect(result.messages[0].body).toContain('Calle y altura exacta');
      expect(result.messages[0].body).toContain('norte, sur, este u oeste');
    });

    it('confirms and files the claim when the answer is complete', async () => {
      await openChecklist();
      extractor.extract.mockResolvedValue(completo);

      const summary = await send({ text: 'el sábado 18:30 en rosario…' }, ctx);

      expect(extractor.extract).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'el sábado 18:30 en rosario…',
          phoneNumberId: 'P1',
        }),
      );
      expect(stored?.step).toBe('SINIESTRO_CONFIRM');
      expect(summary.messages[0].body).toContain('Lugar: San Martín 1250');
      expect(summary.messages[0].body).toContain('hacia el norte');

      await send({ selectionId: OPT.confirmar, text: '' }, ctx);
      expect(api.createSiniestro).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ polizaId: 833, fecha: '2026-10-03' }),
      );
      const [, filed] = api.createSiniestro.mock.calls[0] as [
        number,
        { descripcion: string },
      ];
      expect(filed.descripcion).toContain('Personas en el vehículo: 2');
    });

    it('asks for the street number when only a corner was given, and accepts "no sé"', async () => {
      await openChecklist();
      extractor.extract.mockResolvedValueOnce({
        ...completo,
        calle: 'Pellegrini',
        altura: null,
        entreCalles: 'Oroño',
      });

      const followUp = await send({ text: 'fue en pellegrini y oroño…' }, ctx);

      expect(stored?.step).toBe('SINIESTRO_DATOS');
      expect(followUp.messages[0].body).toContain(
        'Altura (número) sobre *Pellegrini*',
      );
      expect(followUp.messages[0].body).toContain('esquina con Oroño');
      expect(api.createSiniestro).not.toHaveBeenCalled();

      extractor.extract.mockResolvedValueOnce({
        ...vacio,
        alturaDesconocida: true,
      });
      const summary = await send({ text: 'no sé' }, ctx);

      expect(extractor.extract).toHaveBeenLastCalledWith(
        expect.objectContaining({ asked: ['altura'] }),
      );
      expect(stored?.step).toBe('SINIESTRO_CONFIRM');
      expect(summary.messages[0].body).toContain(
        'Lugar: Pellegrini s/n (esquina / entre Oroño)',
      );
    });

    it('asks again for a date in the future', async () => {
      await openChecklist();
      extractor.extract.mockResolvedValue({ ...completo, fecha: '2099-01-01' });

      const followUp = await send({ text: 'el 1/1/2099' }, ctx);

      expect(stored?.step).toBe('SINIESTRO_DATOS');
      expect(followUp.messages[0].body).toContain('Fecha del hecho');
    });

    it('falls back to one question at a time when the model fails', async () => {
      await openChecklist();
      extractor.extract.mockRejectedValue(new Error('timeout'));

      const result = await send({ text: 'me chocaron ayer' }, ctx);

      expect(stored?.step).toBe('SINIESTRO_FECHA');
      expect(result.messages[0].body).toContain('de a un dato por vez');
    });

    it('does not call the model for a number over its LLM budget', async () => {
      await send({ text: 'hola' }, { ...ctx, llmEnabled: false });
      await send(
        { selectionId: OPT.siniestros, text: '' },
        { ...ctx, llmEnabled: false },
      );
      await send(
        { selectionId: OPT.sinNueva, text: '' },
        { ...ctx, llmEnabled: false },
      );
      await send(
        { selectionId: 'pol_833', text: '' },
        { ...ctx, llmEnabled: false },
      );

      expect(stored?.step).toBe('SINIESTRO_FECHA');
    });
  });

  describe('siniestro form', () => {
    // The step-by-step form, used when the model is not available.
    const clientCtx: FlowContext = {
      ...leadCtx,
      client: {
        firstName: 'Evelyn',
        lastName: 'Benitez',
        dni: '37334584',
      } as FlowContext['client'],
      llmEnabled: false,
    };

    it('asks one question at a time without the model and calls createSiniestro', async () => {
      await send({ text: 'hola' }, clientCtx); // CLIENT_MENU
      await send({ selectionId: OPT.siniestros, text: '' }, clientCtx); // SINIESTRO_TYPE
      await send({ selectionId: OPT.sinNueva, text: '' }, clientCtx); // SINIESTRO_POLIZA
      await send({ selectionId: 'pol_833', text: '' }, clientCtx); // SINIESTRO_FECHA
      expect(extractor.extract).not.toHaveBeenCalled();

      // Date embedded in a sentence used to dead-end into the FAQ model.
      const afterDate = await send(
        { text: 'me choqué un árbol, hoy a la mañana' },
        clientCtx,
      );
      expect(afterDate.handoff).toBeUndefined();
      expect(afterDate.state?.step).toBe('SINIESTRO_DESC');

      await send({ text: 'choqué contra un árbol de frente' }, clientCtx); // SINIESTRO_HORA
      await completeIncidentDetails();
      const done = await send({ text: 'dale' }, clientCtx); // confirm

      // "hoy" resolves to today's local date (YYYY-MM-DD), same as the service.
      const now = new Date();
      const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      expect(api.createSiniestro).toHaveBeenCalledWith(
        clientCtx.conversationId,
        expect.objectContaining({
          polizaId: 833,
          tipo: 'auto',
          fecha: todayIso,
          descripcion:
            'choqué contra un árbol de frente\nHora: 14:30\nLocalidad: Rosario\nCalle: San Martín\nAltura / referencia: 1234',
        }),
      );
      // The claim is created first, then the guided evidence upload begins.
      expect(done.state?.step).toBe('SINIESTRO_FOTO_TARJETA');
    });

    const polizaCon = (estadoPago: {
      alDia: boolean;
      cuotasRechazadas: number;
      cuotasVencidas: number;
    }) => ({
      id: 833,
      certificado: '1741715',
      company: 'Triunfo',
      riskType: 'auto',
      status: 'vigente',
      vigenciaDesde: null,
      vigenciaHasta: null,
      paymentMethod: null,
      vehiculo: { dominio: 'ABC123', marca: 'CHEVROLET', modelo: 'CORSA' },
      estadoPago,
    });

    async function pickPolicyForClaim() {
      await send({ text: 'hola' }, clientCtx);
      await send({ selectionId: OPT.siniestros, text: '' }, clientCtx);
      await send({ selectionId: OPT.sinNueva, text: '' }, clientCtx);
      return send({ selectionId: 'pol_833', text: '' }, clientCtx);
    }

    it('does not take a claim on a policy with a rejected payment and alerts an advisor', async () => {
      api.getPolizas.mockResolvedValue([
        polizaCon({ alDia: false, cuotasRechazadas: 1, cuotasVencidas: 0 }),
      ]);

      const result = await pickPolicyForClaim();

      expect(result.messages[0].body).toContain('pago rechazado');
      expect(stored?.step).toBe('CLIENT_MENU');
      expect(api.requestHandoff).toHaveBeenCalledWith(
        1,
        expect.stringContaining('1741715'),
      );
      expect(api.createSiniestro).not.toHaveBeenCalled();
    });

    it('does not take a claim on a policy with overdue installments', async () => {
      api.getPolizas.mockResolvedValue([
        polizaCon({ alDia: false, cuotasRechazadas: 0, cuotasVencidas: 2 }),
      ]);

      const result = await pickPolicyForClaim();

      expect(result.messages[0].body).toContain('cuotas vencidas');
      expect(api.requestHandoff).toHaveBeenCalled();
      expect(stored?.step).toBe('CLIENT_MENU');
    });

    it('continues the claim when the policy is paid up', async () => {
      api.getPolizas.mockResolvedValue([
        polizaCon({ alDia: true, cuotasRechazadas: 0, cuotasVencidas: 0 }),
      ]);

      await pickPolicyForClaim();

      expect(stored?.step).toBe('SINIESTRO_FECHA');
      expect(api.requestHandoff).not.toHaveBeenCalled();
    });

    it('alerts an advisor when the client has no policy in force', async () => {
      api.getPolizas.mockResolvedValue([]);

      await send({ text: 'hola' }, clientCtx);
      await send({ selectionId: OPT.siniestros, text: '' }, clientCtx);
      const result = await send(
        { selectionId: OPT.sinNueva, text: '' },
        clientCtx,
      );

      expect(result.messages[0].body).toContain('No encontré pólizas vigentes');
      expect(api.requestHandoff).toHaveBeenCalledWith(
        1,
        expect.stringContaining('no tiene pólizas vigentes'),
      );
      expect(stored?.step).toBe('CLIENT_MENU');
    });

    async function completeIncidentDetails() {
      expect(stored?.step).toBe('SINIESTRO_HORA');
      expect(api.createSiniestro).not.toHaveBeenCalled();
      await send({ text: '14:30' }, clientCtx);
      expect(stored?.step).toBe('SINIESTRO_LOCALIDAD');
      await send({ text: 'Rosario' }, clientCtx);
      expect(stored?.step).toBe('SINIESTRO_CALLE');
      await send({ text: 'San Martín' }, clientCtx);
      expect(stored?.step).toBe('SINIESTRO_ALTURA');
      const summary = await send({ text: '1234' }, clientCtx);
      expect(stored?.step).toBe('SINIESTRO_CONFIRM');
      expect(summary.messages[0].body).toContain('Hora: 14:30');
      expect(summary.messages[0].body).toContain('Localidad: Rosario');
      expect(summary.messages[0].body).toContain('Calle: San Martín');
      expect(summary.messages[0].body).toContain('Altura / referencia: 1234');
    }

    /** Drives an identified client to the date question of a new claim. */
    async function toDateStep() {
      await send({ text: 'hola' }, clientCtx);
      await send({ selectionId: OPT.siniestros, text: '' }, clientCtx);
      await send({ selectionId: OPT.sinNueva, text: '' }, clientCtx);
      await send({ selectionId: 'pol_833', text: '' }, clientCtx);
    }

    function isoDaysAgo(days: number) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    it.each([
      ['Antes de ayer', 2],
      ['anteayer a la noche', 2],
      ['ayer', 1],
    ])('reads "%s" as %i day(s) ago', async (text, days) => {
      await toDateStep();
      await send({ text }, clientCtx);
      await send({ text: 'me rompieron el vidrio' }, clientCtx);
      await completeIncidentDetails();
      await send({ text: 'dale' }, clientCtx);

      expect(api.createSiniestro).toHaveBeenCalledWith(
        clientCtx.conversationId,
        expect.objectContaining({ fecha: isoDaysAgo(days) }),
      );
    });

    it.each(['Listooo', 'listo!', 'ya está', 'eso es todo'])(
      'closes the damage photos on "%s"',
      async (text) => {
        await toDateStep();
        await send({ text: 'hoy' }, clientCtx);
        await send({ text: 'me rompieron el vidrio' }, clientCtx);
        await completeIncidentDetails();
        await send({ text: 'dale' }, clientCtx); // SINIESTRO_FOTO_TARJETA
        await send({ text: 'no la tengo' }, clientCtx); // SINIESTRO_FOTO_CARNET
        await send({ text: 'no la tengo' }, clientCtx); // SINIESTRO_TERCERO
        await send({ selectionId: 'sin_tercero_no', text: 'No' }, clientCtx);
        expect(stored?.step).toBe('SINIESTRO_FOTO_DANIO');

        await send({ text }, clientCtx);

        expect(stored?.step).toBe('CLIENT_MENU');
      },
    );

    it('does not file "Hi" as the reason for an advisor request', async () => {
      await send({ text: 'hola' }, clientCtx);
      await send(
        { selectionId: OPT.asesor, text: 'Hablar con un asesor' },
        clientCtx,
      );
      expect(stored?.step).toBe('ASESOR_MOTIVO');

      await send({ text: 'Hi' }, clientCtx);

      expect(api.requestHandoff).not.toHaveBeenCalled();
      expect(stored?.step).toBe('CLIENT_MENU');
    });

    it('re-asks the date instead of leaking to the FAQ model when it is unreadable', async () => {
      await send({ text: 'hola' }, clientCtx);
      await send({ selectionId: OPT.siniestros, text: '' }, clientCtx);
      await send({ selectionId: OPT.sinNueva, text: '' }, clientCtx);
      await send({ selectionId: 'pol_833', text: '' }, clientCtx);

      const res = await send({ text: 'no me acuerdo bien' }, clientCtx);
      expect(res.handoff).toBeUndefined();
      expect(res.state?.step).toBe('SINIESTRO_FECHA');
    });
  });

  describe('greeting', () => {
    it('does not answer the same standalone greeting twice within 15 seconds', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

      const first = await send({ text: 'Hola' });
      expect(first.messages.length).toBeGreaterThan(0);

      now.mockReturnValue(1_005_000);
      const repeated = await send({ text: 'hola!' });

      expect(repeated.messages).toEqual([]);
      expect(repeated.handoff).toBeUndefined();
      expect(repeated.state?.step).toBe('ROOT');
      now.mockRestore();
    });

    it('answers the same greeting again after the debounce window', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      await send({ text: 'Hola' });

      now.mockReturnValue(1_016_000);
      const later = await send({ text: 'hola' });

      expect(later.messages.length).toBeGreaterThan(0);
      now.mockRestore();
    });

    it('returns to the menu on a standalone greeting (no FAQ handoff)', async () => {
      await send({ text: 'hola' }); // ROOT welcome
      await declareClient(); // CLIENT_MENU
      const res = await send({ text: 'Buenas!' });
      expect(res.handoff).toBeUndefined();
      expect(res.state?.step).toBe('CLIENT_MENU');
    });

    it('still routes a greeting that carries a request', async () => {
      await send({ text: 'hola' });
      await declareClient(); // CLIENT_MENU
      const res = await send({ text: 'hola, quiero ver mi estado de pagos' });
      // pagos needs identification → guard asks for DNI, not a menu reset/FAQ.
      expect(res.handoff).toBeUndefined();
      expect(res.state?.step).toBe('IDENTIFY');
    });
  });

  describe('identification right after "Sí, soy cliente"', () => {
    it('asks for the DNI before showing the client menu', async () => {
      await send({ text: 'hola' }); // ROOT welcome
      const res = await send({
        selectionId: OPT.cliente,
        text: 'Sí, soy cliente',
      });

      expect(res.state?.step).toBe('IDENTIFY');
      expect(res.state?.audience).toBe('client');
      const text = res.messages
        .map((m) => (m.kind === 'text' ? m.body : ''))
        .join(' ');
      expect(text).toContain('DNI');
    });

    it('shows the client menu once identified', async () => {
      await send({ text: 'hola' });
      await send({ selectionId: OPT.cliente, text: 'Sí, soy cliente' });
      const res = await send({ text: '37.334.584' });

      expect(api.identifyClient).toHaveBeenCalledWith(1, { dni: '37334584' });
      expect(res.state?.step).toBe('CLIENT_MENU');
      expect(res.messages[0]).toEqual({
        kind: 'text',
        body: '✅ ¡Listo, te identifiqué!',
      });
      expect(res.messages.some((m) => m.kind === 'list')).toBe(true);
    });

    it('asks again when the DNI is not found', async () => {
      api.identifyClient.mockRejectedValueOnce(
        Object.assign(new Error('Not found'), {
          isAxiosError: true,
          response: { status: 404 },
        }),
      );
      await send({ text: 'hola' });
      await send({ selectionId: OPT.cliente, text: 'Sí, soy cliente' });
      const res = await send({ text: '11111111' });

      expect(res.state?.step).toBe('IDENTIFY');
    });

    it('asks again when the API rejects the value as malformed', async () => {
      api.identifyClient.mockRejectedValueOnce(
        Object.assign(new Error('Bad request'), {
          isAxiosError: true,
          response: { status: 400 },
        }),
      );
      await send({ text: 'hola' });
      await send({ selectionId: OPT.cliente, text: 'Sí, soy cliente' });
      const res = await send({ text: 'no me acuerdo' });

      expect(res.state?.step).toBe('IDENTIFY');
      const text = res.messages
        .map((m) => (m.kind === 'text' ? m.body : ''))
        .join(' ');
      expect(text).toContain('No encontré ningún cliente');
    });

    it('goes to the advisor when the user writes "asesor" instead of a DNI', async () => {
      await send({ text: 'hola' });
      await send({ selectionId: OPT.cliente, text: 'Sí, soy cliente' });
      const res = await send({ text: 'quiero hablar con un asesor' });

      expect(api.identifyClient).not.toHaveBeenCalled();
      expect(res.state?.step).toBe('ASESOR_MOTIVO');
      expect(res.state?.audience).toBe('client');
    });

    it('skips the DNI when the conversation already has a client', async () => {
      const clientCtx: FlowContext = {
        ...leadCtx,
        client: {
          firstName: 'Ana',
          lastName: 'Gómez',
        } as FlowContext['client'],
      };
      stored = { step: 'ROOT', data: {} };
      const res = await send(
        { selectionId: OPT.cliente, text: 'Sí, soy cliente' },
        clientCtx,
      );

      expect(api.identifyClient).not.toHaveBeenCalled();
      expect(res.state?.step).toBe('CLIENT_MENU');
    });
  });

  describe('flow switching', () => {
    it('hands off to the cotización model while quoting', async () => {
      await enterCotizacion();
      const res = await send({ text: 'un Fiat Cronos 2020' });
      expect(res.handoff).toBe('cotizacion');
    });

    it('keeps quoting when the user asks to quote another vehicle', async () => {
      await enterCotizacion();
      const res = await send({ text: 'quiero cotizar otro auto' });
      expect(res.handoff).toBe('cotizacion');
    });

    it('breaks out of the cotización model and shows the menu on a topic change', async () => {
      await enterCotizacion();
      const res = await send({ text: 'quiero llamar a la grua' });
      expect(res.handoff).toBeUndefined();
      expect(res.messages.some((m) => m.kind === 'buttons')).toBe(true);
    });

    it('remembers a declared (not DB-identified) client across a flow switch', async () => {
      await send({ text: 'hola' }); // ROOT welcome
      await declareClient(); // CLIENT_MENU
      await send({ selectionId: OPT.cotizacion, text: '' }); // COTIZAR_TIPO
      await send({ selectionId: OPT.cotAuto, text: '' }); // LLM_COTIZACION

      const res = await send({ text: 'quiero llamar a la grua' });

      expect(res.handoff).toBeUndefined();
      // Tow info is shown via the client menu, NOT the "¿sos cliente?" re-ask.
      const text = res.messages
        .map((m) => (m.kind === 'text' ? m.body : ''))
        .join(' ');
      expect(text).toContain('🆘');
    });

    it('routes an identified client straight into the requested flow', async () => {
      const clientCtx: FlowContext = {
        ...leadCtx,
        client: {
          firstName: 'Ana',
          lastName: 'Gómez',
          dni: '123',
        } as FlowContext['client'],
      };
      await send({ text: 'hola' }, clientCtx);
      await send({ selectionId: OPT.cotizacion, text: '' }, clientCtx);
      await send({ selectionId: OPT.cotAuto, text: '' }, clientCtx);

      const res = await send(
        { text: 'quiero ver mi estado de pagos' },
        clientCtx,
      );
      expect(res.handoff).toBeUndefined();
      expect(api.getEstadoCuenta).toHaveBeenCalledWith(
        clientCtx.conversationId,
      );
    });
  });

  describe('cotización shortcut', () => {
    const clientCtx: FlowContext = {
      ...leadCtx,
      client: {
        firstName: 'Evelyn',
        lastName: 'Benitez',
        dni: '37334584',
      } as FlowContext['client'],
    };

    it('jumps straight into the named category when the message specifies one (hogar)', async () => {
      await send({ text: 'hola' }, clientCtx); // CLIENT_MENU
      const res = await send(
        { text: 'Me gustaria cotizar un hogar' },
        clientCtx,
      );

      // No second menu and no FAQ leak: the hogar lead capture starts directly.
      expect(res.handoff).toBeUndefined();
      expect(res.state?.step).toBe('COT_LEAD_NOMBRE');
      expect(api.getPricing).toHaveBeenCalledWith(
        clientCtx.conversationId,
        'hogar',
      );
    });

    it('details every plan with its coverages before the picker (matches the web)', async () => {
      api.getPricing.mockResolvedValueOnce([
        {
          id: 1,
          productType: 'hogar',
          name: 'Plan Hogar Básico',
          monthlyPrice: 12500,
          description: 'Protección esencial',
          coverageItems: [
            {
              label: 'Incendio edificio',
              category: 'Edificio',
              amount: 8000000,
            },
            { label: 'Robo contenido', category: 'Contenido', amount: 1500000 },
          ],
          isActive: true,
          sortOrder: 0,
        },
        {
          id: 2,
          productType: 'hogar',
          name: 'Plan Hogar Full',
          monthlyPrice: 21000,
          description: null,
          coverageItems: [
            {
              label: 'Incendio edificio',
              category: 'Edificio',
              amount: 15000000,
            },
          ],
          isActive: true,
          sortOrder: 1,
        },
      ]);

      await send({ text: 'hola' }, clientCtx);
      const res = await send({ text: 'cotizar hogar' }, clientCtx);

      expect(res.handoff).toBeUndefined();
      expect(res.state?.step).toBe('COT_PLAN');
      // A text breakdown precedes the interactive picker.
      expect(res.messages[0].kind).toBe('text');
      expect(res.messages.some((m) => m.kind === 'list')).toBe(true);

      const detail =
        res.messages[0].kind === 'text' ? res.messages[0].body : '';
      // Each plan, its price and its coverages appear in the breakdown.
      expect(detail).toContain('Plan Hogar Básico');
      expect(detail).toContain('Plan Hogar Full');
      expect(detail).toContain('Incendio edificio');
      expect(detail).toContain('Robo contenido');
      // Whole-peso formatting, same as the web (no decimals).
      expect(detail).toMatch(/12\.500/);
      expect(detail).not.toMatch(/12\.500,00/);
    });

    it('jumps straight into the online quote when the category is auto', async () => {
      await send({ text: 'hola' }, clientCtx);
      const res = await send({ text: 'quiero cotizar el auto' }, clientCtx);

      expect(res.handoff).toBeUndefined();
      expect(res.state?.step).toBe('LLM_COTIZACION');
    });

    it('falls back to the category menu when no category is named', async () => {
      await send({ text: 'hola' }, clientCtx);
      const res = await send({ text: 'quiero cotizar un seguro' }, clientCtx);

      expect(res.handoff).toBeUndefined();
      expect(res.state?.step).toBe('COTIZAR_TIPO');
      expect(res.messages.some((m) => m.kind === 'list')).toBe(true);
    });

    it('shows the category menu when the user taps the generic Cotización option', async () => {
      await send({ text: 'hola' }, clientCtx);
      const res = await send(
        { selectionId: OPT.cotizacion, text: '💰 Cotización' },
        clientCtx,
      );

      expect(res.state?.step).toBe('COTIZAR_TIPO');
      expect(res.messages.some((m) => m.kind === 'list')).toBe(true);
    });
  });

  describe('horarios', () => {
    it('answers hours questions deterministically (no LLM handoff)', async () => {
      await send({ selectionId: OPT.noCliente, text: 'Todavía no' });
      const res = await send({ text: '¿a qué hora abren?' });

      expect(api.getHours).toHaveBeenCalled();
      expect(res.handoff).toBeUndefined();
      expect(res.messages[0].kind).toBe('text');
      expect((res.messages[0] as { body: string }).body).toContain('horario');
    });

    /**
     * A real conversation looped forever here: the client was on the bolso plan
     * picker and asked for a monopatín, and every turn re-sent the same picker
     * verbatim because COT_PLAN only ever read a `plan_<id>` tap.
     */
    describe('plan picker (COT_PLAN) is not a dead end', () => {
      beforeEach(() => {
        api.getPricing.mockResolvedValue([
          {
            id: 1,
            productType: 'bolso',
            name: 'Bolso Base',
            monthlyPrice: 4200,
            description: null,
            coverageItems: [],
            isActive: true,
            sortOrder: 1,
          },
        ]);
      });

      /** Drives the user onto the bolso plan picker. */
      async function enterPlanPicker() {
        await send({ text: 'hola' });
        await send({ selectionId: OPT.noCliente, text: 'Todavía no' });
        await send({ text: 'quiero cotizar' });
        await send({ selectionId: OPT.cotBolso, text: '' });
        expect(stored?.step).toBe('COT_PLAN');
      }

      it('switches category when the user names a different risk', async () => {
        await enterPlanPicker();

        const res = await send({
          text: 'Quiero un seguro para mi monopatin electrico',
        });

        // Left the bolso picker for the bici/monopatín flow.
        expect(stored?.step).not.toBe('COT_PLAN');
        expect(stored?.data.productType).toBe('bici');
        expect(JSON.stringify(res.messages)).not.toContain('Bolso Base');
      });

      it('says it did not understand instead of repeating the picker verbatim', async () => {
        await enterPlanPicker();

        const res = await send({ text: 'no sé, cuál me conviene' });

        expect(stored?.step).toBe('COT_PLAN');
        expect(JSON.stringify(res.messages)).toContain('No reconocí ese plan');
      });

      it('lets the user out with "cancelar"', async () => {
        await enterPlanPicker();

        await send({ text: 'cancelar' });

        expect(stored?.step).toBe('LEAD_MENU');
      });

      it('offers the escape buttons on the second miss instead of insisting', async () => {
        await enterPlanPicker();

        const first = await send({ text: 'no sé, cuál me conviene' });
        expect(JSON.stringify(first.messages)).toContain(
          'No reconocí ese plan',
        );

        const second = await send({ text: 'no sé, cuál me conviene' });
        const body = JSON.stringify(second.messages);
        expect(body).toContain('no te estoy entendiendo');
        expect(body).toContain('Elegir de la lista');
        expect(body).toContain('Hablar con un asesor');
        // Still on the step: a proper answer afterwards must keep working.
        expect(stored?.step).toBe('COT_PLAN');
      });

      it('routes the escape buttons', async () => {
        await enterPlanPicker();
        await send({ text: 'ni idea' });
        await send({ text: 'ni idea' });

        const res = await send({
          selectionId: OPT.stuckAsesor,
          text: 'Hablar con un asesor',
        });

        expect(api.requestHandoff).toHaveBeenCalled();
        expect((res.messages[0] as { body: string }).body).toContain(
          'tomé nota',
        );
      });

      it('clears the retry counter once the user is understood', async () => {
        await enterPlanPicker();
        await send({ text: 'ni idea' }); // one miss
        expect(stored?.data.retries).toBe(1);

        // A recognised category moves the flow on; the counter must not follow.
        await send({ text: 'quiero un seguro para mi bici' });
        expect(stored?.data.retries).toBeUndefined();
      });
    });

    describe('an expired session does not swallow the message that reopens it', () => {
      const clientCtx: FlowContext = {
        ...leadCtx,
        client: {
          firstName: 'EVELYN ELIZABETH',
          lastName: 'BENITEZ',
          dni: '37334584',
        } as FlowContext['client'],
      };

      it('greets and answers the tapped menu option in the same turn', async () => {
        // No stored state = the session expired and the snapshot was dropped,
        // but the old menu is still on the user's screen.
        const res = await flow.handle(
          KEY,
          { selectionId: OPT.pagos, text: '💳 Pagos y cobranzas' },
          { ...clientCtx, newSession: true, flowState: null },
        );

        expect((res.messages[0] as { body: string }).body).toBe(
          '¡Hola de nuevo, Evelyn!',
        );
        expect(api.getEstadoCuenta).toHaveBeenCalled();
      });

      it('still just greets when the tap referenced data the session no longer has', async () => {
        const res = await flow.handle(
          KEY,
          { selectionId: 'plan_7', text: 'Bolso Plus' },
          { ...clientCtx, newSession: true, flowState: null },
        );

        // A stale picker id can't be honoured — fall back to the menu.
        expect(res.messages[1].kind).toBe('list');
        expect(api.getEstadoCuenta).not.toHaveBeenCalled();
      });
    });

    it('does not hijack typed data while capturing (asesor motivo)', async () => {
      const clientCtx: FlowContext = {
        ...leadCtx,
        client: {
          firstName: 'Ana',
          lastName: 'Gómez',
          dni: '123',
        } as FlowContext['client'],
      };
      await send({ text: 'hola' }, clientCtx);
      await send({ selectionId: OPT.asesor, text: 'Asesor' }, clientCtx);
      // The motivo mentions "horario" but we're capturing data → it must reach the
      // asesor handler, not be answered as an hours question.
      const res = await send(
        { text: 'consultar el horario de mi póliza' },
        clientCtx,
      );
      // Reached the asesor handler (handoff registered + its confirmation), not
      // hijacked into the hours answer.
      expect(api.requestHandoff).toHaveBeenCalled();
      expect((res.messages[0] as { body: string }).body).toContain('tomé nota');
    });
  });

  /**
   * A real conversation lost its quote: the user answered "CHEVROLET, anio 2010,
   * 2000 es el codigo postal" and the off-topic guard read "codigo" as a
   * programming request, refused and dumped them on the main menu.
   */
  describe('keyword guards never hijack a real answer', () => {
    const REFUSAL = 'solo puedo ayudarte';
    const bodies = (res: { messages: unknown[] }) =>
      JSON.stringify(res.messages);

    it.each([
      'CHEVROLET, anio 2010, 2000 es el codigo postal',
      'el código postal es 2000',
      '¿La cobertura integral qué incluye?',
      'te cuento que es un Corsa 2010',
      '¿cuánto sale la cuota? ¿puedo pagar con tarjeta?',
      '¿incluye grúa?',
      '¿qué pasa si me roban el auto?',
      '¿qué documentos necesito para contratar?',
      'escribime un código en python', // the quote prompt refuses it itself
    ])('keeps quoting on "%s"', async (text) => {
      await enterCotizacion();
      const res = await send({ text });

      expect(res.handoff).toBe('cotizacion');
      expect(stored?.step).toBe('LLM_COTIZACION');
      expect(bodies(res)).not.toContain(REFUSAL);
    });

    it('leaves the quote for "necesito el certificado de cobertura"', async () => {
      await send({ text: 'hola' });
      await declareClient();
      await send({ selectionId: OPT.cotizacion, text: '' });
      await send({ selectionId: OPT.cotAuto, text: '' });
      const res = await send({ text: 'necesito el certificado de cobertura' });

      expect(res.handoff).not.toBe('cotizacion');
      expect(stored?.step).not.toBe('LLM_COTIZACION');
    });

    it.each(['quiero pagar la cuota', 'necesito la tarjeta del seguro'])(
      'still leaves "otras consultas" for "%s" (unchanged behaviour)',
      async (text) => {
        await send({ selectionId: OPT.noCliente, text: 'Todavía no' });
        await send({ selectionId: OPT.leadConsultas, text: 'Otras consultas' });
        expect(stored?.step).toBe('LLM_FAQ');

        await send({ text });

        // Same as before today: the keyword breaks out of the FAQ model.
        expect(stored?.step).not.toBe('LLM_FAQ');
      },
    );

    it('keeps the category list for a quote that is not a vehicle', async () => {
      await send({ selectionId: OPT.noCliente, text: 'Todavía no' });
      const res = await send({ text: 'quiero cotizar un seguro de caución' });

      expect(stored?.step).toBe('COTIZAR_TIPO');
      expect(res.handoff).toBeUndefined();
      expect(res.messages.some((m) => m.kind === 'list')).toBe(true);
    });

    it('still reads "¿cuánto es el seguro de un auto?" as a quote from ROOT', async () => {
      await send({ text: 'hola' });
      await send({ text: '¿cuánto es el seguro de un auto?' });

      expect(stored?.step).toBe('LLM_COTIZACION');
    });

    it('still leaves the quote when the user clearly asks for another flow', async () => {
      await send({ text: 'hola' });
      await declareClient();
      await send({ selectionId: OPT.cotizacion, text: '' });
      await send({ selectionId: OPT.cotAuto, text: '' });
      const res = await send({ text: 'necesito hablar con un asesor' });

      expect(res.handoff).toBeUndefined();
      expect(stored?.step).toBe('ASESOR_MOTIVO');
    });

    it.each([
      'escribime un código en python',
      'contame un chiste',
      '¿cuál es la capital de Francia?',
      '¿cuánto es 25 x 4?',
    ])('refuses "%s" from the menu without calling the LLM', async (text) => {
      await send({ selectionId: OPT.noCliente, text: 'Todavía no' });
      const res = await send({ text });

      expect(res.handoff).toBeUndefined();
      expect(bodies(res)).toContain(REFUSAL);
    });

    it.each([
      '¿Qué cubre la cobertura integral?',
      '¿quién es el titular de la póliza?',
      'necesito el capital de la póliza de vida',
    ])('does not refuse the insurance question "%s"', async (text) => {
      await send({ selectionId: OPT.noCliente, text: 'Todavía no' });
      const res = await send({ text });

      expect(bodies(res)).not.toContain(REFUSAL);
    });

    it('does not answer the hours for "¿atienden motos?"', async () => {
      await send({ selectionId: OPT.noCliente, text: 'Todavía no' });
      await send({ text: '¿atienden motos?' });

      expect(api.getHours).not.toHaveBeenCalled();
    });

    it('answers the hours for "¿atienden los sábados?"', async () => {
      await send({ selectionId: OPT.noCliente, text: 'Todavía no' });
      await send({ text: '¿atienden los sábados?' });

      expect(api.getHours).toHaveBeenCalled();
    });

    describe('client menu keywords', () => {
      const clientCtx: FlowContext = {
        ...leadCtx,
        client: {
          firstName: 'Ana',
          lastName: 'Gómez',
          dni: '123',
        } as FlowContext['client'],
      };

      it('reads "problema" as a payment issue, not a robbery', async () => {
        await send({ text: 'hola' }, clientCtx);
        await send({ text: 'tengo un problema con mi pago' }, clientCtx);

        expect(stored?.step).not.toBe('SINIESTRO_TYPE');
        expect(api.getEstadoCuenta).toHaveBeenCalled();
      });

      it('reads "accidentes personales" as a product, not a claim', async () => {
        await send({ text: 'hola' }, clientCtx);
        await send(
          { text: 'quiero un seguro de accidentes personales' },
          clientCtx,
        );

        expect(stored?.step).not.toBe('SINIESTRO_TYPE');
      });

      it('still opens a claim for "me robaron el auto"', async () => {
        await send({ text: 'hola' }, clientCtx);
        await send({ text: 'me robaron el auto' }, clientCtx);

        expect(stored?.step).toBe('SINIESTRO_TYPE');
      });
    });
  });

  describe('take-out documents after choosing a coverage', () => {
    /** State the webhook saves once the quote model records the coverage. */
    function startDocs(leadId = 42) {
      stored = takeOutDocsState(
        { step: 'LLM_COTIZACION', data: {}, audience: 'lead' },
        leadId,
      );
    }
    const photo = { text: '', selectionId: '__photo_received__' };

    it('asks DNI back, then tarjeta azul, then closes with the menu', async () => {
      startDocs();

      const back = await send(photo);
      expect(stored).toEqual({
        step: 'COT_DOC_DNI_DORSO',
        data: { leadId: 42 },
        audience: 'lead',
      });
      expect(JSON.stringify(back.messages)).toContain('dorso del DNI');

      const card = await send(photo);
      expect(stored?.step).toBe('COT_DOC_TARJETA_AZUL');
      expect(stored?.data.leadId).toBe(42);
      expect(JSON.stringify(card.messages)).toContain('tarjeta azul');

      const done = await send(photo);
      expect(stored?.step).toBe('LEAD_MENU');
      expect(JSON.stringify(done.messages)).toContain('Ya tenemos todo');
    });

    it('lets the customer skip a document with "no la tengo"', async () => {
      startDocs();

      await send({ text: 'no la tengo' });

      expect(stored?.step).toBe('COT_DOC_DNI_DORSO');
    });

    it('re-asks for the photo on other text, without reaching the LLM', async () => {
      startDocs();

      const res = await send({ text: 'ahora te la mando' });

      expect(res.handoff).toBeUndefined();
      expect(stored?.step).toBe('COT_DOC_DNI_FRENTE');
      expect(JSON.stringify(res.messages)).toContain('foto');
    });
  });
});
