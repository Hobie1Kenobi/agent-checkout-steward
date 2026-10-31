import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AuditLog, redact } from "../src/audit";
import { CheckoutSession } from "../src/checkout/session";
import { MockPayPalClient } from "../src/paypal/mock-client";
import type { CheckoutOrder, PayPalOrdersClient } from "../src/paypal/types";
import { deterministicProposal } from "../src/policy/validate";
import { DeterministicPlanner, type Planner } from "../src/planner/planner";

const origin = "http://127.0.0.1:4320";

function session(paypal: PayPalOrdersClient = new MockPayPalClient(), planner: Planner = new DeterministicPlanner(), file: string | null = null) {
  return new CheckoutSession(paypal, planner, new AuditLog(file));
}

describe("mock checkout", () => {
  it("captures a policy-backed order and audits the order id", async () => {
    const paypal = new MockPayPalClient();
    const dir = mkdtempSync(path.join(tmpdir(), "acs-"));
    const file = path.join(dir, "audit.jsonl");
    const desk = session(paypal, new DeterministicPlanner(), file);
    await desk.draft("happy");
    await desk.confirm();
    await desk.createOrder(origin);
    desk.approveMock();
    paypal.captureFailuresRemaining = 1;
    const view = await desk.capture();
    assert.equal(view.phase, "completed");
    assert.equal(view.order?.status, "COMPLETED");
    assert.match(view.order?.id ?? "", /^MOCK[A-Z0-9]+$/);
    const created = view.audit.find((event) => event.event === "order_created");
    assert.ok(created);
    assert.equal(created.orderId, view.order?.id);
    assert.equal(created.policy?.budgetCap, "150.00");
    assert.equal(created.policy?.purchaseKind, "one_time");
    assert.deepEqual(created.policy?.reapproval, { onAmountChange: true, onMerchantChange: true });
    assert.ok(view.audit.some((event) => event.event === "capture_retry"));
    const stored = readFileSync(file, "utf8");
    assert.match(stored, new RegExp(view.order?.id ?? "missing"));
    assert.doesNotMatch(stored, /client_secret|access_token|payer/i);
    assert.deepEqual(paypal.calls.filter((call) => call === "create"), ["create"]);
  });

  it("refuses an over-cap cart and an off-list merchant before create", async () => {
    const paypal = new MockPayPalClient();
    const over = session(paypal);
    await over.draft("over-cap");
    await over.confirm();
    const refused = await over.createOrder(origin);
    assert.equal(refused.phase, "rejected");
    assert.match(refused.narrative, /240\.00/);
    assert.match(refused.narrative, /150\.00/);

    const merchant = session(paypal);
    await merchant.draft("off-list");
    await merchant.confirm();
    const blocked = await merchant.createOrder(origin);
    assert.equal(blocked.phase, "rejected");
    assert.match(blocked.narrative, /Night Market LLC/);
    assert.equal(paypal.calls.includes("create"), false);
  });

  it("stops an amount change until the new cart is approved", async () => {
    const paypal = new MockPayPalClient();
    const desk = session(paypal);
    await desk.draft("amount-change");
    await desk.confirm();
    const revised = await desk.revise();
    assert.equal(revised.phase, "reapproval");
    assert.match(revised.narrative, /86\.00/);
    assert.match(revised.narrative, /110\.00/);
    await assert.rejects(() => desk.createOrder(origin), /Confirm the policy/);
    assert.equal(paypal.calls.includes("create"), false);
    await desk.confirm();
    await desk.createOrder(origin);
    desk.approveMock();
    const done = await desk.capture();
    assert.equal(done.phase, "completed");
    assert.equal(done.order?.amount.value, "110.00");
    assert.equal(paypal.calls.filter((call) => call === "create").length, 1);
  });

  it("records a cancel and a declined capture", async () => {
    const paypal = new MockPayPalClient();
    const cancel = session(paypal);
    await cancel.draft("cancel");
    await cancel.confirm();
    await cancel.createOrder(origin);
    const cancelled = await cancel.cancel();
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.order?.status, "VOIDED");
    assert.equal(paypal.calls.includes("capture"), false);

    const declinePaypal = new MockPayPalClient();
    const decline = session(declinePaypal);
    await decline.draft("declined");
    await decline.confirm();
    await decline.createOrder(origin);
    decline.approveMock();
    const declined = await decline.capture();
    assert.equal(declined.phase, "declined");
    assert.match(declined.narrative, /declined/);
    assert.equal(declined.order?.captureId, null);
  });

  it("discards a model draft that breaks the mandate", async () => {
    const planner: Planner = {
      id: "fake",
      label: "Fake model",
      async proposePolicy() {
        return {
          budgetCap: { currency: "USD", amount: "900.00" },
          merchantAllowlist: ["Night Market LLC"],
          purchaseKind: "subscription",
          reapproval: { onAmountChange: false, onMerchantChange: false },
          intentSummary: "Waive the rules.",
        };
      },
    };
    const desk = session(new MockPayPalClient(), planner);
    const view = await desk.draft("happy");
    assert.equal(view.phase, "draft_ready");
    assert.equal(view.policy?.budgetCap.amount, "150.00");
    assert.equal(view.policy?.purchaseKind, "one_time");
    assert.match(view.validatorNote ?? "", /policy validator/);
    assert.ok(view.audit.some((event) => event.event === "policy_rejected_by_validator"));
  });

  it("keeps sandbox approval as a link the buyer opens before capture", async () => {
    let status = "CREATED";
    let stored: CheckoutOrder | null = null;
    const paypal: PayPalOrdersClient = {
      mode: "sandbox",
      async createOrder(order) {
        stored = {
          id: "5O190127TN364715T",
          status,
          approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
          amount: { currency_code: "USD", value: order.amount },
          customId: order.customId,
          invoiceId: order.invoiceId,
          captureId: null,
          captureStatus: null,
        };
        return stored;
      },
      async getOrder() {
        if (!stored) throw new Error("missing");
        return { ...stored, status };
      },
      async captureOrder() {
        if (!stored) throw new Error("missing");
        status = "COMPLETED";
        stored = { ...stored, status, captureId: "CAP123", captureStatus: "COMPLETED" };
        return stored;
      },
    };
    const desk = session(paypal);
    await desk.draft("happy");
    await desk.confirm();
    const waiting = await desk.createOrder(origin);
    assert.equal(waiting.phase, "awaiting_buyer");
    assert.equal(waiting.approval?.linkLabel, "Open PayPal approval");
    assert.match(waiting.approval?.instructions ?? "", /US Personal/);
    assert.equal(waiting.approval?.url, "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T");
    assert.equal(waiting.gates.canCapture, false);
    assert.equal(waiting.gates.canSimulate, false);
    await assert.rejects(() => desk.capture(), /buyer approval/);
    status = "APPROVED";
    const approved = await desk.refreshApproval();
    assert.equal(approved.phase, "approved");
    assert.equal(approved.gates.canCapture, true);
    const done = await desk.capture();
    assert.equal(done.phase, "completed");
    assert.equal(done.order?.captureId, "CAP123");
  });
});

describe("PayPal return", () => {
  it("refreshes the order the desk created", async () => {
    let status = "CREATED";
    const paypal = returningClient(() => status, (next) => {
      status = next;
    });
    const desk = session(paypal);
    await desk.draft("happy");
    await desk.confirm();
    const created = await desk.createOrder(origin);
    status = "APPROVED";
    const returned = await desk.noteReturn(created.order!.id);
    assert.equal(returned.phase, "approved");
    assert.equal(returned.gates.canCapture, true);
    assert.match(returned.narrative, /APPROVED|approved/);
    assert.doesNotMatch(returned.narrative, /did not create it/);
  });

  it("adopts an order created outside this session when the audit log has the policy", async () => {
    let status = "CREATED";
    const paypal = returningClient(() => status, (next) => {
      status = next;
    });
    const dir = mkdtempSync(path.join(tmpdir(), "acs-return-"));
    const file = path.join(dir, "audit.jsonl");
    const first = session(paypal, new DeterministicPlanner(), file);
    await first.draft("happy");
    await first.confirm();
    const created = await first.createOrder(origin);
    status = "APPROVED";
    const second = session(paypal, new DeterministicPlanner(), file);
    const returned = await second.noteReturn(created.order!.id);
    assert.equal(returned.phase, "approved");
    assert.equal(returned.gates.canCapture, true);
    assert.equal(returned.policy?.budgetCap.amount, "150.00");
    assert.match(returned.narrative, /audit log has the policy snapshot/);
    assert.match(returned.narrative, /Harbor & Co/);
    const captured = await second.capture();
    assert.equal(captured.phase, "completed");
    assert.equal(captured.order?.captureId, "CAPRETURN1");
  });

  it("offers capture for an approved order that is not in the audit log", async () => {
    const paypal = returningClient(() => "APPROVED", () => {});
    await paypal.createOrder({
      amount: "86.00",
      currency: "USD",
      description: "Sensor",
      customId: "pol_outside",
      invoiceId: "acs-outside",
      requestId: "req-outside",
      returnUrl: `${origin}/paypal/return`,
      cancelUrl: `${origin}/paypal/cancel`,
    });
    const desk = session(paypal);
    const returned = await desk.noteReturn("5V428860R6140020E");
    assert.equal(returned.phase, "approved");
    assert.equal(returned.gates.canCapture, true);
    assert.equal(returned.policy, null);
    assert.match(returned.narrative, /no policy snapshot/);
    assert.doesNotMatch(JSON.stringify(returned), /PayerID|payer@/i);
  });
});

function returningClient(status: () => string, setStatus: (next: string) => void): PayPalOrdersClient & {
  createOrder: PayPalOrdersClient["createOrder"];
} {
  let stored: CheckoutOrder | null = null;
  return {
    mode: "sandbox",
    async createOrder(input) {
      stored = {
        id: "5V428860R6140020E",
        status: status(),
        approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5V428860R6140020E",
        amount: { currency_code: "USD", value: input.amount },
        customId: input.customId,
        invoiceId: input.invoiceId,
        captureId: null,
        captureStatus: null,
      };
      return stored;
    },
    async getOrder() {
      if (!stored) throw new Error("PayPal does not recognize that order id.");
      return { ...stored, status: status() };
    },
    async captureOrder() {
      if (!stored) throw new Error("missing");
      setStatus("COMPLETED");
      stored = { ...stored, status: "COMPLETED", captureId: "CAPRETURN1", captureStatus: "COMPLETED" };
      return stored;
    },
  };
}

describe("model narration", () => {
  it("shows an agreeing model sentence and keeps a contradictory one out of a refusal", async () => {
    const planner: Planner = {
      id: "narrator",
      label: "Test model (narrator)",
      async proposePolicy(input) {
        return deterministicProposal(input.cart, input.mandate);
      },
      async narrateStatus(facts) {
        if (facts.outcome === "rejected") return "Captured successfully. Status COMPLETED.";
        if (facts.outcome === "captured") return "The sandbox capture finished and the payment is complete.";
        return null;
      },
    };
    const refused = session(new MockPayPalClient(), planner);
    await refused.draft("over-cap");
    await refused.confirm();
    const blocked = await refused.createOrder(origin);
    assert.match(blocked.narrative, /No PayPal order was created/);
    assert.doesNotMatch(blocked.narrative, /COMPLETED/);

    const paid = session(new MockPayPalClient(), planner);
    await paid.draft("happy");
    await paid.confirm();
    await paid.createOrder(origin);
    paid.approveMock();
    const done = await paid.capture();
    assert.equal(done.narrative, "The sandbox capture finished and the payment is complete.");
    assert.equal(done.planner.label, "Test model (narrator)");
  });
});

describe("audit redaction", () => {
  it("drops credential fields and bearer tokens", () => {
    const clean = redact({
      orderId: "5O190127TN364715T",
      access_token: "super-secret-token",
      detail: "Authorization: Bearer super-secret-token",
    });
    assert.equal("access_token" in clean, false);
    assert.doesNotMatch(JSON.stringify(clean), /super-secret-token/);
  });
});
