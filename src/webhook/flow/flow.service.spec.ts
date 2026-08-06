import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ApiService } from '../../api/api.service';
import { FlowService } from './flow.service';
import type { FlowContext, FlowState, UserInput } from './flow.types';
import { OPT } from './flow.messages';

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
    getPolizas: jest.Mock;
    createSiniestro: jest.Mock;
    getPricing: jest.Mock;
    getHours: jest.Mock;
  };

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
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlowService,
        { provide: ApiService, useValue: api },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('0800-TOW') },
        },
      ],
    }).compile();
    flow = module.get(FlowService);
  });

  /** Drives the lead into the conversational cotización (LLM_COTIZACION). */
  async function enterCotizacion() {
    await send({ text: 'hola' }); // ROOT welcome
    await send({ text: 'quiero cotizar' }); // COTIZAR_TIPO
    await send({ selectionId: OPT.cotAuto, text: '' }); // LLM_COTIZACION
  }

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
  });

  describe('siniestro form', () => {
    const clientCtx: FlowContext = {
      ...leadCtx,
      client: {
        firstName: 'Evelyn',
        lastName: 'Benitez',
        dni: '37334584',
      } as FlowContext['client'],
    };

    it('completes the denuncia and calls createSiniestro (date given inside a sentence)', async () => {
      await send({ text: 'hola' }, clientCtx); // CLIENT_MENU
      await send({ selectionId: OPT.siniestros, text: '' }, clientCtx); // SINIESTRO_TYPE
      await send({ selectionId: OPT.sinNueva, text: '' }, clientCtx); // SINIESTRO_POLIZA
      await send({ selectionId: 'pol_833', text: '' }, clientCtx); // SINIESTRO_FECHA

      // Date embedded in a sentence used to dead-end into the FAQ model.
      const afterDate = await send(
        { text: 'me choqué un árbol, hoy a la mañana' },
        clientCtx,
      );
      expect(afterDate.handoff).toBeUndefined();
      expect(afterDate.state?.step).toBe('SINIESTRO_DESC');

      await send({ text: 'choqué contra un árbol de frente' }, clientCtx); // SINIESTRO_CONFIRM
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
          descripcion: 'choqué contra un árbol de frente',
        }),
      );
      expect(done.state?.step).toBe('CLIENT_MENU');
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
    it('returns to the menu on a standalone greeting (no FAQ handoff)', async () => {
      await send({ text: 'hola' }); // ROOT welcome
      await send({ selectionId: OPT.cliente, text: 'Sí, soy cliente' }); // CLIENT_MENU
      const res = await send({ text: 'Buenas!' });
      expect(res.handoff).toBeUndefined();
      expect(res.state?.step).toBe('CLIENT_MENU');
    });

    it('still routes a greeting that carries a request', async () => {
      await send({ text: 'hola' });
      await send({ selectionId: OPT.cliente, text: 'Sí, soy cliente' }); // CLIENT_MENU
      const res = await send({ text: 'hola, quiero ver mi estado de pagos' });
      // pagos needs identification → guard asks for DNI, not a menu reset/FAQ.
      expect(res.handoff).toBeUndefined();
      expect(res.state?.step).toBe('IDENTIFY');
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
      await send({ selectionId: OPT.cliente, text: 'Sí, soy cliente' }); // CLIENT_MENU
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
});
