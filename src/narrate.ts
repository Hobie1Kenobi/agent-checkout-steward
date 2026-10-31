import type { CheckoutMode } from "./env";
import type { Decision } from "./policy/enforce";
import type { Cart, PurchasePolicy } from "./policy/mandate";
import type { CheckoutOrder } from "./paypal/types";

export function narrateDecision(decision: Decision): string {
  if (decision.ok) return "Checkout is allowed.";
  switch (decision.code) {
    case "over_cap":
      return `No PayPal order was created. USD ${decision.amount} is over the USD ${decision.cap} budget cap in the confirmed policy.`;
    case "merchant_not_allowed":
      return `No PayPal order was created. ${decision.merchant} is outside the merchant allowlist (${decision.allowlist.join(", ")}).`;
    case "not_one_time":
      return "No PayPal order was created. The policy allows a one-time purchase only.";
    case "bad_amount":
      return "No PayPal order was created. The cart amount must be a positive USD value with two decimals.";
    case "currency":
      return "No PayPal order was created. Orders are in USD.";
    case "reapproval_required":
      return narrateReapproval(decision);
    default:
      return "Checkout is allowed.";
  }
}

function narrateReapproval(decision: Extract<Decision, { code: "reapproval_required" }>): string {
  const parts: string[] = [];
  if (decision.amountFrom && decision.amountTo) {
    parts.push(`the amount changed from USD ${decision.amountFrom} to USD ${decision.amountTo}`);
  }
  if (decision.merchantFrom && decision.merchantTo) {
    parts.push(`the merchant changed from ${decision.merchantFrom} to ${decision.merchantTo}`);
  }
  const change = parts.join(", and ");
  if (!change) return "The cart changed. The policy requires a new approval before PayPal is contacted.";
  const lead = change.charAt(0).toUpperCase() + change.slice(1);
  return `${lead}. The policy requires a new approval before PayPal is contacted.`;
}

export function narrateDraft(
  policy: PurchasePolicy,
  cart: Cart,
  preview: Decision,
  validatorNote: string | null,
): string {
  const sentences = [
    validatorNote,
    `Policy draft: one-time purchases, budget cap USD ${policy.budgetCap.amount}, merchants ${policy.merchantAllowlist.join(", ")}. A change in amount or merchant requires a new approval.`,
    `Cart: ${cart.merchant} for USD ${cart.amount} (${cart.description}).`,
    preview.ok
      ? "This cart fits the draft. Confirm the policy to lock it."
      : narrateDecision(preview),
  ];
  return sentences.filter(Boolean).join(" ");
}

export function narrateConfirmed(policy: PurchasePolicy, cart: Cart): string {
  return `Policy confirmed for ${cart.merchant} at USD ${cart.amount}. Cap USD ${policy.budgetCap.amount}. A new approval is required if the amount or the merchant changes.`;
}

export function narrateOrderCreated(mode: CheckoutMode, order: CheckoutOrder, cart: Cart): string {
  if (mode === "mock") {
    return `Simulated order ${order.id} is waiting for buyer approval. USD ${cart.amount} at ${cart.merchant}. Open the simulated approval page, then capture. No PayPal call was made.`;
  }
  return `PayPal created order ${order.id} for USD ${cart.amount} at ${cart.merchant}. Status ${order.status}. Open the approval link and sign in as your sandbox US Personal buyer. Capture stays off until PayPal reports APPROVED.`;
}

export function narrateAwaiting(mode: CheckoutMode, order: CheckoutOrder, cart: Cart): string {
  if (mode === "mock") {
    return `Simulated order ${order.id} is still waiting for buyer approval. Status ${order.status}.`;
  }
  return `PayPal order ${order.id} is ${order.status}. Sign in on the approval link as your sandbox US Personal buyer. Capture stays off until the status is APPROVED.`;
}

export function narrateApproved(mode: CheckoutMode, orderId: string): string {
  if (mode === "mock") return `Buyer approved simulated order ${orderId}. You can capture it.`;
  return `PayPal reports order ${orderId} as APPROVED. You can capture it.`;
}

export function narrateCaptured(mode: CheckoutMode, order: CheckoutOrder): string {
  const capture = order.captureId ?? "unknown";
  if (mode === "mock") {
    return `Captured in the mock ledger. Order ${order.id}, capture ${capture}, status COMPLETED. The policy snapshot is in the audit log.`;
  }
  return `Captured. PayPal order ${order.id}, capture ${capture}, status COMPLETED. The policy snapshot is in the audit log.`;
}

export function narrateCancelled(mode: CheckoutMode, orderId: string): string {
  if (mode === "mock") {
    return `Buyer cancelled simulated order ${orderId}. Nothing was captured.`;
  }
  return `Buyer cancelled before capture on order ${orderId}. Capture was not requested, so no funds moved. The uncaptured sandbox order expires on its own.`;
}

export function narrateDeclined(mode: CheckoutMode, orderId: string): string {
  if (mode === "mock") {
    return `The simulated payment instrument was declined for order ${orderId}. No funds were captured.`;
  }
  return `PayPal declined the payment instrument for order ${orderId}. No funds were captured. The buyer can try another payment method, or you can stop here.`;
}

export function narrateRetry(status: number, failedAttempt: number, maxAttempts: number): string {
  return `PayPal returned HTTP ${status} on attempt ${failedAttempt} of ${maxAttempts}. Trying again.`;
}

export function narrateAdopted(order: CheckoutOrder, snapshot: { cartMerchant: string; cartAmount: string; budgetCap: string } | null): string {
  const status =
    order.status === "APPROVED"
      ? `PayPal reports order ${order.id} as APPROVED. You can capture it.`
      : order.status === "COMPLETED"
        ? `PayPal order ${order.id} is already COMPLETED${order.captureId ? `, capture ${order.captureId}` : ""}.`
        : order.status === "VOIDED"
          ? `PayPal order ${order.id} is VOIDED. Nothing further will be captured.`
          : `PayPal status is ${order.status}. Capture stays off until the status is APPROVED.`;
  if (snapshot) {
    return `PayPal sent the browser back for order ${order.id}. The audit log has the policy snapshot for ${snapshot.cartMerchant} at USD ${snapshot.cartAmount}, cap USD ${snapshot.budgetCap}. ${status}`;
  }
  return `PayPal sent the browser back for order ${order.id}. This desk session did not create it, and the audit log has no policy snapshot for it. ${status}`;
}

export function narrateReturnMiss(orderId: string, reason: string): string {
  return `PayPal did not return order ${orderId}. ${reason}`;
}

const PAID_CLAIM = /\b(captured|completed)\b/i;
const REFUSED_CLAIM = /no paypal order was created|was declined|buyer cancelled/i;

export function narrationAgrees(outcome: string, text: string): boolean {
  const clean = text.trim();
  if (clean.length < 8 || clean.length > 600) return false;
  if (/[\u0000-\u001f]/.test(clean)) return false;
  const claimsPaid = PAID_CLAIM.test(clean);
  const claimsRefused = REFUSED_CLAIM.test(clean);
  if ((outcome === "rejected" || outcome === "reapproval" || outcome === "declined" || outcome === "cancelled") && claimsPaid) {
    return false;
  }
  if ((outcome === "captured" || outcome === "approved") && claimsRefused) return false;
  return true;
}

export function approvalInstructions(mode: CheckoutMode): string {
  if (mode === "mock") {
    return "Open the simulated approval page and approve as the test buyer, then come back and capture. Mock mode does not call PayPal.";
  }
  return "Open PayPal approval. A new tab opens sandbox checkout. Log in as your US Personal test buyer (PayPal Developer Dashboard, Testing Tools, Sandbox Accounts). Use that account's email and the system-generated password, then approve the payment. This desk checks the order while you are away. When the status is APPROVED, press Capture payment.";
}
