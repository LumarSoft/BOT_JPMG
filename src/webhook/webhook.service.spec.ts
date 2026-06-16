import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import { ApiService } from '../api/api.service';
import { MetaService } from './meta.service';

describe('WebhookService', () => {
  let service: WebhookService;
  let api: {
    getContext: jest.Mock;
    getConversation: jest.Mock;
    saveMessage: jest.Mock;
    resetSession: jest.Mock;
  };
  let meta: { sendText: jest.Mock; normalizePhone: jest.Mock };

  beforeEach(async () => {
    api = {
      getContext: jest.fn().mockResolvedValue({ systemPrompt: 'x' }),
      getConversation: jest.fn(),
      saveMessage: jest.fn(),
      resetSession: jest.fn().mockResolvedValue(undefined),
    };
    meta = {
      sendText: jest.fn().mockResolvedValue(undefined),
      normalizePhone: jest.fn((p: string) => p),
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
      ],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
  });

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

      await service.handleMessage('5491155556666', '/reset', 'P1');

      expect(api.resetSession).toHaveBeenCalledWith(5);
      expect(api.saveMessage).not.toHaveBeenCalled();
      expect(meta.sendText).toHaveBeenCalledTimes(1);
    });
  });
});
