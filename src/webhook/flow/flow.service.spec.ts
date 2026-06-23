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
  };

  const KEY = 'pn:wa';
  const leadCtx: FlowContext = {
    conversationId: 1,
    client: null,
    newSession: false,
    botName: 'Nico',
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
});
