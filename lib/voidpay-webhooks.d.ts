export type WebhookEvent = 'TRANSACTION_CREATED' | 'TRANSACTION_PAID';
export type TransactionStatus = 'COMPLETED' | 'FAILED' | 'PENDING' | 'REFUNDED' | 'CHARGED_BACK';
export interface Address {
  country: string; zipCode: string; state: string; city: string;
  neighborhood: string; street: string; number: string; complement?: string | null;
}
export interface Client {
  id: string; name: string; email: string; phone: string;
  cpf: string | null; cnpj: string | null; address: Address | null;
}
export interface PixInformation { id?: string; qrCode: string; endToEndId: string | null }
export interface BoletoInformation {
  transactionId: string; id: string; barcode: string; digitableLine: string;
  pdfUrl: string; instructions: string; createdAt: string; updatedAt: string;
}
export interface Subscription {
  id: string; identifier: string; cycle: number; startAt: string;
  intervalType: 'DAYS' | 'WEEKS' | 'MONTHS' | 'YEARS'; intervalCount: number;
  status: 'ACTIVE' | 'INACTIVE' | 'CANCELED';
}
export interface OrderItem {
  id: string; price: number; product: { id: string; name: string; externalId: string };
}
export interface TrackProps {
  utm_id?: string; utm_source?: string; utm_medium?: string; utm_campaign?: string;
  utm_content?: string; utm_term?: string; fbc?: string; fbp?: string; ip?: string;
  country?: string; user_agent?: string; zip_code?: string; city?: string; state?: string;
  isUpsell?: boolean;
}
export interface Transaction {
  id: string;
  /** Optional because the supplied examples omit identifier. Matching falls back to id. */
  identifier?: string | null;
  status: TransactionStatus; paymentMethod: 'CREDIT_CARD' | 'PIX' | 'BOLETO' | 'CRYPTO';
  originalAmount: number; amount: number; commissionAmount?: number;
  originalCurrency: string; currency: string; exchangeRate?: number; installments: number;
  createdAt: string; payedAt: string | null;
  pixInformation?: PixInformation | null; boletoInformation?: BoletoInformation | null;
  /** Both root-level and nested placement occur in the supplied examples. */
  subscription?: Subscription | null; orderItems?: OrderItem[]; trackProps?: TrackProps;
}
export interface WebhookPayload {
  event: WebhookEvent; token: string; offerCode: string; checkoutUrl: string;
  client: Client; transaction: Transaction;
  subscription?: Subscription | null; orderItems?: OrderItem[]; trackProps?: TrackProps;
}
export interface Receipt {
  event: WebhookEvent; transactionId: string; identifier: string | null;
  status: TransactionStatus; paymentMethod: Transaction['paymentMethod'];
  amountCents: number; currency: string; createdAt: string; paidAt: string | null;
  receivedAt: string;
}
export class WebhookError extends Error { status: number }
export function createWebhooks(options: {
  directory?: string; token?: string; publicBaseUrl?: string;
  store?: {
    read(key: string): Promise<Receipt | null>;
    create(key: string, value: Receipt): Promise<boolean>;
  };
}): {
  enabled: boolean;
  receive(payload: unknown, expectedEvent: WebhookEvent): Promise<{ accepted: true; duplicate: boolean }>;
  stateFor(record: { paid?: boolean; identifier: string; result?: { transactionId: string }; order: { amount: number } }): Promise<{ paid: boolean; verificationAvailable: boolean }>;
};
