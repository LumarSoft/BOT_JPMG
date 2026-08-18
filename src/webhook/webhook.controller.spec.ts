import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { ApiService } from '../api/api.service';
import { SentMessageRegistry } from './sent-message-registry.service';

describe('WebhookController', () => {
  let controller: WebhookController;
  let webhookService: { handleMessage: jest.Mock };
  let api: {
    recordAgentEcho: jest.Mock;
    reportMetaUsage: jest.Mock;
    markWabaDisconnected: jest.Mock;
  };

  beforeEach(async () => {
    webhookService = { handleMessage: jest.fn().mockResolvedValue(undefined) };
    api = {
      recordAgentEcho: jest.fn().mockResolvedValue(undefined),
      reportMetaUsage: jest.fn().mockResolvedValue(undefined),
      markWabaDisconnected: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        {
          provide: WebhookService,
          useValue: webhookService,
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-value') },
        },
        {
          provide: ApiService,
          useValue: api,
        },
        {
          provide: SentMessageRegistry,
          useValue: { isOurs: jest.fn().mockReturnValue(false) },
        },
      ],
    }).compile();

    controller = module.get<WebhookController>(WebhookController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('processes every entry/change instead of dropping all but the first', () => {
    const textChange = (from: string, id: string) => ({
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '+54', phone_number_id: 'P1' },
        messages: [
          { from, id, timestamp: '1', type: 'text', text: { body: 'hola' } },
        ],
      },
    });

    controller.receiveMessage({
      object: 'whatsapp_business_account',
      entry: [
        { id: 'W1', changes: [textChange('wa1', 'm1')] },
        { id: 'W1', changes: [textChange('wa2', 'm2')] },
      ],
    } as any);

    expect(webhookService.handleMessage).toHaveBeenCalledTimes(2);
  });

  it('records a WhatsApp Business app echo so the API can pause the bot', () => {
    controller.receiveMessage({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W1',
          changes: [
            {
              field: 'smb_message_echoes',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+54',
                  phone_number_id: 'P1',
                },
                message_echoes: [
                  {
                    from: 'business',
                    to: 'wa1',
                    id: 'echo1',
                    timestamp: '1',
                    type: 'text',
                    text: { body: 'yo sigo' },
                  },
                ],
              },
            },
          ],
        },
      ],
    } as any);

    expect(api.recordAgentEcho).toHaveBeenCalledWith({
      phoneNumberId: 'P1',
      waId: 'wa1',
      content: 'yo sigo',
      waMessageId: 'echo1',
    });
  });
});
