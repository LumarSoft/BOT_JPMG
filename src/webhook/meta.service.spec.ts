import axios from 'axios';
import type { ConfigService } from '@nestjs/config';
import type { ApiService } from '../api/api.service';
import { MetaService, outboundContentForLog } from './meta.service';
import type { SentMessageRegistry } from './sent-message-registry.service';

describe('outboundContentForLog', () => {
  it('logs the complete text without duplicating the recipient', () => {
    const content = outboundContentForLog({
      to: '543411111111',
      type: 'text',
      text: { body: 'Primera línea\nSegunda línea' },
    });

    expect(JSON.parse(content)).toEqual({
      type: 'text',
      text: { body: 'Primera línea\nSegunda línea' },
    });
    expect(content).not.toContain('543411111111');
  });

  it('keeps interactive bodies, ids and visible option titles', () => {
    const content = outboundContentForLog({
      to: '543411111111',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: '¿Tu auto tiene GNC?' },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: { id: 'gnc_no', title: 'No tiene GNC' },
            },
          ],
        },
      },
    });

    expect(content).toContain('¿Tu auto tiene GNC?');
    expect(content).toContain('gnc_no');
    expect(content).toContain('No tiene GNC');
  });
});

describe('MetaService.sendMedia', () => {
  function setup() {
    const remember = jest.fn();
    const service = new MetaService(
      { get: () => undefined } as unknown as ConfigService,
      { remember } as unknown as SentMessageRegistry,
      {
        getWhatsappAccessToken: jest.fn().mockResolvedValue('TOKEN'),
      } as unknown as ApiService,
    );
    const post = jest.spyOn(axios, 'post');
    return { service, post, remember };
  }

  afterEach(() => jest.restoreAllMocks());

  it('uploads a PDF to Meta and sends it as a document with its name', async () => {
    const { service, post, remember } = setup();
    post
      .mockResolvedValueOnce({ data: { id: 'MEDIA1' } })
      .mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.1' }] } });

    await service.sendMedia(
      '543415555555',
      'P1',
      {
        buffer: Buffer.from('%PDF'),
        mimeType: 'application/pdf',
        filename: 'Póliza.pdf',
      },
      'Tu póliza',
    );

    expect(post.mock.calls[0][0]).toBe(
      'https://graph.facebook.com/v25.0/P1/media',
    );
    const upload = post.mock.calls[0][1] as FormData;
    expect(upload.get('type')).toBe('application/pdf');
    expect(post.mock.calls[1][1]).toEqual({
      messaging_product: 'whatsapp',
      to: '543415555555',
      type: 'document',
      document: { id: 'MEDIA1', filename: 'Póliza.pdf', caption: 'Tu póliza' },
    });
    expect(remember).toHaveBeenCalledWith('wamid.1');
  });

  it('sends a JPEG as an image without a filename', async () => {
    const { service, post } = setup();
    post
      .mockResolvedValueOnce({ data: { id: 'MEDIA2' } })
      .mockResolvedValueOnce({ data: { messages: [{ id: 'wamid.2' }] } });

    await service.sendMedia('543415555555', 'P1', {
      buffer: Buffer.from('jpg'),
      mimeType: 'image/jpeg',
      filename: 'foto.jpg',
    });

    expect(post.mock.calls[1][1]).toMatchObject({
      type: 'image',
      image: { id: 'MEDIA2' },
    });
  });

  it('throws when Meta rejects the file, unlike the bot replies', async () => {
    const { service, post } = setup();
    post.mockRejectedValueOnce(new Error('Meta rejected the upload'));

    await expect(
      service.sendMedia('543415555555', 'P1', {
        buffer: Buffer.from('jpg'),
        mimeType: 'image/jpeg',
        filename: 'foto.jpg',
      }),
    ).rejects.toThrow('Meta rejected the upload');
  });
});
