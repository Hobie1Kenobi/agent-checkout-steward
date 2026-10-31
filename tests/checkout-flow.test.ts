import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AuditLog, redact } from "../src/audit";
import { CheckoutSession } from "../src/checkout/session";
import { MockPayPalClient } from "../src/paypal/mock-client";
import type { CheckoutOrder, PayPalOrdersClient } from "../src/paypal/types";
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
    desk.confirm();
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
    over.confirm();
    const refused = await over.createOrder(origin);
    assert.equal(refused.phase, "rejected");
    assert.match(refused.narrative, /240\.00/);
    assert.match(refused.narrative, /150\.00/);

    const merchant = session(paypal);
    await merchant.draft("off-list");
    merchant.confirm();
    const blocked = await merchant.createOrder(origin);
    assert.equal(blocked.phase, "rejected");
    assert.match(blocked.narrative, /Night Market LLC/);
    assert.equal(paypal.calls.includes("create"), false);
  });

  it("stops an amount change until the new cart is approved", async () => {
    const paypal = new MockPayPalClient();
    const desk = session(paypal);
    await desk.draft("amount-change");
    desk.confirm();
    const revised = desk.revise();
    assert.equal(revised.phase, "reapproval");
    assert.match(revised.narrative, /86\.00/);
    assert.match(revised.narrative, /110\.00/);
    await assert.rejects(() => desk.createOrder(origin), /Confirm the policy/);
    assert.equal(paypal.calls.includes("create"), false);
    desk.confirm();
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
    cancel.confirm();
    await cancel.createOrder(origin);
    const cancelled = cancel.cancel();
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.order?.status, "VOIDED");
    assert.equal(paypal.calls.includes("capture"), false);

    const declinePaypal = new MockPayPalClient();
    const decline = session(declinePaypal);
    await decline.draft("declined");
    decline.confirm();
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
    desk.confirm();
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
