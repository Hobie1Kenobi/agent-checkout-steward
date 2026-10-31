import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCreateOrderBody, extractApprovalUrl, mapPayPalOrder } from "../src/paypal/contract";
import { PayPalApiError } from "../src/paypal/errors";
import { SandboxPayPalClient } from "../src/paypal/sandbox-client";
import type { CreateOrderInput } from "../src/paypal/types";

const env = {
  PAYPAL_CLIENT_ID: "client-id",
  PAYPAL_CLIENT_SECRET: "client-secret",
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
};

const input: CreateOrderInput = {
  amount: "86.00",
  currency: "USD",
  description: "Replacement humidity sensor",
  customId: "pol_0123456789abcdef0123456789abcdef",
  invoiceId: "acs123",
  requestId: "req-1",
  returnUrl: "http://127.0.0.1:4320/paypal/return",
  cancelUrl: "http://127.0.0.1:4320/paypal/cancel",
};

const created = {
  id: "5O190127TN364715T",
  status: "CREATED",
  purchase_units: [
    {
      custom_id: input.customId,
      invoice_id: input.invoiceId,
      amount: { currency_code: "USD", value: "86.00" },
    },
  ],
  links: [
    { href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T", rel: "self", method: "GET" },
    { href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T", rel: "approve", method: "GET" },
    { href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T/capture", rel: "capture", method: "POST" },
  ],
};

function scripted(steps: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

function headers(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe("Orders v2 contract", () => {
  it("builds a CAPTURE order with the buyer approval experience", () => {
    const body = buildCreateOrderBody(input);
    assert.equal(body.intent, "CAPTURE");
    assert.equal(body.purchase_units[0].amount.currency_code, "USD");
    assert.equal(body.purchase_units[0].amount.value, "86.00");
    assert.equal(body.purchase_units[0].custom_id, input.customId);
    assert.equal(body.payment_source.paypal.experience_context.user_action, "PAY_NOW");
    assert.equal(body.payment_source.paypal.experience_context.landing_page, "LOGIN");
    assert.equal(body.payment_source.paypal.experience_context.shipping_preference, "NO_SHIPPING");
    assert.equal(body.payment_source.paypal.experience_context.return_url, "http://127.0.0.1:4320/paypal/return");
  });

  it("reads the approve link from a CREATED order and prefers payer-action", () => {
    const order = mapPayPalOrder(created, env.PAYPAL_API_BASE);
    assert.equal(order.status, "CREATED");
    assert.equal(order.approveUrl, "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T");
    const preferred = extractApprovalUrl(
      [
        { href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T", rel: "approve" },
        { href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T&useraction=commit", rel: "payer-action" },
      ],
      env.PAYPAL_API_BASE,
      "5O190127TN364715T",
    );
    assert.match(preferred ?? "", /useraction=commit/);
    const fallback = extractApprovalUrl([], env.PAYPAL_API_BASE, "5O190127TN364715T");
    assert.equal(fallback, "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T");
  });

  it("sends client-credentials, then create order, and keeps the token", async () => {
    const { fetchImpl, calls } = scripted([
      { status: 200, body: { access_token: "sandbox-token", expires_in: 32400 } },
      { status: 201, body: created },
      { status: 201, body: created },
    ]);
    const client = new SandboxPayPalClient(env, { fetchImpl, sleep: async () => {}, now: () => 0 });
    const first = await client.createOrder(input);
    await client.createOrder({ ...input, requestId: "req-2" });
    assert.equal(first.id, "5O190127TN364715T");
    assert.equal(first.approveUrl, "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T");
    assert.equal(calls.filter((call) => call.url.endsWith("/v1/oauth2/token")).length, 1);
    const tokenCall = calls[0];
    assert.equal(tokenCall.init.method, "POST");
    assert.equal(tokenCall.init.body, "grant_type=client_credentials");
    const basic = Buffer.from("client-id:client-secret").toString("base64");
    assert.equal(headers(tokenCall.init).Authorization, `Basic ${basic}`);
    const create = calls[1];
    assert.equal(create.url, "https://api-m.sandbox.paypal.com/v2/checkout/orders");
    assert.equal(create.init.method, "POST");
    assert.equal(headers(create.init).Authorization, "Bearer sandbox-token");
    assert.equal(headers(create.init)["PayPal-Request-Id"], "req-1");
    assert.equal(headers(create.init).Prefer, "return=representation");
    assert.deepEqual(JSON.parse(String(create.init.body)), buildCreateOrderBody(input));
  });

  it("retries a 503 capture and maps a declined instrument", async () => {
    const captured = {
      ...created,
      status: "COMPLETED",
      purchase_units: [
        {
          ...created.purchase_units[0],
          payments: { captures: [{ id: "CAP123", status: "COMPLETED" }] },
        },
      ],
    };
    const retry = scripted([
      { status: 200, body: { access_token: "sandbox-token", expires_in: 32400 } },
      { status: 503, body: { name: "INTERNAL_SERVER_ERROR" } },
      { status: 201, body: captured },
    ]);
    const notices: number[] = [];
    const client = new SandboxPayPalClient(env, { fetchImpl: retry.fetchImpl, sleep: async () => {}, now: () => 0 });
    const order = await client.captureOrder("5O190127TN364715T", "cap-1", {
      onRetry: (notice) => notices.push(notice.status),
    });
    assert.equal(order.captureId, "CAP123");
    assert.deepEqual(notices, [503]);
    assert.equal(retry.calls.at(-1)?.url, "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T/capture");

    const declined = scripted([
      { status: 200, body: { access_token: "sandbox-token", expires_in: 32400 } },
      {
        status: 422,
        body: {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "INSTRUMENT_DECLINED", description: "The instrument presented was declined." }],
          debug_id: "debug123",
        },
      },
    ]);
    const declining = new SandboxPayPalClient(env, { fetchImpl: declined.fetchImpl, sleep: async () => {}, now: () => 0 });
    await assert.rejects(
      () => declining.captureOrder("5O190127TN364715T", "cap-2", { negativeTest: "instrument_declined" }),
      (error: unknown) => {
        assert.ok(error instanceof PayPalApiError);
        assert.equal(error.issue, "INSTRUMENT_DECLINED");
        assert.match(error.message, /declined/);
        assert.match(error.message, /debug123/);
        return true;
      },
    );
    assert.match(headers(declined.calls[1].init)["PayPal-Mock-Response"], /INSTRUMENT_DECLINED/);
  });

  it("refuses the live API before any request", () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      throw new Error("network");
    };
    assert.throws(
      () =>
        new SandboxPayPalClient(
          { ...env, PAYPAL_API_BASE: "https://api-m.paypal.com" },
          { fetchImpl },
        ),
      /Live PayPal is disabled/,
    );
    assert.equal(called, false);
  });
});
