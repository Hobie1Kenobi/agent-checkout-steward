import { usdCents } from "../money";
import type { ApprovalSnapshot, Cart, PurchasePolicy } from "./mandate";
import { canonicalMerchant } from "./validate";

export type Decision =
  | { ok: true }
  | { ok: false; code: "over_cap"; amount: string; cap: string }
  | { ok: false; code: "merchant_not_allowed"; merchant: string; allowlist: string[] }
  | { ok: false; code: "not_one_time" }
  | { ok: false; code: "bad_amount" }
  | { ok: false; code: "currency" }
  | {
      ok: false;
      code: "reapproval_required";
      amountFrom?: string;
      amountTo?: string;
      merchantFrom?: string;
      merchantTo?: string;
    };

export function enforce(policy: PurchasePolicy, cart: Cart, approval: ApprovalSnapshot | null): Decision {
  if (cart.kind !== "one_time") return { ok: false, code: "not_one_time" };
  if (cart.currency !== "USD") return { ok: false, code: "currency" };
  const amountCents = usdCents(cart.amount);
  if (amountCents == null) return { ok: false, code: "bad_amount" };
  const capCents = usdCents(policy.budgetCap.amount);
  if (capCents == null) {
    throw new Error("Confirmed policy cap is not a USD amount.");
  }
  const merchant = canonicalMerchant(cart.merchant, policy.merchantAllowlist);
  if (!merchant) {
    return {
      ok: false,
      code: "merchant_not_allowed",
      merchant: cart.merchant.trim() || "Unknown merchant",
      allowlist: [...policy.merchantAllowlist],
    };
  }
  if (amountCents > capCents) {
    return { ok: false, code: "over_cap", amount: cart.amount, cap: policy.budgetCap.amount };
  }
  if (approval) {
    const amountChanged = approval.amount !== cart.amount;
    const merchantChanged = approval.merchant !== merchant;
    if (amountChanged || merchantChanged) {
      return {
        ok: false,
        code: "reapproval_required",
        amountFrom: amountChanged ? approval.amount : undefined,
        amountTo: amountChanged ? cart.amount : undefined,
        merchantFrom: merchantChanged ? approval.merchant : undefined,
        merchantTo: merchantChanged ? merchant : undefined,
      };
    }
  }
  return { ok: true };
}
