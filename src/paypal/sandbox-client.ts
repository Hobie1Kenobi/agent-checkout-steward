import { assertSandboxBase, credential } from "../env";
import { buildCreateOrderBody, assertOrderId, mapPayPalOrder } from "./contract";
import { plainPayPalError, readJson } from "./errors";
import type { CaptureOptions, CheckoutOrder, CreateOrderInput, PayPalHooks, PayPalOrdersClient } from "./types";

const MAX_ATTEMPTS = 3;

export interface SandboxClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class SandboxPayPalClient implements PayPalOrdersClient {
  readonly mode = "sandbox" as const;
  private readonly base: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(env: NodeJS.ProcessEnv, options: SandboxClientOptions = {}) {
    this.base = assertSandboxBase(env.PAYPAL_API_BASE);
    this.clientId = credential(env, "PAYPAL_CLIENT_ID");
    this.clientSecret = credential(env, "PAYPAL_CLIENT_SECRET");
    if (!this.clientId || !this.clientSecret) {
      throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required for PayPal sandbox mode.");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async createOrder(input: CreateOrderInput, hooks?: PayPalHooks): Promise<CheckoutOrder> {
    const body = buildCreateOrderBody(input);
    const payload = await this.request("/v2/checkout/orders", {
      method: "POST",
      body: JSON.stringify(body),
      requestId: input.requestId,
      hooks,
    });
    return mapPayPalOrder(payload, this.base);
  }

  async getOrder(id: string, hooks?: PayPalHooks): Promise<CheckoutOrder> {
    const payload = await this.request(`/v2/checkout/orders/${assertOrderId(id)}`, {
      method: "GET",
      hooks,
    });
    return mapPayPalOrder(payload, this.base);
  }

  async captureOrder(id: string, requestId: string, options: CaptureOptions = {}): Promise<CheckoutOrder> {
    const payload = await this.request(`/v2/checkout/orders/${assertOrderId(id)}/capture`, {
      method: "POST",
      body: "{}",
      requestId,
      negativeTest: options.negativeTest === "instrument_declined",
      hooks: options,
    });
    const order = mapPayPalOrder(payload, this.base);
    if (order.captureStatus === "DECLINED") {
      throw plainPayPalError(422, {
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument presented was declined." }],
      });
    }
    return order;
  }

  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.now() < this.cachedToken.expiresAt) return this.cachedToken.value;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const payload = await readJson(response);
    if (response.status !== 200) throw plainPayPalError(response.status, payload);
    const record = payload as { access_token?: unknown; expires_in?: unknown };
    if (typeof record.access_token !== "string" || record.access_token.length === 0) {
      throw new Error("PayPal token response did not include an access token.");
    }
    const expiresIn = typeof record.expires_in === "number" && record.expires_in > 0 ? record.expires_in : 300;
    const ttlMs = expiresIn * 1000;
    const skew = ttlMs > 60_000 ? 30_000 : 0;
    this.cachedToken = { value: record.access_token, expiresAt: this.now() + ttlMs - skew };
    return record.access_token;
  }

  private async request(
    path: string,
    init: {
      method: "GET" | "POST";
      body?: string;
      requestId?: string;
      negativeTest?: boolean;
      hooks?: PayPalHooks;
    },
  ): Promise<unknown> {
    let transportFailures = 0;
    let refreshed = false;
    while (true) {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${await this.accessToken()}`,
        Prefer: "return=representation",
      };
      if (init.body !== undefined) headers["Content-Type"] = "application/json";
      if (init.requestId) headers["PayPal-Request-Id"] = init.requestId;
      if (init.negativeTest) {
        headers["PayPal-Mock-Response"] = JSON.stringify({ mock_application_codes: "INSTRUMENT_DECLINED" });
      }
      const response = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method,
        headers,
        body: init.body,
      });
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this.cachedToken = null;
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && transportFailures < MAX_ATTEMPTS - 1) {
        transportFailures += 1;
        init.hooks?.onRetry?.({
          failedAttempt: transportFailures,
          status: response.status,
          maxAttempts: MAX_ATTEMPTS,
        });
        await this.sleep(transportFailures === 1 ? 250 : 750);
        continue;
      }
      const payload = await readJson(response);
      if (response.status !== 200 && response.status !== 201) {
        throw plainPayPalError(response.status, payload);
      }
      return payload;
    }
  }
}
