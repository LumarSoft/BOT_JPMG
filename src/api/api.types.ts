// Shapes returned by the john-api endpoints the bot consumes.

export interface BotContext {
  producerId: number;
  producerName: string;
  producerSlug: string;
  /** Configurable bot display name (Producer.botName); null → generic fallback. */
  botName: string | null;
  systemPrompt: string;
}

export interface ClientSummary {
  id: number;
  firstName: string;
  lastName: string;
  dni: string;
  email: string;
  phone: string | null;
  city: string | null;
}

export interface ConversationMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface BotConversation {
  conversationId: number;
  client: ClientSummary | null;
  /** True when the previous session expired by inactivity and this is a fresh start. */
  newSession: boolean;
  messages: ConversationMessage[];
  /** When true a human agent has taken over — the bot must only store inbound messages and not reply. */
  botPaused: boolean;
  /** Serialized deterministic flow state ({ step, data } JSON), or null to start
   * fresh. Lets the bot resume the exact step after a restart instead of greeting
   * from scratch. Cleared by the API when a new session starts. */
  flowState: string | null;
}

export interface PendingWarning {
  conversationId: number;
  waId: string;
  phoneNumberId: string;
}

export interface VehiculoSummary {
  dominio: string | null;
  marca: string | null;
  modelo: string | null;
  anio?: number | null;
  cobertura?: string | null;
}

export interface PolizaSummary {
  id: number;
  certificado: string;
  company: string;
  riskType: string;
  status: string;
  vigenciaDesde: string | null;
  vigenciaHasta: string | null;
  paymentMethod: string | null;
  vehiculo: VehiculoSummary | null;
}

export interface CuotaImpaga {
  numeroCuota: number;
  amount: string;
  dueDate: string | null;
  status: string; // "pending" | "overdue" | "rejected"
}

export interface EstadoCuentaPoliza {
  id: number;
  certificado: string;
  riskType: string;
  status: string;
  paymentMethod: string | null;
  vehiculo: VehiculoSummary | null;
  cuotasPagas: number;
  cuotasImpagas: CuotaImpaga[];
  tieneRechazos: boolean;
}

export interface PolizaDocumento {
  codigo: string;
  nombre: string;
  url: string;
}

export interface SiniestroSummary {
  id: number;
  tipo: string;
  descripcion: string;
  fecha: string;
  estado: string;
  /** Official Triunfo claim number — set by the admin after filing it manually in Triunfo's web. */
  nroSiniestroCompania: string | null;
  createdAt: string;
  poliza: { id: number; certificado: string; riskType: string };
}

export interface IdentifyResult {
  client: ClientSummary;
  polizasCount: number;
}

export type VehicleTypeParam = 'auto' | 'moto';

export interface InfoAutoBrand {
  id: number;
  name: string;
}

export interface InfoAutoGroup {
  id: number;
  name: string;
}

export interface InfoAutoModel {
  codia: number;
  description: string;
  prices_from?: number;
  prices_to?: number;
}

export interface QuotePaymentOption {
  code: string;
  name: string;
  premium: number;
  installmentValue: number;
  installments: number;
}

export interface QuoteCoverage {
  code: string;
  paymentOptions: QuotePaymentOption[];
}

export interface QuoteResult {
  quoteNumber: string | null;
  validUntil: string | null;
  vehicleValue: string | null;
  coverages: QuoteCoverage[];
  messages: string[];
}

export interface AttachAdjuntosResult {
  siniestroId: number;
  adjuntosCount: number;
}
