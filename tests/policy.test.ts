import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enforce } from "../src/policy/enforce";
import { MANDATE, type ApprovalSnapshot, type Cart, type PurchasePolicy } from "../src/policy/mandate";
import { deterministicProposal, validateProposal } from "../src/policy/validate";
import { narrateDecision } from "../src/narrate";

const cart = (patch: Partial<Cart> = {}): Cart => ({
  merchant: "Harbor & Co",
  amount: "86.00",
  currency: "USD",
  description: "Replacement humidity sensor",
  sku: "HBR-SENSOR-14",
  kind: "one_time",
  ...patch,
});

function approved(policy: PurchasePolicy, amount = "86.00", merchant = "Harbor & Co"): ApprovalSnapshot {
  return { merchant, amount, currency: "USD", policy, approvedAt: "2026-10-31T00:00:00.000Z" };
}

describe("policy validator", () => {
  it("accepts the deterministic proposal", () => {
    const proposal = deterministicProposal(cart());
    const validated = validateProposal(proposal);
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    assert.equal(validated.policy.budgetCap.amount, "150.00");
    assert.equal(validated.policy.purchaseKind, "one_time");
    assert.deepEqual(validated.policy.reapproval, { onAmountChange: true, onMerchantChange: true });
    assert.deepEqual(validated.policy.merchantAllowlist, [...MANDATE.merchantAllowlist]);
  });

  it("rejects a subscription, a waived re-approval, a higher cap, and an extra merchant", () => {
    const validated = validateProposal({
      budgetCap: { currency: "USD", amount: "500.00" },
      merchantAllowlist: ["Harbor & Co", "Night Market LLC"],
      purchaseKind: "subscription",
      reapproval: { onAmountChange: false, onMerchantChange: true },
      intentSummary: "A subscription outside the mandate.",
    });
    assert.equal(validated.ok, false);
    if (validated.ok) return;
    const text = validated.errors.join(" ");
    assert.match(text, /above the operator mandate/);
    assert.match(text, /Night Market LLC/);
    assert.match(text, /one_time/);
    assert.match(text, /amount changes must stay on/);
  });

  it("rejects policy JSON that is not an object", () => {
    const validated = validateProposal("not-json");
    assert.equal(validated.ok, false);
  });
});

describe("checkout enforcer", () => {
  const policy = deterministicProposal(cart());

  it("allows a cart inside the cap and the allowlist", () => {
    assert.equal(enforce(policy, cart(), approved(policy)).ok, true);
    assert.equal(enforce(policy, cart({ amount: "150.00" }), null).ok, true);
  });

  it("rejects an amount over the cap before PayPal is involved", () => {
    const decision = enforce(policy, cart({ amount: "240.00" }), approved(policy, "240.00"));
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.code, "over_cap");
    assert.match(narrateDecision(decision), /240\.00/);
    assert.match(narrateDecision(decision), /150\.00/);
  });

  it("rejects a merchant that is not on the allowlist", () => {
    const decision = enforce(policy, cart({ merchant: "Night Market LLC", amount: "40.00" }), null);
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.code, "merchant_not_allowed");
    assert.match(narrateDecision(decision), /Night Market LLC/);
  });

  it("requires a new approval when the amount or the merchant changes", () => {
    const amount = enforce(policy, cart({ amount: "110.00" }), approved(policy));
    assert.equal(amount.ok, false);
    if (!amount.ok) assert.equal(amount.code, "reapproval_required");
    assert.match(narrateDecision(amount), /86\.00/);
    assert.match(narrateDecision(amount), /110\.00/);

    const merchant = enforce(policy, cart({ merchant: "Northline Supply" }), approved(policy));
    assert.equal(merchant.ok, false);
    if (!merchant.ok) {
      assert.equal(merchant.code, "reapproval_required");
      assert.equal(merchant.merchantFrom, "Harbor & Co");
      assert.equal(merchant.merchantTo, "Northline Supply");
    }
  });

  it("rejects a subscription even when the policy is one-time", () => {
    const decision = enforce(policy, cart({ kind: "subscription" }), null);
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.code, "not_one_time");
  });
});
