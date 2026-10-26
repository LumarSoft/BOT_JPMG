import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  PHOTO_REPLY_DELAY_MS,
  takeMenuMarker,
  WebhookService,
} from './webhook.service';
import { claimPhotoAddedText } from './flow/flow.messages';
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
        .mockResolvedValue({ leadId: 42, attachmentCount: 1 }),
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
    // No test reaches the real OpenAI: a photo out of the blue is looked at by
    // the model, and tests that need an answer stub their own.
    (
      service as unknown as {
        openai: { chat: { completions: { create: jest.Mock } } };
      }
    ).openai = {
      chat: {
        completions: {
          create: jest.fn().mockRejectedValue(new Error('OpenAI sin stub')),
        },
      },
    };
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

  it('shows the menu under an answer that points to one of its options', async () => {
    const create = stubOpenAi();
    create.mockResolvedValue({
      choices: [
        {
          message: {
            content:
              'Para ver tu deuda tocá *Pagos y cobranzas* acá abajo. [MENU]',
            tool_calls: [],
          },
          finish_reason: 'stop',
        },
      ],
    });
    api.getContext.mockResolvedValue({ systemPrompt: 'x', llmEnabled: true });
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
      state: { step: 'LLM_FAQ', data: {} },
      handoff: 'faq',
    });

    await service.handleMessage('5491155556666', 'cuánto debo', 'P1', 'mn-1');

    expect(meta.sendText).toHaveBeenCalledWith(
      '5491155556666',
      'Para ver tu deuda tocá *Pagos y cobranzas* acá abajo.',
      'P1',
    );
    expect(meta.sendList).toHaveBeenCalledWith(
      '5491155556666',
      expect.anything(),
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ id: 'm_pagos' })]),
      'P1',
    );
  });

  describe('takeMenuMarker', () => {
    it('removes the marker and asks for the menu', () => {
      expect(takeMenuMarker('Tocá *Siniestros* acá abajo. [MENU]')).toEqual({
        text: 'Tocá *Siniestros* acá abajo.',
        menu: true,
      });
    });

    it('still shows the menu when the model tells them to write "menú"', () => {
      expect(
        takeMenuMarker('Para eso escribí *menú* y elegí Pagos.').menu,
      ).toBe(true);
    });

    it('leaves an ordinary answer alone', () => {
      expect(takeMenuMarker('El seguro de bici cubre robo.')).toEqual({
        text: 'El seguro de bici cubre robo.',
        menu: false,
      });
    });
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

  it('tells the flow whether the customer is answering a person or the bot', async () => {
    const humanReply = {
      content: 'Pasame las fotos',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    };
    api.getContext.mockResolvedValue({ systemPrompt: 'x', llmEnabled: true });
    api.saveMessage.mockResolvedValue({});
    api.getConversation.mockResolvedValueOnce({
      conversationId: 1,
      client: null,
      newSession: true,
      messages: [],
      botPaused: false,
      flowState: null,
      lastHumanReply: humanReply,
    });
    flow.handle.mockResolvedValueOnce({ messages: [], state: null });

    await service.handleMessage(
      '5491155556666',
      'ya te las mandé',
      'P1',
      'f-1',
    );

    expect(flow.handle).toHaveBeenLastCalledWith(
      'P1:5491155556666',
      expect.anything(),
      expect.objectContaining({
        answeringPerson: true,
        lastHumanReply: humanReply,
      }),
    );

    // Same person, but the bot has spoken in this session since.
    api.getConversation.mockResolvedValueOnce({
      conversationId: 1,
      client: null,
      newSession: false,
      messages: [
        { id: 1, role: 'user', content: 'hola', createdAt: '' },
        {
          id: 2,
          role: 'assistant',
          content: '¿ya sos cliente?',
          createdAt: '',
        },
      ],
      botPaused: false,
      flowState: JSON.stringify({ step: 'ROOT', data: {} }),
      lastHumanReply: humanReply,
    });
    flow.handle.mockResolvedValueOnce({ messages: [], state: null });

    await service.handleMessage('5491155556666', 'sí', 'P1', 'f-2');

    expect(flow.handle).toHaveBeenLastCalledWith(
      'P1:5491155556666',
      expect.anything(),
      expect.objectContaining({ answeringPerson: false }),
    );
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

  describe('model actions (19/10)', () => {
    const picker = {
      kind: 'list' as const,
      body: '¿De qué póliza querés la documentación?',
      button: 'Ver pólizas',
      rows: [
        { id: 'pol_1', title: 'FORD RANGER' },
        { id: 'pol_2', title: 'CHEVROLET CRUZE' },
      ],
    };

    beforeEach(() => {
      api.getContext.mockResolvedValue({ systemPrompt: 'x', llmEnabled: true });
      api.saveMessage.mockResolvedValue({});
      api.getConversation.mockResolvedValue({
        conversationId: 1,
        client: null,
        newSession: false,
        messages: [],
      });
    });

    /** The model calls `name` with `args` on its first round. */
    function modelCalls(name: string, args: object) {
      const create = jest.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'a1',
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
      });
      (
        service as unknown as {
          openai: { chat: { completions: { create: jest.Mock } } };
        }
      ).openai = { chat: { completions: { create } } };
      return create;
    }

    it('opens the option the customer asked for instead of telling them what to type', async () => {
      const create = modelCalls('abrir_opcion', { opcion: 'documentacion' });
      flow.handle
        .mockResolvedValueOnce({
          messages: [],
          state: { step: 'COTIZAR_TIPO', data: {} },
          handoff: 'faq',
        })
        .mockResolvedValueOnce({
          messages: [{ kind: 'text', body: 'Ahí te mandé la póliza' }],
          state: { step: 'CLIENT_MENU', data: {} },
        });

      await service.handleMessage(
        '5491155556666',
        'No, que me envíes una póliza que ya está emitida!!',
        'P1',
        'act-1',
      );

      const [request] = create.mock.calls[0] as [
        { tools: { function: { name: string } }[] },
      ];
      expect(request.tools.map((t) => t.function.name)).toEqual([
        'abrir_opcion',
        'pasar_a_la_oficina',
      ]);
      expect(flow.handle).toHaveBeenLastCalledWith(
        'P1:5491155556666',
        {
          text: 'No, que me envíes una póliza que ya está emitida!!',
          selectionId: 'm_documentos',
        },
        expect.objectContaining({
          flowState: { step: 'COTIZAR_TIPO', data: {} },
        }),
      );
      expect(meta.sendText).toHaveBeenCalledTimes(1);
      expect(meta.sendText).toHaveBeenCalledWith(
        '5491155556666',
        'Ahí te mandé la póliza',
        'P1',
      );
      expect(api.saveFlowState).toHaveBeenLastCalledWith(
        1,
        JSON.stringify({ step: 'CLIENT_MENU', data: {} }),
      );
    });

    it('passes a request only the office can do with its summary and what was written', async () => {
      modelCalls('pasar_a_la_oficina', {
        resumen: 'Pide agregar a una persona a la póliza.',
      });
      flow.handle
        .mockResolvedValueOnce({ messages: [], state: null, handoff: 'faq' })
        .mockResolvedValueOnce({
          messages: [{ kind: 'text', body: 'Listo, tomé nota' }],
          state: null,
        });

      await service.handleMessage(
        '5491155556666',
        'Te paso para agregar a la póliza',
        'P1',
        'act-2',
      );

      expect(flow.handle).toHaveBeenLastCalledWith(
        'P1:5491155556666',
        {
          text: 'Pide agregar a una persona a la póliza. Escribió: "Te paso para agregar a la póliza"',
          selectionId: 'm_pedido_oficina',
        },
        expect.anything(),
      );
    });

    it('picks a row of the list on screen, and only one that is there', async () => {
      const create = modelCalls('elegir_de_la_lista', { id: 'pol_2' });
      flow.handle
        .mockResolvedValueOnce({
          messages: [],
          state: { step: 'DOC_POLIZA', data: {} },
          handoff: 'faq',
          onScreen: picker,
        })
        .mockResolvedValueOnce({ messages: [], state: null });

      await service.handleMessage(
        '5491155556666',
        'la del cruze',
        'P1',
        'act-3',
      );

      const [request] = create.mock.calls[0] as [
        {
          messages: { content: string }[];
          tools: { function: { name: string; parameters: object } }[];
        },
      ];
      expect(request.messages[0].content).toContain('## LISTA EN PANTALLA');
      expect(request.messages[0].content).toContain('- pol_2: CHEVROLET CRUZE');
      expect(JSON.stringify(request.tools)).toContain(
        '"enum":["pol_1","pol_2"]',
      );
      expect(flow.handle).toHaveBeenLastCalledWith(
        'P1:5491155556666',
        { text: '', selectionId: 'pol_2' },
        expect.anything(),
      );
    });

    it('does not act on an id that is not on the list', async () => {
      const create = jest
        .fn()
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'a1',
                    type: 'function',
                    function: {
                      name: 'elegir_de_la_lista',
                      arguments: '{"id":"pol_9"}',
                    },
                  },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [
            { message: { content: '¿Cuál de las dos?', tool_calls: [] } },
          ],
        });
      (
        service as unknown as {
          openai: { chat: { completions: { create: jest.Mock } } };
        }
      ).openai = { chat: { completions: { create } } };
      flow.handle.mockResolvedValueOnce({
        messages: [],
        state: { step: 'DOC_POLIZA', data: {} },
        handoff: 'faq',
        onScreen: picker,
      });

      await service.handleMessage('5491155556666', 'la otra', 'P1', 'act-4');

      expect(flow.handle).toHaveBeenCalledTimes(1);
      expect(meta.sendText).toHaveBeenCalledWith(
        '5491155556666',
        '¿Cuál de las dos?',
        'P1',
      );
    });

    it('shows the list again under an answer in words', async () => {
      stubOpenAi();
      flow.handle.mockResolvedValueOnce({
        messages: [],
        state: { step: 'DOC_POLIZA', data: {} },
        handoff: 'faq',
        onScreen: picker,
      });

      await service.handleMessage(
        '5491155556666',
        '¿y eso qué es?',
        'P1',
        'act-5',
      );

      expect(meta.sendText).toHaveBeenCalledWith(
        '5491155556666',
        'reply',
        'P1',
      );
      expect(meta.sendList).toHaveBeenCalledWith(
        '5491155556666',
        picker.body,
        picker.button,
        picker.rows,
        'P1',
      );
    });

    it('the turn an action led to cannot act again', async () => {
      const create = modelCalls('abrir_opcion', { opcion: 'cotizar' });
      flow.handle
        .mockResolvedValueOnce({ messages: [], state: null, handoff: 'faq' })
        .mockResolvedValueOnce({ messages: [], state: null, handoff: 'faq' });

      await service.handleMessage(
        '5491155556666',
        'quiero asegurar',
        'P1',
        'act-6',
      );

      expect(flow.handle).toHaveBeenCalledTimes(2);
      const second = create.mock.calls[1] as [{ tools?: unknown }];
      expect(second[0].tools).toBeUndefined();
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
          knownGnc?: boolean,
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
        false,
      );

      expect(api.quoteVehicle).toHaveBeenCalledWith('auto', {
        brand: '12',
        model: '120632',
        manufactureYear: 2024,
        postalCode: 2000,
        hasGnc: false,
      });
    });

    it('alerts the office once when Triunfo does not answer and keeps attending', async () => {
      const privateService = service as unknown as {
        executeTool: (
          name: string,
          args: string,
          conversationId: number,
          remembered?: typeof memory,
          knownGnc?: boolean,
        ) => Promise<string>;
      };
      api.quoteVehicle.mockRejectedValue({
        isAxiosError: true,
        code: 'ECONNABORTED',
        message: 'timeout of 20000ms exceeded',
      });
      const args = JSON.stringify({
        vehicleType: 'auto',
        codia: 120632,
        manufactureYear: 2024,
        postalCode: 2000,
      });

      const chosen = { ...memory, selected: memory.candidates[1] };
      const first = JSON.parse(
        await privateService.executeTool(
          'quote_vehicle',
          args,
          9,
          chosen,
          false,
        ),
      ) as { officeNotified?: boolean; nextStep?: string };
      await privateService.executeTool('quote_vehicle', args, 9, chosen, false);

      expect(first.officeNotified).toBe(true);
      expect(typeof first.nextStep).toBe('string');
      expect(api.requestHandoff).toHaveBeenCalledTimes(1);
      expect(api.requestHandoff).toHaveBeenCalledWith(
        9,
        expect.stringContaining(
          'CHEVROLET ONIX 1.0T PREMIER II AT L/24, año 2024, CP 2000',
        ),
      );
    });

    it('treats a quote Triunfo could not value as incomplete and alerts the office', async () => {
      const privateService = service as unknown as {
        executeTool: (
          name: string,
          args: string,
          conversationId: number,
          remembered?: typeof memory,
          knownGnc?: boolean,
        ) => Promise<string>;
      };
      api.quoteVehicle.mockResolvedValue({
        quoteNumber: '1',
        validUntil: '2026-11-11',
        vehicleValue: '0.00',
        valuationMissing: true,
        messages: [],
        coverages: [
          {
            code: 'A',
            name: 'Responsabilidad Civil',
            paymentOptions: [
              {
                code: '1',
                name: 'Débito Automático',
                premium: 67825,
                installmentValue: 67825,
                installments: 1,
              },
            ],
          },
        ],
      });

      const result = JSON.parse(
        await privateService.executeTool(
          'quote_vehicle',
          JSON.stringify({
            vehicleType: 'auto',
            codia: 120632,
            manufactureYear: 2024,
            postalCode: 2000,
          }),
          9,
          { ...memory, selected: memory.candidates[1] } as typeof memory,
          false,
        ),
      ) as {
        cotizacionIncompleta?: boolean;
        officeNotified?: boolean;
        nextStep?: string;
        coberturas: Array<{ codigo: string }>;
      };

      expect(result.cotizacionIncompleta).toBe(true);
      expect(result.officeNotified).toBe(true);
      expect(result.nextStep).toContain('NO digas que el vehículo no tiene');
      expect(result.coberturas.map((c) => c.codigo)).toEqual(['A']);
      expect(api.requestHandoff).toHaveBeenCalledWith(
        9,
        expect.stringContaining('no pudo valuar el vehículo'),
      );
    });

    it('returns a valued quote untouched, without alerting the office', async () => {
      const privateService = service as unknown as {
        executeTool: (
          name: string,
          args: string,
          conversationId: number,
          remembered?: undefined,
          knownGnc?: boolean,
        ) => Promise<string>;
      };
      api.quoteVehicle.mockResolvedValue({
        quoteNumber: '1',
        validUntil: '2026-11-11',
        vehicleValue: '7800000.00',
        valuationMissing: false,
        messages: [],
        coverages: [
          {
            code: 'A',
            name: 'Responsabilidad Civil',
            paymentOptions: [
              {
                code: '1',
                name: 'Con tarjeta',
                premium: 67825,
                installmentValue: 67825,
                installments: 1,
              },
            ],
          },
        ],
      });

      const result = JSON.parse(
        await privateService.executeTool(
          'quote_vehicle',
          JSON.stringify({
            vehicleType: 'auto',
            codia: 120632,
            manufactureYear: 2024,
            postalCode: 2000,
          }),
          9,
          undefined,
          false,
        ),
      ) as { cotizacionIncompleta?: boolean };

      expect(result.cotizacionIncompleta).toBeUndefined();
      expect(api.requestHandoff).not.toHaveBeenCalled();
    });

    describe('version the client chose (14/10)', () => {
      type Tool = (
        name: string,
        args: string,
        conversationId: number,
        remembered?: Record<string, unknown>,
        knownGnc?: boolean,
      ) => Promise<string>;
      const tool = () =>
        (service as unknown as { executeTool: Tool }).executeTool.bind(service);
      const quoteArgs = (codia: number) =>
        JSON.stringify({
          vehicleType: 'auto',
          codia,
          manufactureYear: 2024,
          postalCode: 2000,
        });
      const valued = {
        quoteNumber: '1',
        validUntil: null,
        vehicleValue: '25000000.00',
        valuationMissing: false,
        messages: [],
        coverages: [
          {
            code: 'A',
            name: 'Responsabilidad Civil',
            paymentOptions: [
              {
                code: '1',
                name: 'Con tarjeta',
                premium: 67825,
                installmentValue: 67825,
                installments: 1,
              },
            ],
          },
        ],
      };

      it('does not quote a CODIA that is not among the versions found', async () => {
        const result = JSON.parse(
          await tool()('quote_vehicle', quoteArgs(208001), 9, memory, false),
        ) as { error?: string };
        expect(result.error).toContain('no está entre las versiones');
        expect(api.quoteVehicle).not.toHaveBeenCalled();
      });

      it('asks the client once to pick between close versions, then quotes the pick', async () => {
        const held = JSON.parse(
          await tool()('quote_vehicle', quoteArgs(120632), 9, memory, false),
        ) as { needsVersionChoice?: boolean };
        expect(held.needsVersionChoice).toBe(true);
        expect(api.quoteVehicle).not.toHaveBeenCalled();

        api.quoteVehicle.mockResolvedValue(valued);
        await tool()(
          'quote_vehicle',
          quoteArgs(120632),
          9,
          { ...memory, versionAsked: true },
          false,
        );
        expect(api.quoteVehicle).toHaveBeenCalledTimes(1);
      });

      it('tells the model to search again instead of blaming the client for an unknown version', async () => {
        api.quoteVehicle.mockRejectedValue({
          isAxiosError: true,
          response: {
            status: 400,
            data: {
              message: 'No se encontró la versión del vehículo en el catálogo',
            },
          },
          message: 'Request failed with status code 400',
        });
        const result = JSON.parse(
          await tool()(
            'quote_vehicle',
            quoteArgs(120632),
            9,
            { ...memory, selected: memory.candidates[1] },
            false,
          ),
        ) as { nextStep?: string };
        expect(result.nextStep).toContain('find_vehicle');
        expect(result.nextStep).toContain('No le pidas');
      });

      it('alerts the office when the company turns the whole vehicle down', async () => {
        api.quoteVehicle.mockResolvedValue({
          ...valued,
          vehicleValue: '64000000.00',
          coverages: [],
          messages: ['Datos de vehículo no válidos'],
        });
        const result = JSON.parse(
          await tool()(
            'quote_vehicle',
            quoteArgs(120632),
            9,
            { ...memory, selected: memory.candidates[1] },
            false,
          ),
        ) as {
          sinCotizacion?: boolean;
          officeNotified?: boolean;
          sumaAsegurada?: string | null;
        };
        expect(result.sinCotizacion).toBe(true);
        expect(result.officeNotified).toBe(true);
        // A default value that comes with a rejection is not a valuation.
        expect(result.sumaAsegurada).toBeNull();
        expect(api.requestHandoff).toHaveBeenCalledWith(
          9,
          expect.stringContaining('Datos de vehículo no válidos'),
        );
      });

      it('sends a 0 km and the GNC answer to the quote', async () => {
        api.quoteVehicle.mockResolvedValue(valued);
        await tool()(
          'quote_vehicle',
          JSON.stringify({
            vehicleType: 'auto',
            codia: 120632,
            manufactureYear: 2026,
            postalCode: 2000,
            isZeroKm: true,
          }),
          9,
          { ...memory, selected: memory.candidates[1] },
          true,
        );
        expect(api.quoteVehicle).toHaveBeenCalledWith(
          'auto',
          expect.objectContaining({ zeroKm: true, hasGnc: true }),
        );
      });

      type Select = (
        memory: Record<string, unknown>,
        text: string,
        previous?: string,
        fromClient?: boolean,
      ) => { selected?: { codia: number } } | undefined;
      const select = (text: string, previous?: string, fromClient?: boolean) =>
        (
          service as unknown as { selectRememberedVehicle: Select }
        ).selectRememberedVehicle.call(
          service,
          {
            vehicleType: 'auto',
            candidates: [
              { codia: 120248, description: 'CORSA 1.6 4P GL' },
              { codia: 120249, description: 'CORSA 1.6 4P GL GNC' },
              { codia: 120250, description: 'CORSA 1.6 5P GLS' },
            ],
          },
          text,
          previous,
          fromClient,
        )?.selected?.codia;
      const listed =
        '1. CORSA 1.6 4P GL\n2. CORSA 1.6 4P GL GNC\n3. CORSA 1.6 5P GLS';

      it.each([
        ['la 1, la común', 120248],
        ['La primera', 120248],
        ['la segunda', 120249],
        ['opción 3', 120250],
        ['la última', 120250],
        ['la GL GNC', 120249],
        // "5 puertas" is how people (and the bot) say InfoAuto's "5P".
        ['la de 5 puertas GLS', 120250],
        ['GLS', 120250],
      ])('reads "%s" as the client picking a version', (text, codia) => {
        expect(select(text, listed)).toBe(codia);
      });

      it('reads a pick against the short labels the bot listed', () => {
        const short = '1. GL\n2. GL GNC\n3. GLS';
        expect(select('la 1', short)).toBe(120248);
        expect(select('2', short)).toBe(120249);
        expect(select('la tercera', short)).toBe(120250);
        expect(select('la 7', short)).toBeUndefined();
      });

      it('reads a pick when the bot wrote "puertas" for InfoAuto\'s "P"', () => {
        // The 14/10 suite: "1" against "1. 3 puertas L/13" picked nothing and
        // the quote stopped with "hay varias versiones posibles".
        const pick = (
          service as unknown as { selectRememberedVehicle: Select }
        ).selectRememberedVehicle.bind(service) as Select;
        const gol = (text: string, previous: string) =>
          pick(
            {
              vehicleType: 'auto',
              candidates: [
                { codia: 460727, description: 'GOL TREND 1.6 3 P L/13' },
                {
                  codia: 460773,
                  description: 'GOL TREND 1.6 3 P L/13 HIGHLINE',
                },
                { codia: 460740, description: 'GOL TREND 1.6 5 P L/13 PACK I' },
              ],
            },
            text,
            previous,
          )?.selected?.codia;
        const shown =
          '1. 3 puertas L/13\n2. 3 puertas L/13 Highline\n3. 5 puertas L/13 Pack I';
        expect(gol('1', shown)).toBe(460727);
        expect(gol('la 2', shown)).toBe(460773);
        expect(gol('3', shown)).toBe(460740);
      });

      it('does not read an engine size, a position without a list or the bot list as a pick', () => {
        expect(select('1.6 nafta', listed)).toBeUndefined();
        // The bot asked "¿motor o puertas?" instead of listing them.
        expect(
          select('la primera', '¿Me indicás el motor o las puertas?'),
        ).toBeUndefined();
        expect(select(listed, undefined, false)).toBeUndefined();
      });

      it('shows the model the versions with their CODIA and the GNC answer before a pick', () => {
        const rendered = (
          service as unknown as {
            renderRememberedVehicle: (
              m: Record<string, unknown>,
              gnc?: boolean,
            ) => string;
          }
        ).renderRememberedVehicle.call(service, memory, false);
        expect(rendered).toContain('CODIA `120581`');
        expect(rendered).toContain('CODIA `120632`');
        expect(rendered).toContain(
          'GNC ya respondido por la persona: no tiene',
        );
      });
    });

    it('does not quote a car before knowing whether it has GNC', async () => {
      const privateService = service as unknown as {
        executeTool: (
          name: string,
          args: string,
          conversationId: number,
          remembered?: undefined,
          knownGnc?: boolean,
        ) => Promise<string>;
      };

      const result = JSON.parse(
        await privateService.executeTool(
          'quote_vehicle',
          JSON.stringify({
            vehicleType: 'auto',
            codia: 120632,
            manufactureYear: 2024,
            postalCode: 2000,
          }),
          9,
        ),
      ) as { error?: string };

      expect(result.error).toContain('GNC');
      expect(api.quoteVehicle).not.toHaveBeenCalled();
      expect(api.requestHandoff).not.toHaveBeenCalled();
    });

    it('does not alert the office when the quote is rejected for the data', async () => {
      const privateService = service as unknown as {
        executeTool: (
          name: string,
          args: string,
          conversationId: number,
          remembered?: undefined,
          knownGnc?: boolean,
        ) => Promise<string>;
      };
      api.quoteVehicle.mockRejectedValue({
        isAxiosError: true,
        message: 'Request failed with status code 400',
        response: { status: 400, data: { message: 'Modelo y año inválidos' } },
      });

      const result = JSON.parse(
        await privateService.executeTool(
          'quote_vehicle',
          JSON.stringify({
            vehicleType: 'auto',
            codia: 120632,
            manufactureYear: 1990,
            postalCode: 2000,
          }),
          9,
          undefined,
          false,
        ),
      ) as { officeNotified?: boolean };

      expect(result.officeNotified).toBeUndefined();
      expect(api.requestHandoff).not.toHaveBeenCalled();
    });

    it('does not call the API when the CODIA is invalid and no verified selection exists', async () => {
      const privateService = service as unknown as {
        executeTool: (
          name: string,
          args: string,
          conversationId: number,
          remembered?: undefined,
          knownGnc?: boolean,
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

  describe('quote facts that outlive the history window', () => {
    type Memory = {
      vehicleType: 'auto' | 'moto';
      brandName?: string;
      candidates: Array<{ codia: number; description: string }>;
      selected?: { codia: number; description: string };
      hasGnc?: boolean;
      quoted?: {
        manufactureYear: number;
        postalCode: number;
        outcome: string;
        coverages: string[];
      };
    };
    const astra = { codia: 120236, description: 'ASTRA II GL 2.0 5 PTAS' };
    const memory: Memory = {
      vehicleType: 'auto',
      brandName: 'CHEVROLET',
      candidates: [
        { codia: 120239, description: 'ASTRA II GL 2.0 4 PTAS' },
        astra,
      ],
      selected: astra,
    };
    const priv = () =>
      service as unknown as {
        rememberQuote: (m: Memory, args: string, result: string) => Memory;
        rememberVehicleSearch: (
          m: Memory,
          result: string,
          args: string,
        ) => Memory;
        selectRememberedVehicle: (
          m: Memory,
          text: string,
          previous?: string,
        ) => Memory;
        renderRememberedVehicle: (m: Memory) => string;
        readQuoteVehicleMemory: (state: unknown) => Memory | undefined;
      };
    const args = JSON.stringify({
      vehicleType: 'auto',
      codia: 120236,
      manufactureYear: 2009,
      postalCode: 2000,
    });

    it('keeps the year, postal code and outcome of a quote', () => {
      const next = priv().rememberQuote(
        memory,
        args,
        JSON.stringify({ coberturas: [{ codigo: 'A' }, { codigo: 'B1' }] }),
      );
      expect(next.quoted).toEqual({
        manufactureYear: 2009,
        postalCode: 2000,
        outcome: 'cotizada',
        coverages: ['A', 'B1'],
      });
    });

    it('records an incomplete quote and a failed one, but not a rejected year', () => {
      expect(
        priv().rememberQuote(
          memory,
          args,
          JSON.stringify({
            cotizacionIncompleta: true,
            coberturas: [{ codigo: 'A' }],
          }),
        ).quoted?.outcome,
      ).toBe('incompleta');
      expect(
        priv().rememberQuote(
          memory,
          args,
          JSON.stringify({ error: 'timeout', officeNotified: true }),
        ).quoted?.outcome,
      ).toBe('sin_respuesta');
      expect(
        priv().rememberQuote(
          memory,
          args,
          JSON.stringify({ error: 'Modelo y año inválidos', status: 400 }),
        ).quoted,
      ).toBeUndefined();
    });

    it('keeps settled facts when the same vehicle is searched again, drops them for another', () => {
      const settled: Memory = {
        ...memory,
        hasGnc: true,
        quoted: {
          manufactureYear: 2009,
          postalCode: 2000,
          outcome: 'incompleta',
          coverages: ['A'],
        },
      };
      const same = priv().rememberVehicleSearch(
        settled,
        JSON.stringify({
          brand: { id: 12, name: 'CHEVROLET' },
          versions: [astra],
        }),
        args,
      );
      expect(same.quoted?.postalCode).toBe(2000);
      expect(same.hasGnc).toBe(true);

      const other = priv().selectRememberedVehicle(
        settled,
        '1',
        '1. ASTRA II GL 2.0 4 PTAS\n2. ASTRA II GL 2.0 5 PTAS',
      );
      expect(other.selected?.codia).toBe(120239);
      expect(other.quoted).toBeUndefined();
      expect(other.hasGnc).toBeUndefined();
    });

    it('tells the model the facts it may no longer see, and survives a restart', () => {
      const settled: Memory = {
        ...memory,
        hasGnc: true,
        quoted: {
          manufactureYear: 2009,
          postalCode: 2000,
          outcome: 'incompleta',
          coverages: ['A'],
        },
      };
      const restored = priv().readQuoteVehicleMemory({
        step: 'LLM_COTIZACION',
        data: { quoteVehicle: JSON.parse(JSON.stringify(settled)) as unknown },
      });
      expect(restored).toEqual(settled);

      const prompt = priv().renderRememberedVehicle(settled);
      expect(prompt).toContain('año 2009');
      expect(prompt).toContain('código postal 2000');
      expect(prompt).toContain('GNC: sí tiene');
      expect(prompt).toContain('Nunca digas que no hay cobertura con robo');
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
      jest.useFakeTimers();
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
      });
      api.saveMessage.mockResolvedValue({});
    });
    afterEach(() => jest.useRealTimers());

    /** Lets the batched photo reply go out (it waits for more photos first). */
    async function settlePhotoReplies() {
      await jest.advanceTimersByTimeAsync(PHOTO_REPLY_DELAY_MS);
      const queues = (
        service as unknown as { queues: Map<string, Promise<void>> }
      ).queues;
      await Promise.all([...queues.values()]);
    }
    const sentTexts = () =>
      (meta.sendText.mock.calls as string[][]).map((call) => call[1]);
    const image = { buffer: Buffer.from('img'), mimeType: 'image/jpeg' };

    it('downloads the image and attaches it to the open claim', async () => {
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('img'),
        mimeType: 'image/jpeg',
      });
      api.attachAdjunto.mockResolvedValue({ claimId: 9, attachmentCount: 2 });

      await service.handleMedia('5491155556666', 'media-1', 'P1', 'wm1');
      await settlePhotoReplies();

      expect(meta.downloadMedia).toHaveBeenCalledWith('media-1', 'P1');
      expect(api.attachAdjunto).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ mimeType: 'image/jpeg' }),
        undefined,
        false,
      );
      const reply = (meta.sendText.mock.calls as string[][])[0][1];
      expect(reply).toContain('sumé');
    });

    it('keeps a photo sent while filling in a new claim out of an earlier claim', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
        flowState: JSON.stringify({
          step: 'SINIESTRO_DATOS',
          data: {},
          audience: 'client',
        }),
      });
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ claimId: null, attached: false });

      await service.handleMedia('5491155556666', 'media-1', 'P1', 'wm1');
      await settlePhotoReplies();

      expect(api.attachAdjunto).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ mimeType: 'image/jpeg' }),
        undefined,
        true,
      );
      expect(sentTexts().join(' ')).toContain('Terminemos primero los datos');
      expect(sentTexts().join(' ')).not.toContain('sumé');
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
        claimId: 9,
        attachmentCount: 1,
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
        claimId: null,
        attachmentCount: 0,
        attached: false,
        attachments: [attachment],
      });

      await service.handleMedia(
        '5491155556666',
        'media-loose',
        'P1',
        'wm-loose',
      );
      await settlePhotoReplies();

      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        '[El cliente envió una foto]',
        attachment,
        undefined,
      );
      // Outside a claim step nobody said the photo is for a claim (a moto to
      // quote got "registremos la denuncia"): ask what it is for.
      const reply = (meta.sendText.mock.calls as string[][])[0][1];
      expect(reply).toContain('para qué es');
      expect(reply).not.toContain('denuncia');
      expect(flow.handle).not.toHaveBeenCalled();
    });

    it('stays out of a photo sent to a person from the office', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: true,
        messages: [],
        botPaused: false,
        flowState: null,
        lastHumanReply: {
          content: 'Pasame las fotos que tenés',
          createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
      });
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('img'),
        mimeType: 'image/jpeg',
      });
      api.attachAdjunto.mockResolvedValue({
        claimId: null,
        attachmentCount: 0,
        attached: false,
        attachments: [],
      });

      await service.handleMedia('5491155556666', 'media-p', 'P1', 'wm-p');
      await settlePhotoReplies();

      expect(meta.sendText).not.toHaveBeenCalled();
    });

    it('does not suggest typing "siniestro" while the claim details are being collected', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
        botPaused: false,
        flowState: JSON.stringify({ step: 'SINIESTRO_DATOS', data: {} }),
      });
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('img'),
        mimeType: 'image/jpeg',
      });
      api.attachAdjunto.mockResolvedValue({
        claimId: null,
        attachmentCount: 0,
        attached: false,
        attachments: [],
      });

      await service.handleMedia('5491155556666', 'media-d', 'P1', 'wm-d');
      await settlePhotoReplies();

      const reply = (meta.sendText.mock.calls as string[][])[0][1];
      expect(reply).toContain('Terminemos primero los datos');
      expect(reply).not.toContain('Escribime');
    });

    it('asks to file the claim first when a claim photo step has no claim', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
        botPaused: false,
        flowState: JSON.stringify({ step: 'SINIESTRO_FOTO_TARJETA', data: {} }),
      });
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('img'),
        mimeType: 'image/jpeg',
      });
      api.attachAdjunto.mockResolvedValue({
        claimId: null,
        attachmentCount: 0,
        attached: false,
        attachments: [],
      });

      await service.handleMedia('5491155556666', 'media-x', 'P1', 'wm-x');
      await settlePhotoReplies();

      expect((meta.sendText.mock.calls as string[][])[0][1]).toContain(
        'registremos la denuncia',
      );
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
        claimId: 9,
        attachmentCount: 2,
      });

      await service.handleMedia(
        '5491155556666',
        'media-disabled',
        'P1',
        'wm-disabled',
      );
      await settlePhotoReplies();

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

    it('answers several photos sent together once', async () => {
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ claimId: 9, attached: true });

      for (const n of [1, 2, 3])
        await service.handleMedia('5491155556666', `m${n}`, 'P1', `wb${n}`);
      expect(meta.sendText).not.toHaveBeenCalled();
      await settlePhotoReplies();

      expect(api.attachAdjunto).toHaveBeenCalledTimes(3);
      expect(sentTexts()).toEqual([
        '📎 Recibí tus 3 fotos y las sumé a la denuncia que hiciste. Si tenés más, mandámelas.',
      ]);
    });

    it('asks once what several loose photos are for', async () => {
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ attached: false, attachments: [] });

      await service.handleMedia('5491155556666', 'u1', 'P1', 'wu1');
      await service.handleMedia('5491155556666', 'u2', 'P1', 'wu2');
      await settlePhotoReplies();

      expect(sentTexts()).toHaveLength(1);
      expect(sentTexts()[0]).toContain(
        '¡Recibí tus 2 fotos! Contame para qué son',
      );
    });

    it('drops "para qué son" when the customer explains right away', async () => {
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ attached: false, attachments: [] });
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
        botPaused: false,
        flowState: null,
      });

      await service.handleMedia('5491155556666', 'q1', 'P1', 'wq1');
      await service.handleMessage(
        '5491155556666',
        'son de mi moto para cotizar',
        'P1',
        'wq2',
      );
      await settlePhotoReplies();

      expect(sentTexts()).toEqual(['reply']);
    });

    it('answers the photos before a message that came after them', async () => {
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ claimId: 9, attached: true });
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
        botPaused: false,
        flowState: null,
      });

      await service.handleMedia('5491155556666', 'o1', 'P1', 'wo1');
      await service.handleMedia('5491155556666', 'o2', 'P1', 'wo2');
      await service.handleMessage('5491155556666', 'listo', 'P1', 'wo3');

      expect(sentTexts()[0]).toContain('Recibí tus 2 fotos');
      expect(sentTexts()).toContain('reply');
      expect(sentTexts().indexOf('reply')).toBeGreaterThan(0);
      await settlePhotoReplies();
      expect(sentTexts().filter((t) => t.includes('Recibí'))).toHaveLength(1);
    });

    it('words the claim photo step reply for the whole batch', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
        botPaused: false,
        flowState: JSON.stringify({ step: 'SINIESTRO_FOTO_DANIO', data: {} }),
      });
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ claimId: 9, attached: true });
      flow.handle.mockResolvedValue({
        messages: [{ kind: 'text', body: claimPhotoAddedText() }],
        state: { step: 'SINIESTRO_FOTO_DANIO', data: {} },
      });

      for (const n of [1, 2, 3])
        await service.handleMedia('5491155556666', `d${n}`, 'P1', `wd${n}`);
      await settlePhotoReplies();

      expect(flow.handle).toHaveBeenCalledTimes(3);
      expect(sentTexts()).toEqual([claimPhotoAddedText(3)]);
      expect(sentTexts()[0]).toContain('Recibí las 3 fotos');
    });

    it('sends only the latest prompt when guided documents arrive together', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
        botPaused: false,
        flowState: JSON.stringify({
          step: 'COT_DOC_DNI_FRENTE',
          data: { leadId: 42 },
        }),
      });
      meta.downloadMedia.mockResolvedValue(image);
      flow.handle
        .mockResolvedValueOnce({
          messages: [{ kind: 'text', body: 'Ahora el dorso del DNI' }],
          state: { step: 'COT_DOC_DNI_DORSO', data: { leadId: 42 } },
        })
        .mockResolvedValueOnce({
          messages: [{ kind: 'text', body: 'Por último, la tarjeta' }],
          state: { step: 'COT_DOC_TARJETA_AZUL', data: { leadId: 42 } },
        })
        .mockResolvedValueOnce({
          messages: [{ kind: 'text', body: 'Ya tenemos todo' }],
          state: { step: 'LEAD_MENU', data: {} },
        });

      for (const n of [1, 2, 3])
        await service.handleMedia('5491155556666', `l${n}`, 'P1', `wl${n}`);
      await settlePhotoReplies();

      expect(api.attachLeadAdjunto).toHaveBeenCalledTimes(3);
      expect(api.saveFlowState).toHaveBeenCalledTimes(3);
      expect(sentTexts()).toEqual(['Ya tenemos todo']);
    });

    it('stays silent if the bot is switched off while photos arrive', async () => {
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ claimId: 9, attached: true });

      await service.handleMedia('5491155556666', 's1', 'P1', 'ws1');
      api.getContext.mockResolvedValue({
        systemPrompt: 'x',
        botEnabled: false,
      });
      await settlePhotoReplies();

      expect(meta.sendText).not.toHaveBeenCalled();
    });

    it('stores a PDF with its name and talks about a file', async () => {
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('%PDF'),
        mimeType: 'application/pdf',
      });
      api.attachAdjunto.mockResolvedValue({ claimId: null, attached: false });

      await service.handleMedia('5491155556666', 'pdf-1', 'P1', 'wp1', 'Ana', {
        document: { filename: 'poliza-vieja.pdf' },
      });
      await settlePhotoReplies();

      expect(api.attachAdjunto).toHaveBeenCalledWith(
        7,
        expect.objectContaining({
          filename: 'poliza-vieja.pdf',
          mimeType: 'application/pdf',
        }),
        undefined,
        false,
      );
      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        '[El cliente envió un archivo: poliza-vieja.pdf]',
        undefined,
        'Ana',
      );
      expect(sentTexts()).toEqual([
        '📎 ¡Recibí tu archivo! Contame para qué es y te ayudo: por ejemplo *siniestro*, *cotizar* o *asesor*.',
      ]);
    });

    it('passes a receipt file to the office instead of asking what it is for', async () => {
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('%PDF'),
        mimeType: 'application/pdf',
      });
      api.attachAdjunto.mockResolvedValue({ claimId: null, attached: false });

      await service.handleMedia('5491155556666', 'pdf-2', 'P1', 'wp2', 'Ana', {
        document: { filename: 'comprobante.pdf' },
      });
      await settlePhotoReplies();

      expect(api.requestHandoff).toHaveBeenCalledWith(
        7,
        'Envió un comprobante de pago para registrar (archivo comprobante.pdf).',
      );
      expect(sentTexts()[0]).toContain('se lo pasé a la oficina');
    });

    it('does not take the coupon book a client forwards for a receipt', async () => {
      meta.downloadMedia.mockResolvedValue({
        buffer: Buffer.from('%PDF'),
        mimeType: 'application/pdf',
      });
      api.attachAdjunto.mockResolvedValue({ claimId: null, attached: false });

      await service.handleMedia('5491155556666', 'pdf-3', 'P1', 'wp3', 'Ana', {
        document: { filename: 'ocuponerarecibo_.pdf' },
      });
      await settlePhotoReplies();

      expect(api.requestHandoff).not.toHaveBeenCalled();
      expect(sentTexts()[0]).toContain('Contame para qué es');
    });

    it('looks at a loose photo and passes a payment receipt to the office', async () => {
      api.getContext.mockResolvedValue({ systemPrompt: 'x', llmEnabled: true });
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ claimId: null, attached: false });
      const create = jest.fn().mockResolvedValue({
        choices: [{ message: { content: '{"tipo":"comprobante_de_pago"}' } }],
      });
      (
        service as unknown as {
          openai: { chat: { completions: { create: jest.Mock } } };
        }
      ).openai = { chat: { completions: { create } } };

      await service.handleMedia('5491155556666', 'r1', 'P1', 'wr1', 'Ana');
      await settlePhotoReplies();

      const [request] = create.mock.calls[0] as [
        { messages: { content: unknown }[] },
      ];
      expect(JSON.stringify(request.messages[1].content)).toContain(
        'data:image/jpeg;base64,',
      );
      expect(api.requestHandoff).toHaveBeenCalledWith(
        7,
        'Envió un comprobante de pago para registrar (foto).',
      );
      expect(sentTexts()[0]).toContain('Recibí tu foto del pago');
    });

    it('asks what a loose photo is for when it is not a receipt', async () => {
      api.getContext.mockResolvedValue({ systemPrompt: 'x', llmEnabled: true });
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ claimId: null, attached: false });
      const create = jest.fn().mockResolvedValue({
        choices: [{ message: { content: '{"tipo":"otra"}' } }],
      });
      (
        service as unknown as {
          openai: { chat: { completions: { create: jest.Mock } } };
        }
      ).openai = { chat: { completions: { create } } };

      await service.handleMedia('5491155556666', 'r2', 'P1', 'wr2', 'Ana');
      await settlePhotoReplies();

      expect(api.requestHandoff).not.toHaveBeenCalled();
      expect(sentTexts()[0]).toContain('Contame para qué es');
    });

    it('answers a photo sent mid-quote with what it needs to quote, once (#232)', async () => {
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ claimId: null, attached: false });
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [
          {
            role: 'assistant',
            content:
              'Mandame la foto y, para cotizarla, también necesito *marca, modelo, año*…',
            source: 'live',
          },
        ],
        flowState: JSON.stringify({ step: 'LLM_COTIZACION', data: {} }),
      });

      await service.handleMedia('5491155666777', 'q1', 'P1', 'wq1', 'Dani');
      await settlePhotoReplies();

      expect(sentTexts()).toHaveLength(1);
      expect(sentTexts()[0]).toContain('Para cotizar necesito');
      expect(sentTexts()[0]).not.toContain('Contame para qué');
      expect(api.requestHandoff).not.toHaveBeenCalled();

      // A minute later, another photo: the reminder was already given.
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [
          { role: 'assistant', content: sentTexts()[0], source: 'live' },
        ],
        flowState: JSON.stringify({ step: 'LLM_COTIZACION', data: {} }),
      });
      await service.handleMedia('5491155666777', 'q2', 'P1', 'wq2', 'Dani');
      await settlePhotoReplies();

      expect(sentTexts()).toHaveLength(1);
    });

    it('reads the text sent with a photo instead of asking what it is for', async () => {
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ claimId: null, attached: false });

      await service.handleMedia('5491155556666', 'c1', 'P1', 'wc1', 'Ana', {
        caption: 'este es el comprobante',
      });
      await settlePhotoReplies();

      expect(flow.handle).toHaveBeenCalledWith(
        'P1:5491155556666',
        { text: 'este es el comprobante', selectionId: undefined },
        expect.anything(),
      );
      expect(sentTexts().join(' ')).not.toContain('Contame para qué');
    });

    it('does not read the text of a photo that answered a guided step', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
        flowState: JSON.stringify({
          step: 'SINIESTRO_FOTO_TARJETA',
          data: { siniestroId: 9 },
        }),
      });
      meta.downloadMedia.mockResolvedValue(image);
      api.attachAdjunto.mockResolvedValue({ claimId: 9, attached: true });
      flow.handle.mockResolvedValue({
        messages: [{ kind: 'text', body: 'Ahora el carnet' }],
        state: { step: 'SINIESTRO_FOTO_CARNET', data: {} },
      });

      await service.handleMedia('5491155556666', 'g1', 'P1', 'wg1', 'Ana', {
        caption: 'acá está la tarjeta',
      });
      await settlePhotoReplies();

      expect(flow.handle).toHaveBeenCalledTimes(1);
      expect(sentTexts()).toEqual(['Ahora el carnet']);
    });
  });

  describe('locations, contacts, videos and other files', () => {
    beforeEach(() => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
      });
      api.saveMessage.mockResolvedValue({});
    });

    it('keeps a video in the inbox and says it arrived', async () => {
      await service.handleSharedItem(
        '5491155556666',
        'P1',
        'wv1',
        { kind: 'video', content: '[El cliente envió un video]' },
        'Ana',
      );

      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        '[El cliente envió un video]',
        undefined,
        'Ana',
      );
      expect(meta.sendText.mock.calls[0][1]).toContain('Recibí tu video');
      expect(flow.handle).not.toHaveBeenCalled();
    });

    it('stays silent while a person from the office has the chat', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
        botPaused: true,
      });

      await service.handleSharedItem('5491155556666', 'P1', 'wl1', {
        kind: 'location',
        content: '📍 Ubicación: (https://maps.google.com/?q=1,2)',
        flowText: 'Lugar: ubicación compartida',
      });

      expect(api.saveMessage).toHaveBeenCalled();
      expect(meta.sendText).not.toHaveBeenCalled();
    });

    it('takes a location as the place while a claim is being filled in', async () => {
      api.getConversation.mockResolvedValue({
        conversationId: 7,
        client: null,
        newSession: false,
        messages: [],
        flowState: JSON.stringify({ step: 'SINIESTRO_DATOS', data: {} }),
      });

      await service.handleSharedItem('5491155556666', 'P1', 'wl2', {
        kind: 'location',
        content:
          '📍 Ubicación: Av. Pellegrini 1500, Rosario (https://maps.google.com/?q=1,2)',
        flowText: 'Lugar: Av. Pellegrini 1500, Rosario',
      });

      expect(flow.handle).toHaveBeenCalledWith(
        'P1:5491155556666',
        { text: 'Lugar: Av. Pellegrini 1500, Rosario', selectionId: undefined },
        expect.anything(),
      );
      expect(api.saveMessage).toHaveBeenCalledWith(
        7,
        'user',
        '📍 Ubicación: Av. Pellegrini 1500, Rosario (https://maps.google.com/?q=1,2)',
        undefined,
        undefined,
      );
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

    /** The quote the coverage is chosen from, as the flow state keeps it. */
    const navi = { codia: 140123, description: 'NAVI 110' };
    const quotedNavi = {
      vehicleType: 'moto',
      candidates: [navi],
      selected: navi,
      quoted: {
        manufactureYear: 2025,
        postalCode: 2000,
        outcome: 'cotizada',
        coverages: ['A', 'B4', 'B1'],
      },
    };

    it('records the chosen coverage, flags the chat and asks for the DNI', async () => {
      flow.handle.mockResolvedValue({
        messages: [],
        state: {
          step: 'LLM_COTIZACION',
          data: { vehiculo: 'moto', quoteVehicle: quotedNavi },
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
          ceroKm: 'No',
          codigoPostal: 2000,
          precio: '$ 62.614',
        },
      });
      expect(api.requestHandoff).toHaveBeenCalledWith(
        3,
        'Quiere contratar B1 — Todo Total 1 para su HONDA NAVI 110 2025. Solicitud de cotización #42: el bot le pide las fotos.',
      );
      expect(api.saveFlowState).toHaveBeenCalledWith(
        3,
        JSON.stringify({
          step: 'COT_DOC_DNI_FRENTE',
          data: { leadId: 42, zeroKm: false },
          audience: 'lead',
        }),
      );
      // Confirmation and the first document request go out as one message.
      expect(meta.sendText).toHaveBeenCalledTimes(1);
      const body = (meta.sendText.mock.calls as string[][])[0][1];
      expect(body).toContain('Anotamos la B1');
      expect(body).toContain('frente de tu DNI');
    });

    it('does not record a coverage before there is a quote', async () => {
      flow.handle.mockResolvedValue({
        messages: [],
        state: { step: 'LLM_COTIZACION', data: { vehiculo: 'auto' } },
        handoff: 'cotizacion',
      });
      const create = jest
        .fn()
        .mockResolvedValueOnce({
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
                        vehicleType: 'auto',
                        coverageCode: 'A',
                        coverageName: 'Responsabilidad Civil',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [{ message: { content: '¿Cuál es la versión?' } }],
        });
      (
        service as unknown as {
          openai: { chat: { completions: { create: jest.Mock } } };
        }
      ).openai = { chat: { completions: { create } } };

      await service.handleMessage(
        '5493416956364',
        'Me interesa la A',
        'P1',
        'cov-0',
      );

      expect(api.createLead).not.toHaveBeenCalled();
      const [request] = create.mock.calls[1] as [
        { messages: { role: string; content: string }[] },
      ];
      expect(request.messages[request.messages.length - 1].content).toContain(
        'todavía no hay una cotización',
      );
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
