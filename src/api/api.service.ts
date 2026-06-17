import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import type {
  AttachAdjuntosResult,
  BotContext,
  BotConversation,
  ConversationMessage,
  EstadoCuentaPoliza,
  IdentifyResult,
  InfoAutoBrand,
  InfoAutoGroup,
  InfoAutoModel,
  PendingWarning,
  PolizaDocumento,
  PolizaSummary,
  QuoteResult,
  SiniestroSummary,
  VehicleTypeParam,
} from './api.types';

/**
 * Single point of access to john-api. The bot never touches the database:
 * /bot/* endpoints are authenticated with the shared BOT_SECRET header, and
 * the infoauto/cotizador endpoints are the same public ones the web uses.
 */
@Injectable()
export class ApiService {
  private readonly http: AxiosInstance;

  constructor(config: ConfigService) {
    this.http = axios.create({
      baseURL: config.get<string>('API_URL') ?? 'http://localhost:3001',
      timeout: 20000,
      headers: { 'x-bot-secret': config.get<string>('BOT_SECRET') ?? '' },
    });
  }

  // ─── Bot endpoints (x-bot-secret) ──────────────────────

  async getContext(phoneNumberId: string): Promise<BotContext> {
    const { data } = await this.http.get<BotContext>(
      `/bot/context/${phoneNumberId}`,
    );
    return data;
  }

  async getConversation(
    phoneNumberId: string,
    waId: string,
  ): Promise<BotConversation> {
    const { data } = await this.http.get<BotConversation>(
      `/bot/conversation/${phoneNumberId}/${waId}`,
    );
    return data;
  }

  async saveMessage(
    conversationId: number,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<ConversationMessage> {
    const { data } = await this.http.post<ConversationMessage>(
      `/bot/conversation/${conversationId}/message`,
      { role, content },
    );
    return data;
  }

  /** Resets the conversation session (secret /reset dev command): drops history, keeps the client. */
  async resetSession(conversationId: number): Promise<void> {
    await this.http.post(`/bot/conversation/${conversationId}/reset`);
  }

  /** Claims (and marks warned) the conversations idle past the inactivity window. */
  async claimPendingWarnings(): Promise<PendingWarning[]> {
    const { data } = await this.http.post<PendingWarning[]>(
      '/bot/conversations/pending-warnings',
    );
    return data;
  }

  async identifyClient(
    conversationId: number,
    params: { dni?: string; plate?: string },
  ): Promise<IdentifyResult> {
    const { data } = await this.http.post<IdentifyResult>(
      `/bot/conversation/${conversationId}/identify`,
      params,
    );
    return data;
  }

  async getPolizas(conversationId: number): Promise<PolizaSummary[]> {
    const { data } = await this.http.get<PolizaSummary[]>(
      `/bot/conversation/${conversationId}/polizas`,
    );
    return data;
  }

  async getEstadoCuenta(conversationId: number): Promise<EstadoCuentaPoliza[]> {
    const { data } = await this.http.get<EstadoCuentaPoliza[]>(
      `/bot/conversation/${conversationId}/estado-cuenta`,
    );
    return data;
  }

  async getDocumentos(
    conversationId: number,
    polizaId: number,
  ): Promise<PolizaDocumento[]> {
    const { data } = await this.http.get<PolizaDocumento[]>(
      `/bot/conversation/${conversationId}/polizas/${polizaId}/documentos`,
    );
    return data;
  }

  async getSiniestros(conversationId: number): Promise<SiniestroSummary[]> {
    const { data } = await this.http.get<SiniestroSummary[]>(
      `/bot/conversation/${conversationId}/siniestros`,
    );
    return data;
  }

  async createSiniestro(
    conversationId: number,
    payload: {
      polizaId: number;
      tipo: string;
      fecha: string;
      descripcion: string;
    },
  ): Promise<SiniestroSummary> {
    const { data } = await this.http.post<SiniestroSummary>(
      `/bot/conversation/${conversationId}/siniestros`,
      payload,
    );
    return data;
  }

  /** Uploads a WhatsApp photo, attaching it to the conversation's latest open claim. */
  async attachAdjunto(
    conversationId: number,
    file: { buffer: Buffer; filename: string; mimeType: string },
  ): Promise<AttachAdjuntosResult> {
    const form = new FormData();
    form.append(
      'adjuntos',
      // Uint8Array.from yields a standard ArrayBuffer-backed view (Buffer's
      // ArrayBufferLike type is not assignable to BlobPart directly).
      new Blob([Uint8Array.from(file.buffer)], { type: file.mimeType }),
      file.filename,
    );

    const { data } = await this.http.post<AttachAdjuntosResult>(
      `/bot/conversation/${conversationId}/adjuntos`,
      form,
    );
    return data;
  }

  // ─── Public endpoints (infoauto + cotizador) ───────────

  async searchBrands(
    vehicleType: VehicleTypeParam,
    query?: string,
  ): Promise<InfoAutoBrand[]> {
    const { data } = await this.http.get<InfoAutoBrand[]>(
      `/infoauto/${vehicleType}/brands`,
      {
        params: { query_string: query || undefined, page_size: 20 },
      },
    );
    return data;
  }

  async getGroups(
    vehicleType: VehicleTypeParam,
    brandId: number,
  ): Promise<InfoAutoGroup[]> {
    const { data } = await this.http.get<InfoAutoGroup[]>(
      `/infoauto/${vehicleType}/brands/${brandId}/groups`,
      { params: { page_size: 50 } },
    );
    return data;
  }

  async getModels(
    vehicleType: VehicleTypeParam,
    brandId: number,
    groupId: number,
    query?: string,
  ): Promise<InfoAutoModel[]> {
    const { data } = await this.http.get<InfoAutoModel[]>(
      `/infoauto/${vehicleType}/brands/${brandId}/groups/${groupId}/models`,
      { params: { query_string: query || undefined, page_size: 30 } },
    );
    return data;
  }

  async quoteVehicle(
    vehicleType: VehicleTypeParam,
    payload: {
      brand: string;
      model: string;
      manufactureYear: number;
      postalCode: number;
    },
  ): Promise<QuoteResult> {
    const { data } = await this.http.post<QuoteResult>(
      `/cotizador/${vehicleType}`,
      payload,
    );
    return data;
  }
}
