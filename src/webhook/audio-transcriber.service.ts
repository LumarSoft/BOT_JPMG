import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';
import { ApiService } from '../api/api.service';

const DEFAULT_TRANSCRIBE_MODEL = 'gpt-transcribe';

/** Extension OpenAI uses to recognize the container; WhatsApp voice notes are OGG/Opus. */
const AUDIO_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/webm': 'webm',
};

/** "audio/ogg; codecs=opus" → "audio/ogg". */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

export function audioFilename(mimeType: string): string {
  return `whatsapp-${Date.now()}.${AUDIO_EXT[baseMimeType(mimeType)] ?? 'ogg'}`;
}

/**
 * Turns a WhatsApp voice note into text with OpenAI, so the bot can answer it
 * like a typed message. Billed per minute of audio; the duration is reported
 * to the API's usage tracking like every other OpenAI call.
 */
@Injectable()
export class AudioTranscriber {
  private readonly logger = new Logger(AudioTranscriber.name);
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(
    config: ConfigService,
    private readonly api: ApiService,
  ) {
    this.openai = new OpenAI({ apiKey: config.get('OPENAI_API_KEY') });
    this.model =
      config.get<string>('OPENAI_TRANSCRIBE_MODEL') || DEFAULT_TRANSCRIBE_MODEL;
  }

  /** The transcription, or null when the audio has no intelligible speech. Throws on API errors. */
  async transcribe(
    audio: { buffer: Buffer; mimeType: string },
    phoneNumberId: string,
  ): Promise<string | null> {
    const mimeType = baseMimeType(audio.mimeType);
    const result = await this.openai.audio.transcriptions.create({
      model: this.model,
      file: await toFile(audio.buffer, audioFilename(mimeType), {
        type: mimeType,
      }),
      language: 'es',
    });

    const seconds =
      result.usage?.type === 'duration' ? Math.ceil(result.usage.seconds) : 0;
    void this.reportUsage(phoneNumberId, seconds);

    const text = result.text?.trim();
    return text ? text : null;
  }

  private async reportUsage(
    phoneNumberId: string,
    audioSeconds: number,
  ): Promise<void> {
    try {
      await this.api.reportOpenAiUsage({
        phoneNumberId,
        model: this.model,
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds,
        timestamp: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      this.logger.error(
        `No se pudo registrar consumo de transcripción: ${(error as Error).message}`,
      );
    }
  }
}
