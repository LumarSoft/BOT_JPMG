import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import { ApiService } from '../api/api.service';
import { MetaService } from './meta.service';
import { FlowService } from './flow/flow.service';
import { AudioTranscriber } from './audio-transcriber.service';

describe('WebhookService', () => {
  let service: WebhookService;
  let api: {
    getContext: jest.Mock;
    getConversation: jest.Mock;
    saveMessage: jest.Mock;
    resetSession: jest.Mock;
    saveFlowState: jest.Mock;
    attachAdjunto: jest.Mock;
    storeAudio?: jest.Mock;
    getProducts: jest.Mock;
    reportOpenAiUsage: jest.Mock;
    createLead: jest.Mock;
    requestHandoff: jest.Mock;
    attachLeadAdjunto: jest.Mock;
    quoteVehicle: jest.Mock;
  };
  let meta: {
    sendText: jest.Mock;
    sendButtons: jest.Mock;
    sendList: jest.Mock;
    normalizePhone: jest.Mock;
    downloadMedia: jest.Mock;
    showTyping: jest.Mock;
  };
  let flow: { handle: jest.Mock; reset: jest.Mock };
  let transcriber: { transcribe: jest.Mock };

  beforeEach(async () => {
    api = {
      getContext: jest.fn().mockResolvedValue({ systemPrompt: 'x' }),
      getConversation: jest.fn(),
      saveMessage: jest.fn(),
      resetSession: jest.fn().mockResolvedValue(undefined),
      saveFlowState: jest.fn().mockResolvedValue(undefined),
      attachAdjunto: jest.fn(),
      getProducts: jest.fn().mockResolvedValue([]),
      reportOpenAiUsage: jest.fn().mockResolvedValue(undefined),
      createLead: jest.fn().mockResolvedValue({ id: 42 }),
      requestHandoff: jest.fn().mockResolvedValue(undefined),
      attachLeadAdjunto: jest
        .fn()
        .mockResolvedValue({ leadId: 42, adjuntosCount: 1 }),
      quoteVehicle: jest.fn().mockResolvedValue({
        quoteNumber: '123',
        validUntil: '2026-10-30',
        vehicleValue: '20000000',
        coverages: [],
        messages: [],
      }),
    };
    meta = {
      sendText: jest.fn().mockResolvedValue(undefined),
      sendButtons: jest.fn().mockResolvedValue(undefined),
      sendList: jest.fn().mockResolvedValue(undefined),
      normalizePhone: jest.fn((p: string) => p),
      downloadMedia: jest.fn(),
      showTyping: jest.fn(),
    };
    transcriber = { transcribe: jest.fn() };
    // By default the flow replies with a single text message and no LLM handoff.
    flow = {
      handle: jest
        .fn()
        .mockResolvedValue({ messages: [{ kind: 'text', body: 'reply' }] }),
      reset: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'OPENAI_API_KEY') return 'test-value';
              if (key === 'BOT_AUTOREPLY_ENABLED') return 'true';
              return undefined;
            }),
          },
        },
        { provide: ApiService, useValue: api },
        { provide: MetaService, useValue: meta },
        { provide: FlowService, useValue: flow },
        { provide: AudioTranscriber, useValue: transcriber },
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
  });

  /** Replaces the internal OpenAI client with a stub that returns a plain reply. */
  function stubOpenAi() {
    const create = jest.fn().mockResolvedValue({
      choices: [{ message: { content: 'reply', tool_calls: [] } }],
    });
    (
      service as unknown as {
        openai: { chat: { completions: { create: jest.Mock } } };
      }
    ).openai = { chat: { completions: { create } } };
    return create;
  }

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('uses GPT-5.6 Luna with reasoning-compatible Chat Completions parameters', async () => {
    const create = stubOpenAi();
    api.getContext.mockResolvedValue({
      producerName: 'John',
      botName: 'Nico',
      attentionHours: 'Lunes a viernes',
      systemPrompt: 'x',
      llmEnabled: true,
    });
    api.getConversation.mockResolvedValue({
      conversationId: 1,
      client: null,
      newSession: false,
      messages: [],
      botPaused: false,
      flowState: null,
    });
    api.saveMessage.mockResolvedValue({});
    flow.handle.mockResolvedValueOnce({
      messages: [],
      state: null,
      handoff: 'faq',
    });

    await service.handleMessage('5491155556666', 'consulta', 'P1', 'luna-1');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.6-luna',
        reasoning_effort: 'none',
        max_completion_tokens: 350,
      }),
    );
    const [[request]] = create.mock.calls as Array<[Record<string, unknown>]>;
    expect(request).not.toHaveProperty('temperature');
    expect(request).not.toHaveProperty('top_p');
    expect(request).not.toHaveProperty('max_tokens');
  });

  it('passes the stored message time to the flow and limits the quote model to the current quote', async () => {
    const create = stubOpenAi();
    api.getContext.mockResolvedValue({ systemPrompt: 'x', llmEnabled: true });
    api.getConversation.mockResolvedValue({
      conversationId: 1,
      client: null,
      newSession: false,
      botPaused: false,
      flowState: null,
      messages: [
        {
          id: 1,
          role: 'user',
          content: 'fiat palio 2024',
          createdAt: '2026-10-05T10:00:00.000Z',
        },
        {
          id: 2,
          role: 'assistant',
          content: 'El Palio figura hasta 2018',
          createdAt: '2026-10-05T10:00:05.000Z',
        },
        {
          id: 3,
          role: 'user',
          content: 'Auto',
          createdAt: '2026-10-05T10:05:00.000Z',
        },
        {
          id: 4,
          role: 'assistant',
          content: 'Decime marca, modelo y año',
          createdAt: '2026-10-05T10:05:01.000Z',
        },
      ],
    });
    api.saveMessage.mockResolvedValue({
      id: 5,
      createdAt: '2026-10-05T10:06:00.000Z',
    });
    flow.handle.mockResolvedValueOnce({
      messages: [],
      handoff: 'cotizacion',
      state: {
        step: 'LLM_COTIZACION',
        data: { vehiculo: 'auto', quoteStartedAt: '2026-10-05T10:05:00.000Z' },
      },
    });

    await service.handleMessage(
      '5491155556666',
      'corsa 2010 cp 2000',
      'P1',
      'q-1',
    );

    expect(flow.handle).toHaveBeenCalledWith(
      'P1:5491155556666',
      expect.anything(),
      expect.objectContaining({ inboundAt: '2026-10-05T10:06:00.000Z' }),
    );
    const [[request]] = create.mock.calls as Array<
      [{ messages: Array<{ content: string }> }]
    >;
    const sent = request.messages.map((m) => m.content).join('\n');
    expect(sent).toContain('Decime marca, modelo y año');
    expect(sent).toContain('corsa 2010 cp 2000');
    expect(sent).not.toContain('palio');
  });

  describe('LLM turn', () => {
    beforeEach(() => {
      api.getContext.mockResolvedValue({
        systemPrompt: 'x',
        llmEnabled: true,
      });
      api.saveMessage.mockResolvedValue({});
      flow.handle.mockResolvedValue({
        messages: [],
        state: null,
        handoff: 'faq',
      });
    });

    it('sends a human agent\'s inbox reply to OpenAI as "assistant"', async () => {
      const create = stubOpenAi();
      api.getConversation.mockResolvedValue({
        conversationId: 1,
        client: null,
        newSession: false,
        messages: [
          { role: 'user', content: 'hola' },
          { role: 'agent', content: 'Hola, soy Juan de la oficina' },
        ],
      });

      // A real question, not a "gracias": closers after a person are left unanswered on purpose.
      await service.handleMessage(
        '5491155556666',
        '¿y cuánto sale la cuota?',
        'P1',
        'ag-1',
      );

      const [request] = create.mock.calls[0] as [
        { messages: { role: string }[] },
      ];
      const sent = request.messages;
      expect(sent.map((m) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
        'user',
      ]);
      expect(meta.sendText).toHaveBeenCalledWith(
        '5491155556666',
        'reply',
        'P1',
      );
    });

    it('asks for a final answer without tools when the rounds run out', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 1,
        client: null,
        newSession: false,
        messages: [],
      });
      flow.handle.mockResolvedValue({
        messages: [],
        state: { step: 'LLM_COTIZACION', data: { vehiculo: 'auto' } },
        handoff: 'cotizacion',
      });
      const toolTurn = {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 't1',
                  type: 'function',
                  function: { name: 'unknown_tool', arguments: '{}' },
                },
              ],
            },
          },
        ],
      };
      let completionIndex = 0;
      const create = jest.fn().mockImplementation((req: object) =>
        Promise.resolve({
          id: `completion-${++completionIndex}`,
          created: 1791000000,
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 100,
            prompt_tokens_details: { cached_tokens: 500 },
          },
          ...('tool_choice' in req
            ? {
                choices: [{ message: { content: 'Estas son las versiones' } }],
              }
            : toolTurn),
        }),
      );
      (
        service as unknown as {
          openai: { chat: { completions: { create: jest.Mock } } };
        }
      ).openai = { chat: { completions: { create } } };

      await service.handleMessage('5491155556666', 'un 308', 'P1', 'cap-1');

      const [last] = create.mock.calls[create.mock.calls.length - 1] as [
        { tool_choice?: string },
      ];
      expect(last.tool_choice).toBe('none');
      expect(api.reportOpenAiUsage).toHaveBeenCalledTimes(
        create.mock.calls.length,
      );
      expect(
        new Set(
          api.reportOpenAiUsage.mock.calls.map(([input]) => input.requestId),
        ).size,
      ).toBe(create.mock.calls.length);
      expect(api.reportOpenAiUsage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          phoneNumberId: 'P1',
          cachedInputTokens: 500,
          inputTokens: 1000,
          outputTokens: 100,
        }),
      );
      expect(meta.sendText).toHaveBeenCalledWith(
        '5491155556666',
        'Estas son las versiones',
        'P1',
      );
    });
  });

  describe('quote vehicle safety', () => {
    const memory = {
      vehicleType: 'auto' as const,
      brandId: 12,
      brandName: 'CHEVROLET',
      candidates: [
        { codia: 120581, description: 'ONIX 1.0T PREMIER II AT L/19' },
        { codia: 120632, description: 'ONIX 1.0T PREMIER II AT L/24' },
      ],
    };

    beforeEach(() => {
      api.saveMessage.mockResolvedValue({});
    });

    it('persists the CODIA selected by its list number across the GNC turn', async () => {
      const create = jest.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content:
                'Perfecto, tomo el ONIX 1.0T PREMIER II AT L/24. ¿Tu auto tiene GNC?',
              tool_calls: [],
            },
          },
        ],
      });
      (
        service as unknown as {
          openai: { chat: { completions: { create: jest.Mock } } };
        }
      ).openai = { chat: { completions: { create } } };
      api.getContext.mockResolvedValue({ systemPrompt: 'x', llmEnabled: true });
      api.getConversation.mockResolvedValue({
        conversationId: 9,
        client: null,
        newSession: false,
        messages: [
          {
            role: 'assistant',
            content:
              '1. ONIX 1.0T PREMIER II AT L/19\n2. ONIX 1.0T PREMIER II AT L/24',
          },
        ],
      });
      flow.handle.mockResolvedValue({
        messages: [],
        state: {
          step: 'LLM_COTIZACION',
          // Keep the candidates deliberately out of display order: selection
          // must follow what the customer actually saw, not array position.
          data: {
            vehiculo: 'auto',
            quoteVehicle: {
              ...memory,
              candidates: [memory.candidates[1], memory.candidates[0]],
            },
          },
        },
        handoff: 'cotizacion',
      });

      await service.handleMessage('5493416000599', '2', 'P1', 'onix-1');

      const savedStates = (
        api.saveFlowState.mock.calls as Array<[number, string | null]>
      )
        .map((call) => call[1])
        .filter(Boolean)
        .map((state) => JSON.parse(state as string) as unknown);
      expect(savedStates.at(-1)).toMatchObject({
        step: 'LLM_COTIZACION',
        data: {
          quoteVehicle: {
            selected: {
              codia: 120632,
              description: 'ONIX 1.0T PREMIER II AT L/24',
            },
          },
        },
      });
      const [[request]] = create.mock.calls as Array<
        [{ messages: Array<{ content: string }> }]
      >;
      expect(request.messages[0].content).toContain(
        'CODIA verificado es `120632`',
      );
    });

    it('replaces codia 0 with the verified CODIA instead of calling Triunfo with zero', async () => {
      const privateService = service as unknown as {
        executeTool: (
          name: string,
          args: string,
          conversationId: number,
          remembered?: typeof memory & {
            selected?: { codia: number; description: string };
          },
        ) => Promise<string>;
      };

      await privateService.executeTool(
        'quote_vehicle',
        JSON.stringify({
          vehicleType: 'auto',
          codia: 0,
          manufactureYear: 2024,
          postalCode: 2000,
        }),
        9,
        { ...memory, selected: memory.candidates[1] },
      );

      expect(api.quoteVehicle).toHaveBeenCalledWith('auto', {
        brand: '12',
        model: '120632',
        manufactureYear: 2024,
        postalCode: 2000,
      });
    });

    it('does not call the API when the CODIA is invalid and no verified selection exists', async () => {
      const privateService = service as unknown as {
        executeTool: (
          name: string,
          args: string,
          conversationId: number,
        ) => Promise<string>;
      };

      const result = await privateService.executeTool(
        'quote_vehicle',
        JSON.stringify({
          vehicleType: 'auto',
          codia: 0,
          manufactureYear: 2024,
          postalCode: 2000,
        }),
        9,
      );

      const parsed = JSON.parse(result) as { error?: unknown };
      expect(parsed.error).toEqual(expect.any(String));
      expect(api.quoteVehicle).not.toHaveBeenCalled();
    });

    it('does not reuse an auto CODIA for a motorcycle quote', async () => {
      const privateService = service as unknown as {
        executeTool: (
          name: string,
          args: string,
          conversationId: number,
          remembered?: typeof memory & {
            selected?: { codia: number; description: string };
          },
        ) => Promise<string>;
      };

      const result = await privateService.executeTool(
        'quote_vehicle',
        JSON.stringify({
          vehicleType: 'moto',
          codia: 0,
          manufactureYear: 2024,
          postalCode: 2000,
        }),
        9,
        { ...memory, selected: memory.candidates[1] },
      );

      const parsed = JSON.parse(result) as { error?: unknown };
      expect(parsed.error).toEqual(expect.any(String));
      expect(api.quoteVehicle).not.toHaveBeenCalled();
    });

    it('drops the old selection when a new vehicle search returns other candidates', () => {
      const privateService = service as unknown as {
        rememberVehicleSearch: (
          previous: typeof memory & {
            selected?: { codia: number; description: string };
          },
          result: string,
          args: string,
        ) => {
          vehicleType: string;
          candidates: Array<{ codia: number; description: string }>;
          selected?: { codia: number; description: string };
        };
      };

      const next = privateService.rememberVehicleSearch(
        { ...memory, selected: memory.candidates[1] },
        JSON.stringify({
          brand: { id: 18, name: 'FORD' },
          versions: [
            { codia: 180771, description: 'FOCUS 2.0 SE PLUS' },
            { codia: 180772, description: 'FOCUS 2.0 TITANIUM' },
          ],
        }),
        JSON.stringify({ vehicleType: 'auto' }),
      );

      expect(next.candidates).toHaveLength(2);
      expect(next.selected).toBeUndefined();
    });
  });

  describe('outgoing messages', () => {
    beforeEach(() => {
      api.getConversation.mockResolvedValue({
        conversationId: 1,
        client: null,
        newSession: false,
        messages: [],
      });
      api.saveMessage.mockResolvedValue({});
    });

    it('sends a greeting and its menu as one WhatsApp message', async () => {
      flow.handle.mockResolvedValue({
        messages: [
          { kind: 'text', body: '¡Hola de nuevo, Ana!' },
          {
            kind: 'list',
            body: '¿En qué te ayudo?',
            button: 'Ver opciones',
            rows: [{ id: 'a', title: 'A' }],
          },
        ],
        state: null,
      });

      await service.handleMessage('5491155556666', 'hola', 'P1', 'cm-1');

      expect(meta.sendText).not.toHaveBeenCalled();
      expect(meta.sendList).toHaveBeenCalledTimes(1);
      expect((meta.sendList.mock.calls as string[][])[0][1]).toBe(
        '¡Hola de nuevo, Ana!\n\n¿En qué te ayudo?',
      );
    });

    it('shows "escribiendo…" for the message it is about to answer', async () => {
      await service.handleMessage('5491155556666', 'hola', 'P1', 'wamid-9');

      expect(meta.showTyping).toHaveBeenCalledWith('wamid-9', 'P1');
    });

    it('does not show "escribiendo…" when a human owns the chat', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 1,
        client: null,
        newSession: false,
        messages: [],
        botPaused: true,
      });

      await service.handleMessage('5491155556666', 'hola', 'P1', 'wamid-10');

      expect(meta.showTyping).not.toHaveBeenCalled();
    });

    it('stays quiet when the customer only closes a chat a person was handling', async () => {
      api.getContext.mockResolvedValue({
        producerName: 'John',
        systemPrompt: 'x',
        botEnabled: true,
      });
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        flowState: null,
        client: null,
        newSession: false,
        botPaused: false,
        messages: [
          {
            id: 1,
            role: 'user',
            content: 'ya está',
            createdAt: '2026-10-07T11:00:00Z',
            source: 'live',
          },
          {
            id: 2,
            role: 'assistant',
            content: 'Dale, buenísimo',
            createdAt: '2026-10-07T11:01:00Z',
            source: 'app_echo',
          },
        ],
      });

      await service.handleMessage(
        '5491155556666',
        'Gracias Mili!',
        'P1',
        'wamid-11',
      );

      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        'Gracias Mili!',
        undefined,
        undefined,
      );
      expect(flow.handle).not.toHaveBeenCalled();
      expect(meta.showTyping).not.toHaveBeenCalled();
      expect(meta.sendText).not.toHaveBeenCalled();
      expect(meta.sendButtons).not.toHaveBeenCalled();
    });

    it('still answers a real question even right after a person spoke', async () => {
      api.getContext.mockResolvedValue({
        producerName: 'John',
        systemPrompt: 'x',
        botEnabled: true,
      });
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        flowState: null,
        client: null,
        newSession: false,
        botPaused: false,
        messages: [
          {
            id: 2,
            role: 'assistant',
            content: 'Dale, buenísimo',
            createdAt: '2026-10-07T11:01:00Z',
            source: 'app_echo',
          },
        ],
      });

      await service.handleMessage(
        '5491155556666',
        'gracias, y me pasás el cupón de octubre?',
        'P1',
        'wamid-12',
      );

      expect(flow.handle).toHaveBeenCalled();
    });

    it('stores the sender’s WhatsApp profile name with the inbound message', async () => {
      api.getContext.mockResolvedValue({
        producerName: 'John',
        systemPrompt: 'x',
        botEnabled: false,
      });

      await service.handleMessage(
        '5491155556666',
        'hola',
        'P1',
        'wamid-name',
        undefined,
        'John',
      );

      expect(api.saveMessage).toHaveBeenCalledWith(
        1,
        'user',
        'hola',
        undefined,
        'John',
      );
    });

    it('stores the message but sends nothing when the bot is disabled globally', async () => {
      api.getContext.mockResolvedValue({
        producerName: 'John',
        systemPrompt: 'x',
        botEnabled: false,
      });

      await service.handleMessage(
        '5491155556666',
        'hola',
        'P1',
        'wamid-disabled',
      );

      expect(api.saveMessage).toHaveBeenCalledWith(
        1,
        'user',
        'hola',
        undefined,
        undefined,
      );
      expect(flow.handle).not.toHaveBeenCalled();
      expect(meta.showTyping).not.toHaveBeenCalled();
      expect(meta.sendText).not.toHaveBeenCalled();
      expect(meta.sendButtons).not.toHaveBeenCalled();
      expect(meta.sendList).not.toHaveBeenCalled();
    });

    it('cancels an in-flight automatic reply when the global stop is activated', async () => {
      api.getContext
        .mockResolvedValueOnce({
          producerName: 'John',
          systemPrompt: 'x',
          botEnabled: true,
        })
        .mockResolvedValueOnce({
          producerName: 'John',
          systemPrompt: 'x',
          botEnabled: false,
        });

      await service.handleMessage(
        '5491155556666',
        'hola',
        'P1',
        'wamid-stop-race',
      );

      expect(flow.handle).toHaveBeenCalled();
      expect(api.saveMessage).toHaveBeenCalledWith(
        1,
        'user',
        'hola',
        undefined,
        undefined,
      );
      expect(meta.sendText).not.toHaveBeenCalled();
      expect(meta.sendButtons).not.toHaveBeenCalled();
      expect(meta.sendList).not.toHaveBeenCalled();
    });
  });

  describe('/reset secret command', () => {
    it('resets the session and does not persist the message', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 5,
        client: null,
        newSession: false,
        messages: [],
      });

      await service.handleMessage(
        '5491155556666',
        '/reset',
        'P1',
        'wamid-reset',
      );

      // `true` = full reset: the identified client is unlinked too, so the next
      // message starts from the "¿sos cliente?" welcome.
      expect(api.resetSession).toHaveBeenCalledWith(5, true);
      expect(api.saveMessage).not.toHaveBeenCalled();
      expect(meta.sendText).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-conversation serialization', () => {
    it('does not process a second message from the same sender concurrently', async () => {
      stubOpenAi();
      api.saveMessage.mockResolvedValue({});
      // Default for the second message's getConversation (the first is blocked below).
      api.getConversation.mockResolvedValue({
        conversationId: 2,
        client: null,
        newSession: false,
        messages: [],
      });

      // Block the first getConversation so the first message stays in-flight.
      let releaseFirst: () => void = () => {};
      const firstStarted = new Promise<void>((resolve) => {
        api.getConversation.mockImplementationOnce(() => {
          resolve();
          return new Promise(
            (res) =>
              (releaseFirst = () =>
                res({
                  conversationId: 1,
                  client: null,
                  newSession: false,
                  messages: [],
                })),
          );
        });
      });

      const first = service.handleMessage('5491155556666', 'hola', 'P1', 'w1');
      await firstStarted;

      const second = service.handleMessage(
        '5491155556666',
        'cotizar',
        'P1',
        'w2',
      );

      // Second message must wait: getConversation called exactly once so far.
      expect(api.getConversation).toHaveBeenCalledTimes(1);

      releaseFirst();
      await Promise.all([first, second]);

      expect(api.getConversation).toHaveBeenCalledTimes(2);
    });

    it('processes messages from different senders concurrently', async () => {
      stubOpenAi();
      api.saveMessage.mockResolvedValue({});
      api.getConversation.mockResolvedValue({
        conversationId: 1,
        client: null,
        newSession: false,
        messages: [],
      });

      await Promise.all([
        service.handleMessage('5491111111111', 'hola', 'P1', 'wa'),
        service.handleMessage('5492222222222', 'hola', 'P1', 'wb'),
      ]);

      expect(api.getConversation).toHaveBeenCalledTimes(2);
    });
  });

  describe('webhook deduplication', () => {
    it('processes a message id only once across Meta re-deliveries', async () => {
      stubOpenAi();
      api.saveMessage.mockResolvedValue({});
      api.getConversation.mockResolvedValue({
        conversationId: 1,
        client: null,
        newSession: false,
        messages: [],
      });

      await service.handleMessage('5491155556666', 'hola', 'P1', 'dup');
      await service.handleMessage('5491155556666', 'hola', 'P1', 'dup');

      expect(api.getConversation).toHaveBeenCalledTimes(1);
      expect(meta.sendText).toHaveBeenCalledTimes(1);
    });
  });

  describe('inbound voice notes', () => {
    const stored = {
      url: '/uploads/audios/a.ogg',
      originalName: 'whatsapp.ogg',
      mimeType: 'audio/ogg',
      size: 4200,
    };

    beforeEach(() => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
      });
      api.saveMessage.mockResolvedValue({});
      api.storeAudio = jest.fn().mockResolvedValue(stored);
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('ogg'),
        mimeType: 'audio/ogg; codecs=opus',
      });
    });

    it('answers the transcription like a typed message and keeps the audio in the inbox', async () => {
      transcriber.transcribe.mockResolvedValue('quiero denunciar un choque');

      await service.handleAudio(
        '5491155556666',
        'audio-1',
        'P1',
        'wa-1',
        'John',
      );

      expect(api.storeAudio).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ mimeType: 'audio/ogg' }),
      );
      expect(transcriber.transcribe).toHaveBeenCalledWith(
        expect.objectContaining({ mimeType: 'audio/ogg; codecs=opus' }),
        'P1',
      );
      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        '🎤 Audio: quiero denunciar un choque',
        stored,
        'John',
      );
      expect(flow.handle).toHaveBeenCalledWith(
        'P1:5491155556666',
        { text: 'quiero denunciar un choque', selectionId: undefined },
        expect.anything(),
      );
      expect(meta.sendText).toHaveBeenCalledWith(
        '5491155556666',
        'reply',
        'P1',
      );
    });

    it('asks the customer to write when the audio cannot be understood', async () => {
      transcriber.transcribe.mockResolvedValue(null);

      await service.handleAudio('5491155556666', 'audio-2', 'P1', 'wa-2');

      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        '🎤 Audio (sin transcripción)',
        stored,
        undefined,
      );
      expect(flow.handle).not.toHaveBeenCalled();
      expect((meta.sendText.mock.calls as string[][])[0][1]).toContain(
        '¿Me lo escribís?',
      );
    });

    it('does not transcribe for a number over its LLM budget', async () => {
      api.getContext.mockResolvedValue({
        systemPrompt: 'x',
        llmEnabled: false,
      });

      await service.handleAudio('5491155556666', 'audio-3', 'P1', 'wa-3');

      expect(transcriber.transcribe).not.toHaveBeenCalled();
      expect((meta.sendText.mock.calls as string[][])[0][1]).toContain(
        'no puedo escuchar audios',
      );
    });

    it('transcribes for the inbox but stays silent while an advisor has the chat', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
        botPaused: true,
      });
      transcriber.transcribe.mockResolvedValue('hola, ¿me llaman?');

      await service.handleAudio('5491155556666', 'audio-4', 'P1', 'wa-4');

      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        '🎤 Audio: hola, ¿me llaman?',
        stored,
        undefined,
      );
      expect(flow.handle).not.toHaveBeenCalled();
      expect(meta.sendText).not.toHaveBeenCalled();
    });

    it('still answers when storing the audio fails', async () => {
      api.storeAudio = jest.fn().mockRejectedValue(new Error('disk full'));
      transcriber.transcribe.mockResolvedValue('hola');

      await service.handleAudio('5491155556666', 'audio-5', 'P1', 'wa-5');

      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        '🎤 Audio: hola',
        undefined,
        undefined,
      );
      expect(meta.sendText).toHaveBeenCalled();
    });
  });

  describe('inbound media (siniestro photos)', () => {
    beforeEach(() => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
      });
      api.saveMessage.mockResolvedValue({});
    });

    it('downloads the image and attaches it to the open claim', async () => {
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('img'),
        mimeType: 'image/jpeg',
      });
      api.attachAdjunto.mockResolvedValue({ siniestroId: 9, adjuntosCount: 2 });

      await service.handleMedia('5491155556666', 'media-1', 'P1', 'wm1');

      expect(meta.downloadMedia).toHaveBeenCalledWith('media-1', 'P1');
      expect(api.attachAdjunto).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ mimeType: 'image/jpeg' }),
        undefined,
      );
      const reply = (meta.sendText.mock.calls as string[][])[0][1];
      expect(reply).toContain('sumé');
    });

    it('stores the actual image metadata in the inbox transcript', async () => {
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('img'),
        mimeType: 'image/jpeg',
      });
      const attachment = {
        url: '/uploads/siniestros/a.webp',
        originalName: 'a.webp',
        mimeType: 'image/webp',
        size: 123,
      };
      api.attachAdjunto.mockResolvedValue({
        siniestroId: 9,
        adjuntosCount: 1,
        attached: true,
        attachments: [attachment],
      });

      await service.handleMedia('5491155556666', 'media-real', 'P1', 'wm-real');

      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        '[El cliente envió una foto]',
        attachment,
        undefined,
      );
    });

    it('keeps the image visible in the inbox when there is no open claim', async () => {
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('img'),
        mimeType: 'image/jpeg',
      });
      const attachment = {
        url: '/uploads/siniestros/unattached.webp',
        originalName: 'unattached.webp',
        mimeType: 'image/webp',
        size: 99,
      };
      api.attachAdjunto.mockResolvedValue({
        siniestroId: null,
        adjuntosCount: 0,
        attached: false,
        attachments: [attachment],
      });

      await service.handleMedia(
        '5491155556666',
        'media-loose',
        'P1',
        'wm-loose',
      );

      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        '[El cliente envió una foto]',
        attachment,
        undefined,
      );
      expect((meta.sendText.mock.calls as string[][])[0][1]).toContain(
        'denuncia',
      );
      expect(flow.handle).not.toHaveBeenCalled();
    });

    it('guides the user when there is no open claim (404)', async () => {
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('img'),
        mimeType: 'image/jpeg',
      });
      api.attachAdjunto.mockRejectedValue({
        isAxiosError: true,
        response: { status: 404 },
      });

      await service.handleMedia('5491155556666', 'media-1', 'P1', 'wm2');

      const reply = (meta.sendText.mock.calls as string[][])[0][1];
      expect(reply).toContain('denuncia');
    });

    it('asks to resend when the download fails', async () => {
      meta.downloadMedia.mockResolvedValue(null);

      await service.handleMedia('5491155556666', 'media-1', 'P1', 'wm3');

      expect(api.attachAdjunto).not.toHaveBeenCalled();
      const reply = (meta.sendText.mock.calls as string[][])[0][1];
      expect(reply).toContain('reenviarla');
    });

    it('stores an inbound image silently when the bot is disabled globally', async () => {
      api.getContext.mockResolvedValue({
        producerName: 'John',
        systemPrompt: 'x',
        botEnabled: false,
      });
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('img'),
        mimeType: 'image/jpeg',
      });
      api.attachAdjunto.mockResolvedValue({
        siniestroId: 9,
        adjuntosCount: 2,
      });

      await service.handleMedia(
        '5491155556666',
        'media-disabled',
        'P1',
        'wm-disabled',
      );

      expect(api.attachAdjunto).toHaveBeenCalled();
      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        '[El cliente envió una foto]',
        undefined,
        undefined,
      );
      expect(flow.handle).not.toHaveBeenCalled();
      expect(meta.sendText).not.toHaveBeenCalled();
    });
  });

  describe('taking out a quoted coverage', () => {
    beforeEach(() => {
      api.getContext.mockResolvedValue({ systemPrompt: 'x', llmEnabled: true });
      api.saveMessage.mockResolvedValue({});
      api.getConversation.mockResolvedValue({
        conversationId: 3,
        client: null,
        newSession: false,
        messages: [],
      });
    });

    it('records the chosen coverage, flags the chat and asks for the DNI', async () => {
      flow.handle.mockResolvedValue({
        messages: [],
        state: {
          step: 'LLM_COTIZACION',
          data: { vehiculo: 'moto' },
          audience: 'lead',
        },
        handoff: 'cotizacion',
      });
      const toolTurn = {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 't1',
                  type: 'function',
                  function: {
                    name: 'request_coverage',
                    arguments: JSON.stringify({
                      vehicleType: 'moto',
                      coverageCode: 'B1',
                      coverageName: 'Todo Total 1',
                      price: '$ 62.614',
                      vehicle: 'HONDA NAVI 110',
                      manufactureYear: 2025,
                      postalCode: 2000,
                    }),
                  },
                },
              ],
            },
          },
        ],
      };
      const create = jest
        .fn()
        .mockResolvedValueOnce(toolTurn)
        .mockResolvedValueOnce({
          choices: [{ message: { content: '¡Buenísimo! Anotamos la B1.' } }],
        });
      (
        service as unknown as {
          openai: { chat: { completions: { create: jest.Mock } } };
        }
      ).openai = { chat: { completions: { create } } };

      await service.handleMessage(
        '5493416956364',
        'me interesa la B1',
        'P1',
        'cov-1',
      );

      expect(api.createLead).toHaveBeenCalledWith(3, {
        productType: 'moto',
        contactName: 'Cliente WhatsApp',
        phone: '5493416956364',
        payload: {
          cobertura: 'B1 — Todo Total 1',
          vehiculo: 'HONDA NAVI 110',
          anio: 2025,
          codigoPostal: 2000,
          precio: '$ 62.614',
        },
      });
      expect(api.requestHandoff).toHaveBeenCalledWith(3);
      expect(api.saveFlowState).toHaveBeenCalledWith(
        3,
        JSON.stringify({
          step: 'COT_DOC_DNI_FRENTE',
          data: { leadId: 42 },
          audience: 'lead',
        }),
      );
      // Confirmation and the first document request go out as one message.
      expect(meta.sendText).toHaveBeenCalledTimes(1);
      const body = (meta.sendText.mock.calls as string[][])[0][1];
      expect(body).toContain('Anotamos la B1');
      expect(body).toContain('frente de tu DNI');
    });

    it('stores a photo sent during the documents on that request', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 3,
        client: null,
        newSession: false,
        messages: [],
        flowState: JSON.stringify({
          step: 'COT_DOC_DNI_DORSO',
          data: { leadId: 42 },
        }),
      });
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('img'),
        mimeType: 'image/jpeg',
      });
      flow.handle.mockResolvedValue({
        messages: [{ kind: 'text', body: 'Por último, la tarjeta azul' }],
        state: { step: 'COT_DOC_TARJETA_AZUL', data: { leadId: 42 } },
      });

      await service.handleMedia('5493416956364', 'media-9', 'P1', 'wm-9');

      expect(api.attachLeadAdjunto).toHaveBeenCalledWith(
        3,
        42,
        expect.objectContaining({ mimeType: 'image/jpeg' }),
        'dni_dorso',
      );
      expect(api.attachAdjunto).not.toHaveBeenCalled();
      expect(flow.handle).toHaveBeenCalledWith(
        expect.any(String),
        { text: '', selectionId: '__photo_received__' },
        expect.anything(),
      );
    });
  });
});
