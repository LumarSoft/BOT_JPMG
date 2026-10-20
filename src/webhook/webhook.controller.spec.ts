import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { ApiService } from '../api/api.service';
import { SentMessageRegistry } from './sent-message-registry.service';

describe('WebhookController', () => {
  let controller: WebhookController;
  let webhookService: {
    handleMessage: jest.Mock;
    handleAudio: jest.Mock;
    handleMedia: jest.Mock;
    handleSharedItem: jest.Mock;
  };
  let api: {
    recordAgentEcho: jest.Mock;
    persistCoexistenceHistory: jest.Mock;
    persistCoexistenceContacts: jest.Mock;
    reportMetaUsage: jest.Mock;
    reportWabaAccountUpdate: jest.Mock;
  };

  beforeEach(async () => {
    webhookService = {
      handleMessage: jest.fn().mockResolvedValue(undefined),
      handleAudio: jest.fn().mockResolvedValue(undefined),
      handleMedia: jest.fn().mockResolvedValue(undefined),
      handleSharedItem: jest.fn().mockResolvedValue(undefined),
    };
    api = {
      recordAgentEcho: jest.fn().mockResolvedValue(undefined),
      persistCoexistenceHistory: jest.fn().mockResolvedValue(undefined),
      persistCoexistenceContacts: jest.fn().mockResolvedValue(undefined),
      reportMetaUsage: jest.fn().mockResolvedValue(undefined),
      reportWabaAccountUpdate: jest
        .fn()
        .mockResolvedValue({ known: true, checked: 1, disconnected: 1 }),
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

  it('passes the sender’s WhatsApp profile name along with the message', () => {
    controller.receiveMessage({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+54',
                  phone_number_id: 'P1',
                },
                contacts: [{ wa_id: 'wa1', profile: { name: 'John' } }],
                messages: [
                  {
                    from: 'wa1',
                    id: 'm1',
                    timestamp: '1',
                    type: 'text',
                    text: { body: 'hola' },
                  },
                ],
              },
            },
          ],
        },
      ],
    } as any);

    expect(webhookService.handleMessage).toHaveBeenCalledWith(
      'wa1',
      'hola',
      'P1',
      'm1',
      undefined,
      'John',
    );
  });

  it('routes a voice note to the audio handler with the sender name', () => {
    controller.receiveMessage({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+54',
                  phone_number_id: 'P1',
                },
                contacts: [{ wa_id: 'wa1', profile: { name: 'John' } }],
                messages: [
                  {
                    from: 'wa1',
                    id: 'm1',
                    timestamp: '1',
                    type: 'audio',
                    audio: {
                      id: 'aud-1',
                      mime_type: 'audio/ogg; codecs=opus',
                      voice: true,
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    } as any);

    expect(webhookService.handleAudio).toHaveBeenCalledWith(
      'wa1',
      'aud-1',
      'P1',
      'm1',
      'John',
    );
    expect(webhookService.handleMessage).not.toHaveBeenCalled();
  });

  /** Delivers one inbound message from wa1 (profile "John") to number P1. */
  function receive(message: Record<string, unknown>) {
    controller.receiveMessage({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '+54',
                  phone_number_id: 'P1',
                },
                contacts: [{ wa_id: 'wa1', profile: { name: 'John' } }],
                messages: [
                  { from: 'wa1', id: 'm1', timestamp: '1', ...message },
                ],
              },
            },
          ],
        },
      ],
    } as any);
  }

  it('passes the text written with a photo', () => {
    receive({
      type: 'image',
      image: {
        id: 'img-1',
        mime_type: 'image/jpeg',
        caption: 'el comprobante',
      },
    });
    expect(webhookService.handleMedia).toHaveBeenCalledWith(
      'wa1',
      'img-1',
      'P1',
      'm1',
      'John',
      { caption: 'el comprobante' },
    );
  });

  it('stores a PDF like a photo, with its name and text', () => {
    receive({
      type: 'document',
      document: {
        id: 'doc-1',
        mime_type: 'application/pdf',
        filename: 'comprobante.pdf',
        caption: 'ya pagué',
      },
    });
    expect(webhookService.handleMedia).toHaveBeenCalledWith(
      'wa1',
      'doc-1',
      'P1',
      'm1',
      'John',
      { document: { filename: 'comprobante.pdf' }, caption: 'ya pagué' },
    );
  });

  it('notes a file the API cannot store instead of dropping it', () => {
    receive({
      type: 'document',
      document: {
        id: 'doc-2',
        mime_type: 'application/msword',
        filename: 'nota.doc',
      },
    });
    expect(webhookService.handleMedia).not.toHaveBeenCalled();
    expect(webhookService.handleSharedItem).toHaveBeenCalledWith(
      'wa1',
      'P1',
      'm1',
      {
        kind: 'file',
        content:
          '[El cliente envió un archivo que el bot no puede abrir: nota.doc]',
      },
      'John',
    );
  });

  it('turns a shared location into the place of a claim', () => {
    receive({
      type: 'location',
      location: {
        latitude: -32.95,
        longitude: -60.66,
        name: 'Shopping',
        address: 'Av. Circunvalación 5400, Rosario',
      },
    });
    expect(webhookService.handleSharedItem).toHaveBeenCalledWith(
      'wa1',
      'P1',
      'm1',
      {
        kind: 'location',
        content:
          '📍 Ubicación: Shopping, Av. Circunvalación 5400, Rosario (https://maps.google.com/?q=-32.95,-60.66)',
        flowText: 'Lugar: Shopping, Av. Circunvalación 5400, Rosario',
      },
      'John',
    );
  });

  it('keeps a video and a contact card for the inbox', () => {
    receive({ type: 'video', video: { id: 'v1', mime_type: 'video/mp4' } });
    receive({
      type: 'contacts',
      contacts: [
        {
          name: { formatted_name: 'Taller Pérez' },
          phones: [{ phone: '+54 341 555-0000' }],
        },
      ],
    });
    expect(webhookService.handleSharedItem).toHaveBeenNthCalledWith(
      1,
      'wa1',
      'P1',
      'm1',
      { kind: 'video', content: '[El cliente envió un video]' },
      'John',
    );
    expect(webhookService.handleSharedItem).toHaveBeenNthCalledWith(
      2,
      'wa1',
      'P1',
      'm1',
      {
        kind: 'contacts',
        content:
          '[El cliente compartió un contacto: Taller Pérez +54 341 555-0000]',
      },
      'John',
    );
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

    expect(api.reportWabaAccountUpdate).toHaveBeenCalledWith('W1', {
      event: 'PARTNER_REMOVED',
      reason: 'INACTIVE',
      initiatedBy: 'META',
    });
  });

  function accountUpdate(
    event: string,
    info?: Record<string, string>,
  ): Parameters<WebhookController['receiveMessage']>[0] {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '101875549673776',
          changes: [
            {
              field: 'account_update',
              value: { event, disconnection_info: info },
            },
          ],
        },
      ],
    } as unknown as Parameters<WebhookController['receiveMessage']>[0];
  }

  it('forwards an offboarding or an uninstalled app so the API can check the number', () => {
    controller.receiveMessage(accountUpdate('ACCOUNT_OFFBOARDED'));
    controller.receiveMessage(accountUpdate('PARTNER_APP_UNINSTALLED'));

    expect(api.reportWabaAccountUpdate).toHaveBeenCalledWith(
      '101875549673776',
      expect.objectContaining({ event: 'ACCOUNT_OFFBOARDED' }),
    );
    expect(api.reportWabaAccountUpdate).toHaveBeenCalledWith(
      '101875549673776',
      expect.objectContaining({ event: 'PARTNER_APP_UNINSTALLED' }),
    );
  });

  it('only logs, with the WABA id, the notices that do not affect the connection', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    controller.receiveMessage(accountUpdate('MM_LITE_TERMS_SIGNED'));

    expect(api.reportWabaAccountUpdate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('WABA 101875549673776'),
    );
    log.mockRestore();
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

describe('Meta delivered-message accounting', () => {
  function setup() {
    const api = { reportMetaUsage: jest.fn().mockResolvedValue(undefined) };
    const controller = new WebhookController(
      {} as any,
      {} as any,
      api as any,
      {} as any,
    );
    return { controller, api };
  }

  function payload(statuses: any[]) {
    return {
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: { metadata: { phone_number_id: 'PN' }, statuses },
            },
          ],
        },
      ],
    } as any;
  }

  it('reports each delivered message even when they share a conversation and includes free messages', async () => {
    const { controller, api } = setup();
    const base = {
      timestamp: '1791000000',
      recipient_id: '5493416000000',
      conversation: { id: 'same-conversation' },
      pricing: { billable: true, category: 'service' },
    };
    await controller.receiveMessage(
      payload([
        { ...base, id: 'one', status: 'sent' },
        { ...base, id: 'one', status: 'delivered' },
        { ...base, id: 'one', status: 'read' },
        {
          ...base,
          id: 'two',
          status: 'delivered',
          pricing: { billable: false, category: 'service' },
        },
        { ...base, id: 'three', status: 'failed' },
      ]),
    );
    expect(api.reportMetaUsage).toHaveBeenCalledTimes(2);
    expect(api.reportMetaUsage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'one', billable: true }),
    );
    expect(api.reportMetaUsage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'two', billable: false }),
    );
  });

  it('fails delivery when usage persistence fails so Meta retries', async () => {
    const { controller, api } = setup();
    api.reportMetaUsage.mockRejectedValue(new Error('API down'));
    await expect(
      controller.receiveMessage(
        payload([
          {
            id: 'one',
            status: 'delivered',
            timestamp: '1791000000',
            recipient_id: '5493416000000',
            pricing: { billable: true, category: 'service' },
          },
        ]),
      ),
    ).rejects.toThrow('API down');
  });
});
