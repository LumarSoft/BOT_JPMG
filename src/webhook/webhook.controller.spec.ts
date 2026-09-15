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
    persistCoexistenceHistory: jest.Mock;
    persistCoexistenceContacts: jest.Mock;
    reportMetaUsage: jest.Mock;
    markWabaDisconnected: jest.Mock;
  };

  beforeEach(async () => {
    webhookService = { handleMessage: jest.fn().mockResolvedValue(undefined) };
    api = {
      recordAgentEcho: jest.fn().mockResolvedValue(undefined),
      persistCoexistenceHistory: jest.fn().mockResolvedValue(undefined),
      persistCoexistenceContacts: jest.fn().mockResolvedValue(undefined),
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

  it('records Meta disconnection_info.reason from an account update', () => {
    controller.receiveMessage({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W1',
          changes: [
            {
              field: 'account_update',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+54',
                  phone_number_id: 'P1',
                },
                event: 'PARTNER_REMOVED',
                disconnection_info: {
                  reason: 'INACTIVE',
                  initiated_by: 'META',
                },
              },
            },
          ],
        },
      ],
    } as any);

    expect(api.markWabaDisconnected).toHaveBeenCalledWith('W1', 'INACTIVE');
  });

  it('forwards historical chunks to the API for durable persistence', async () => {
    const chunks = [
      {
        metadata: { phase: '0', chunk_order: 1, progress: 100 },
        threads: [{ id: '5493412345678', messages: [] }],
      },
    ];

    await controller.receiveMessage({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W1',
          changes: [
            {
              field: 'history',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+54',
                  phone_number_id: 'P1',
                },
                history: chunks,
              },
            },
          ],
        },
      ],
    } as any);

    expect(api.persistCoexistenceHistory).toHaveBeenCalledWith({
      phoneNumberId: 'P1',
      chunks,
    });
  });

  it('forwards contact changes to the API for durable persistence', async () => {
    const contacts = [
      {
        type: 'contact',
        action: 'add',
        contact: { phone_number: '5493412345678', full_name: 'Ana Pérez' },
      },
    ];

    await controller.receiveMessage({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W1',
          changes: [
            {
              field: 'smb_app_state_sync',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+54',
                  phone_number_id: 'P1',
                },
                state_sync: contacts,
              },
            },
          ],
        },
      ],
    } as any);

    expect(api.persistCoexistenceContacts).toHaveBeenCalledWith({
      phoneNumberId: 'P1',
      contacts,
    });
  });
});
