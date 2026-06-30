import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import type {
  AttachAdjuntosResult,
  BotContext,
  BotConversation,
  ConversationMessage,
  CreateLeadInput,
  CreateLeadResult,
  EstadoCuentaPoliza,
  HoursStatus,
  IdentifyResult,
  InfoAutoBrand,
  InfoAutoGroup,
  InfoAutoModel,
  PendingWarning,
  PolizaDocumento,
  PolizaSummary,
  ProductCatalogItem,
  ProductPlanSummary,
  QuoteResult,
  SiniestroSummary,
  VehicleTypeParam,
} from './api.types';

/** How long the public product catalog is cached in memory. It is static
 * marketing copy that changes rarely, so one fetch per hour is plenty. */
const CATALOG_TTL_MS = 60 * 60 * 1000;

/** How long the live hours status is cached. Short, because `isOpenNow` changes
 * with the clock — but enough to coalesce a burst of messages. */
const HOURS_TTL_MS = 60 * 1000;

/**
 * Single point of access to john-api. The bot never touches the database:
 * /bot/* endpoints are authenticated with the shared BOT_SECRET header, and
 * the infoauto/cotizador endpoints are the same public ones the web uses.
 */
@Injectable()
export class ApiService {
  private readonly http: AxiosInstance;

  /** In-memory cache of the public product catalog (static marketing copy). */
  private catalogCache?: { items: ProductCatalogItem[]; fetchedAt: number };

  /** In-memory cache of the live hours status (short TTL — see HOURS_TTL_MS). */
  private hoursCache?: { status: HoursStatus; fetchedAt: number };

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

  /**
   * Reports OpenAI token usage for per-number monthly cost tracking + budget
   * enforcement. Fire-and-forget: a failure here must never break the reply.
   */
  async reportOpenAiUsage(input: {
    phoneNumberId: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void> {
    await this.http.post('/bot/usage/openai', input).catch(() => undefined);
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

  /** Persists the bot's serialized flow state (or null to clear it) so it survives a restart. */
  async saveFlowState(
    conversationId: number,
    flowState: string | null,
  ): Promise<void> {
    await this.http.post(`/bot/conversation/${conversationId}/flow-state`, {
      flowState,
    });
  }

  /** Marks the conversation as pending human attention (user requested an advisor). */
  async requestHandoff(conversationId: number): Promise<void> {
    await this.http.post(`/bot/conversation/${conversationId}/request-handoff`);
  }

  /** Creates an advisor-contact / fixed-plan lead, scoped to the conversation's producer. */
  async createLead(
    conversationId: number,
    payload: CreateLeadInput,
  ): Promise<CreateLeadResult> {
    const { data } = await this.http.post<CreateLeadResult>(
      `/bot/conversation/${conversationId}/leads`,
      payload,
    );
    return data;
  }

  /** Lists the active fixed-price plans of a product (bolso, hogar) for the conversation's producer. */
  async getPricing(
    conversationId: number,
    productType: string,
  ): Promise<ProductPlanSummary[]> {
    const { data } = await this.http.get<ProductPlanSummary[]>(
      `/bot/conversation/${conversationId}/pricing/${productType}`,
    );
    return data;
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

  /**
   * Uploads a WhatsApp photo, attaching it to the conversation's latest open
   * claim. `tipo` (optional) categorizes the photo (tarjeta_verde, carnet,
   * tarjeta_verde_tercero, carnet_tercero) so the admin sees labeled documents.
   */
  async attachAdjunto(
    conversationId: number,
    file: { buffer: Buffer; filename: string; mimeType: string },
    tipo?: string,
  ): Promise<AttachAdjuntosResult> {
    const form = new FormData();
    form.append(
      'adjuntos',
      // Uint8Array.from yields a standard ArrayBuffer-backed view (Buffer's
      // ArrayBufferLike type is not assignable to BlobPart directly).
      new Blob([Uint8Array.from(file.buffer)], { type: file.mimeType }),
      file.filename,
    );

    const query = tipo ? `?tipo=${encodeURIComponent(tipo)}` : '';
    const { data } = await this.http.post<AttachAdjuntosResult>(
      `/bot/conversation/${conversationId}/adjuntos${query}`,
      form,
    );
    return data;
  }

  /**
   * Canonical product catalog (descriptions, no prices) shared with the web.
   * Cached in memory so describing a product never costs a round-trip per turn;
   * on a fetch error we serve the last good copy (or an empty list on cold start)
   * so a catalog hiccup never breaks a reply.
   */
  async getProducts(): Promise<ProductCatalogItem[]> {
    const now = Date.now();
    if (this.catalogCache && now - this.catalogCache.fetchedAt < CATALOG_TTL_MS) {
      return this.catalogCache.items;
    }
    try {
      const { data } = await this.http.get<ProductCatalogItem[]>(
        '/public/products',
      );
      this.catalogCache = { items: data, fetchedAt: now };
      return data;
    } catch (error) {
      if (this.catalogCache) return this.catalogCache.items;
      throw error;
    }
  }

  /**
   * Live business-hours status (formatted week + open-now + closure), computed by
   * the API from the configured schedule. Briefly cached so a burst of messages
   * doesn't refetch; on error we serve the last good copy when we have one.
   */
  async getHours(): Promise<HoursStatus> {
    const now = Date.now();
    if (this.hoursCache && now - this.hoursCache.fetchedAt < HOURS_TTL_MS) {
      return this.hoursCache.status;
    }
    try {
      const { data } = await this.http.get<HoursStatus>('/public/hours');
      this.hoursCache = { status: data, fetchedAt: now };
      return data;
    } catch (error) {
      if (this.hoursCache) return this.hoursCache.status;
      throw error;
    }
  }

  // ─── Public endpoints (infoauto + cotizador) ───────────

  async searchBrands(
    vehicleType: VehicleTypeParam,
    query?: string,
  ): Promise<InfoAutoBrand[]> {
    const { data } = await this.http.get<{ data: InfoAutoBrand[] }>(
      `/infoauto/${vehicleType}/brands`,
      {
        params: { query_string: query || undefined, page_size: 20 },
      },
    );
    return data.data;
  }

  async getGroups(
    vehicleType: VehicleTypeParam,
    brandId: number,
  ): Promise<InfoAutoGroup[]> {
    const { data } = await this.http.get<{ data: InfoAutoGroup[] }>(
      `/infoauto/${vehicleType}/brands/${brandId}/groups`,
      { params: { page_size: 50 } },
    );
    return data.data;
  }

  async getModels(
    vehicleType: VehicleTypeParam,
    brandId: number,
    groupId: number,
    query?: string,
  ): Promise<InfoAutoModel[]> {
    const { data } = await this.http.get<{ data: InfoAutoModel[] }>(
      `/infoauto/${vehicleType}/brands/${brandId}/groups/${groupId}/models`,
      { params: { query_string: query || undefined, page_size: 30 } },
    );
    return data.data;
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
