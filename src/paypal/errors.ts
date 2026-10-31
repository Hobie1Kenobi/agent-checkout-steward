const KNOWN: Record<string, string> = {
  invalid_client: "PayPal rejected the sandbox client id or secret.",
  INSTRUMENT_DECLINED: "The buyer's payment method was declined. No funds were captured.",
  ORDER_NOT_APPROVED: "PayPal does not have buyer approval for this order yet. Open the approval link and sign in as the sandbox US Personal buyer.",
  PAYER_ACTION_REQUIRED: "The buyer still needs to approve this order on PayPal.",
  INVALID_RESOURCE_ID: "PayPal does not recognize that order id.",
  ORDER_ALREADY_CAPTURED: "PayPal already captured this order.",
  TRANSACTION_REFUSED: "PayPal refused the transaction. No funds were captured.",
  PAYMENT_DENIED: "PayPal denied the payment. No funds were captured.",
};

export class PayPalApiError extends Error {
  readonly status: number;
  readonly issue: string;
  readonly debugId: string | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status: number; issue: string; debugId?: string | null; retryable?: boolean },
  ) {
    super(message);
    this.name = "PayPalApiError";
    this.status = options.status;
    this.issue = options.issue;
    this.debugId = options.debugId ?? null;
    this.retryable = options.retryable ?? false;
  }
}

function safeDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 240) return null;
  if (/bearer|secret|access_token|client_secret/i.test(text)) return null;
  return text;
}

export function plainPayPalError(status: number, body: unknown): PayPalApiError {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const details = Array.isArray(record.details) ? record.details : [];
  const first = details[0] && typeof details[0] === "object" ? (details[0] as Record<string, unknown>) : {};
  const issue =
    (typeof first.issue === "string" && first.issue) ||
    (typeof record.error === "string" && record.error) ||
    (typeof record.name === "string" && record.name) ||
    "PAYPAL_ERROR";
  const debugId = typeof record.debug_id === "string" ? record.debug_id : null;
  const known = KNOWN[issue];
  const described = safeDetail(first.description) ?? safeDetail(record.error_description) ?? safeDetail(record.message);
  let message = known ?? described ?? `PayPal returned HTTP ${status} (${issue}).`;
  if (debugId) message = `${message} PayPal debug id ${debugId}.`;
  return new PayPalApiError(message, {
    status,
    issue,
    debugId,
    retryable: status === 429 || status >= 500,
  });
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 180) };
  }
}
