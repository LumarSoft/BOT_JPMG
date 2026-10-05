import type { ConfigService } from '@nestjs/config';
import type { ApiService } from '../api/api.service';
import {
  AudioTranscriber,
  audioFilename,
  baseMimeType,
} from './audio-transcriber.service';

describe('AudioTranscriber', () => {
  function setup(response: unknown) {
    const api = { reportOpenAiUsage: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: jest.fn((key: string) =>
        key === 'OPENAI_API_KEY' ? 'k' : undefined,
      ),
    } as unknown as ConfigService;
    const transcriber = new AudioTranscriber(
      config,
      api as unknown as ApiService,
    );
    const create = jest.fn().mockResolvedValue(response);
    (
      transcriber as unknown as {
        openai: { audio: { transcriptions: { create: jest.Mock } } };
      }
    ).openai = { audio: { transcriptions: { create } } };
    return { transcriber, api, create };
  }

  it('strips codec parameters and names the file by container', () => {
    expect(baseMimeType('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(audioFilename('audio/ogg; codecs=opus')).toMatch(/\.ogg$/);
    expect(audioFilename('audio/mp4')).toMatch(/\.m4a$/);
  });

  it('transcribes in Spanish with gpt-transcribe and reports the audio seconds', async () => {
    const { transcriber, api, create } = setup({
      text: ' Me chocaron ayer. ',
      usage: { type: 'duration', seconds: 8.4 },
    });

    await expect(
      transcriber.transcribe(
        { buffer: Buffer.from('ogg'), mimeType: 'audio/ogg; codecs=opus' },
        'P1',
      ),
    ).resolves.toBe('Me chocaron ayer.');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-transcribe', language: 'es' }),
    );
    expect(api.reportOpenAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'P1',
        model: 'gpt-transcribe',
        audioSeconds: 9,
      }),
    );
  });

  it('returns null for an audio without speech', async () => {
    const { transcriber } = setup({
      text: '',
      usage: { type: 'duration', seconds: 3 },
    });

    await expect(
      transcriber.transcribe(
        { buffer: Buffer.from('ogg'), mimeType: 'audio/ogg' },
        'P1',
      ),
    ).resolves.toBeNull();
  });
});
