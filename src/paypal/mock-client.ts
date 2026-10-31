import { randomBytes } from "node:crypto";
import { PayPalApiError } from "./errors";
import type {
  CaptureOptions,
  CheckoutOrder,
  CreateOrderInput,
  PayPalHooks,
  PayPalOrdersClient,
} from "./types";

function newId(prefix: string, extra: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(extra);
  let out = prefix;
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export class MockPayPalClient implements PayPalOrdersClient {
  readonly mode = "mock" as const;
  readonly calls: string[] = [];
  captureFailuresRemaining = 0;
  private readonly orders = new Map<string, CheckoutOrder>();
  private readonly byRequest = new Map<string, string>();

  async createOrder(input: CreateOrderInput, _hooks?: PayPalHooks): Promise<CheckoutOrder> {
    this.calls.push("create");
    const existing = this.byRequest.get(input.requestId);
    if (existing) return this.must(existing);
    const id = newId("MOCK", 13);
    const origin = new URL(input.returnUrl).origin;
    const order: CheckoutOrder = {
      id,
      status: "CREATED",
      approveUrl: `${origin}/mock/approve?token=${id}`,
      amount: { currency_code: "USD", value: input.amount },
      customId: input.customId,
      invoiceId: input.invoiceId,
      captureId: null,
      captureStatus: null,
    };
    this.orders.set(id, order);
    this.byRequest.set(input.requestId, id);
    return order;
  }

  async getOrder(id: string): Promise<CheckoutOrder> {
    this.calls.push("get");
    return this.must(id);
  }

  async captureOrder(id: string, requestId: string, options: CaptureOptions = {}): Promise<CheckoutOrder> {
    this.calls.push("capture");
    const prior = this.byRequest.get(`capture:${requestId}`);
    if (prior) return this.must(prior);
    let failedAttempt = 0;
    while (this.captureFailuresRemaining > 0 && failedAttempt < 2) {
      this.captureFailuresRemaining -= 1;
      failedAttempt += 1;
      options.onRetry?.({ failedAttempt, status: 503, maxAttempts: 3 });
    }
    if (this.captureFailuresRemaining > 0) {
      this.captureFailuresRemaining -= 1;
      throw new PayPalApiError("PayPal returned HTTP 503 on attempt 3 of 3.", {
        status: 503,
        issue: "SERVICE_UNAVAILABLE",
        retryable: true,
      });
    }
    const order = this.must(id);
    if (order.status === "VOIDED") {
      throw new PayPalApiError(`Simulated order ${id} was cancelled before capture.`, {
        status: 422,
        issue: "ORDER_NOT_APPROVED",
      });
    }
    if (order.status !== "APPROVED" && order.status !== "COMPLETED") {
      throw new PayPalApiError("Capture waits until the buyer approves the order.", {
        status: 422,
        issue: "ORDER_NOT_APPROVED",
      });
    }
    if (order.status === "COMPLETED") return order;
    if (options.negativeTest === "instrument_declined") {
      throw new PayPalApiError("The buyer's payment method was declined. No funds were captured.", {
        status: 422,
        issue: "INSTRUMENT_DECLINED",
      });
    }
    const captured: CheckoutOrder = {
      ...order,
      status: "COMPLETED",
      captureId: newId("CAP", 14),
      captureStatus: "COMPLETED",
    };
    this.orders.set(id, captured);
    this.byRequest.set(`capture:${requestId}`, id);
    return captured;
  }

  markBuyerApproved(id: string): CheckoutOrder {
    this.calls.push("approve");
    const order = this.must(id);
    if (order.status !== "CREATED" && order.status !== "PAYER_ACTION_REQUIRED" && order.status !== "APPROVED") {
      throw new Error(`Simulated order ${id} cannot be approved from status ${order.status}.`);
    }
    const approved = { ...order, status: "APPROVED" };
    this.orders.set(id, approved);
    return approved;
  }

  markCancelled(id: string): CheckoutOrder {
    this.calls.push("cancel");
    const order = this.must(id);
    const cancelled = { ...order, status: "VOIDED" };
    this.orders.set(id, cancelled);
    return cancelled;
  }

  private must(id: string): CheckoutOrder {
    const order = this.orders.get(id);
    if (!order) throw new Error(`No simulated order ${id}.`);
    return order;
  }
}
