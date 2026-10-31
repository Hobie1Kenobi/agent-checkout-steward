export interface CreateOrderInput {
  amount: string;
  currency: "USD";
  description: string;
  customId: string;
  invoiceId: string;
  requestId: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface CheckoutOrder {
  id: string;
  status: string;
  approveUrl: string | null;
  amount: { currency_code: string; value: string };
  customId: string;
  invoiceId: string;
  captureId: string | null;
  captureStatus: string | null;
}

export interface RetryNotice {
  failedAttempt: number;
  status: number;
  maxAttempts: number;
}

export interface PayPalHooks {
  onRetry?: (notice: RetryNotice) => void;
}

export interface CaptureOptions extends PayPalHooks {
  negativeTest?: "instrument_declined" | null;
}

export interface PayPalOrdersClient {
  readonly mode: "mock" | "sandbox";
  createOrder(input: CreateOrderInput, hooks?: PayPalHooks): Promise<CheckoutOrder>;
  getOrder(id: string, hooks?: PayPalHooks): Promise<CheckoutOrder>;
  captureOrder(id: string, requestId: string, options?: CaptureOptions): Promise<CheckoutOrder>;
}

export interface PayPalLink {
  href?: string;
  rel?: string;
  method?: string;
}
