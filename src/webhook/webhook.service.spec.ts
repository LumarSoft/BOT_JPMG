import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import { ApiService } from '../api/api.service';
import { MetaService } from './meta.service';
import { FlowService } from './flow/flow.service';

describe('WebhookService', () => {
  let service: WebhookService;
  let api: {
    getContext: jest.Mock;
    getConversation: jest.Mock;
    saveMessage: jest.Mock;
    resetSession: jest.Mock;
    attachAdjunto: jest.Mock;
  };
  let meta: {
    sendText: jest.Mock;
    sendButtons: jest.Mock;
    sendList: jest.Mock;
    normalizePhone: jest.Mock;
    downloadMedia: jest.Mock;
  };
  let flow: { handle: jest.Mock; reset: jest.Mock };

  beforeEach(async () => {
    api = {
      getContext: jest.fn().mockResolvedValue({ systemPrompt: 'x' }),
      getConversation: jest.fn(),
      saveMessage: jest.fn(),
      resetSession: jest.fn().mockResolvedValue(undefined),
      attachAdjunto: jest.fn(),
    };
    meta = {
      sendText: jest.fn().mockResolvedValue(undefined),
      sendButtons: jest.fn().mockResolvedValue(undefined),
      sendList: jest.fn().mockResolvedValue(undefined),
      normalizePhone: jest.fn((p: string) => p),
      downloadMedia: jest.fn(),
    };
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
          useValue: { get: jest.fn().mockReturnValue('test-value') },
        },
        { provide: ApiService, useValue: api },
        { provide: MetaService, useValue: meta },
        { provide: FlowService, useValue: flow },
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

      expect(api.resetSession).toHaveBeenCalledWith(5);
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

      expect(meta.downloadMedia).toHaveBeenCalledWith('media-1');
      expect(api.attachAdjunto).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ mimeType: 'image/jpeg' }),
      );
      const reply = (meta.sendText.mock.calls as string[][])[0][1];
      expect(reply).toContain('adjunté');
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
  });
});
