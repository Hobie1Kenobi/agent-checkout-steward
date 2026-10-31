import { usdCents } from "../money";
import { MANDATE, type Cart, type Mandate, type PurchasePolicy } from "./mandate";

export type Validation =
  | { ok: true; policy: PurchasePolicy }
  | { ok: false; errors: string[] };

export function canonicalMerchant(name: string, allowlist: readonly string[]): string | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return null;
  return allowlist.find((item) => item.toLowerCase() === key) ?? null;
}

export function deterministicProposal(cart: Cart, mandate: Mandate = MANDATE): PurchasePolicy {
  const summary = `One-time purchase of ${cart.description} from ${cart.merchant} for USD ${cart.amount}.`;
  return {
    budgetCap: { currency: "USD", amount: mandate.budgetCap },
    merchantAllowlist: [...mandate.merchantAllowlist],
    purchaseKind: "one_time",
    reapproval: { onAmountChange: true, onMerchantChange: true },
    intentSummary: summary.slice(0, 280),
  };
}

export function validateProposal(input: unknown, mandate: Mandate = MANDATE): Validation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["Policy JSON must be an object."] };
  }
  const record = input as Record<string, unknown>;
  const errors: string[] = [];

  const cap = record.budgetCap;
  let capAmount = "";
  if (!cap || typeof cap !== "object" || Array.isArray(cap)) {
    errors.push("budgetCap must be an object with currency and amount.");
  } else {
    const capRecord = cap as Record<string, unknown>;
    if (capRecord.currency !== "USD") errors.push("Currency must be USD.");
    if (typeof capRecord.amount !== "string" || usdCents(capRecord.amount) == null) {
      errors.push("Budget cap must be a positive USD amount with two decimals.");
    } else {
      capAmount = capRecord.amount;
      const capCents = usdCents(capAmount)!;
      const mandateCents = usdCents(mandate.budgetCap);
      if (mandateCents == null) errors.push("Operator mandate cap is invalid.");
      else if (capCents > mandateCents) {
        errors.push(`Budget cap USD ${capAmount} is above the operator mandate of USD ${mandate.budgetCap}.`);
      }
    }
  }

  const merchants: string[] = [];
  if (!Array.isArray(record.merchantAllowlist) || record.merchantAllowlist.length === 0) {
    errors.push("merchantAllowlist must list at least one merchant.");
  } else {
    for (const entry of record.merchantAllowlist) {
      if (typeof entry !== "string") {
        errors.push("Each merchant must be a string.");
        continue;
      }
      const canonical = canonicalMerchant(entry, mandate.merchantAllowlist);
      if (!canonical) {
        errors.push(`${entry.trim() || "A blank merchant"} is outside the operator allowlist.`);
        continue;
      }
      if (!merchants.includes(canonical)) merchants.push(canonical);
    }
  }

  if (record.purchaseKind !== "one_time") {
    errors.push("Purchase kind must be one_time.");
  }

  const reapproval = record.reapproval;
  if (!reapproval || typeof reapproval !== "object" || Array.isArray(reapproval)) {
    errors.push("reapproval must set onAmountChange and onMerchantChange to true.");
  } else {
    const flags = reapproval as Record<string, unknown>;
    if (flags.onAmountChange !== true) {
      errors.push("Re-approval when the amount changes must stay on.");
    }
    if (flags.onMerchantChange !== true) {
      errors.push("Re-approval when the merchant changes must stay on.");
    }
  }

  const summary = record.intentSummary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    errors.push("intentSummary must be a short sentence.");
  } else if (summary.trim().length > 280) {
    errors.push("intentSummary must be 280 characters or fewer.");
  } else if (/[\u0000-\u001f]/.test(summary)) {
    errors.push("intentSummary must not contain control characters.");
  }

  if (errors.length > 0 || !capAmount) return { ok: false, errors };

  return {
    ok: true,
    policy: {
      budgetCap: { currency: "USD", amount: capAmount },
      merchantAllowlist: merchants,
      purchaseKind: "one_time",
      reapproval: { onAmountChange: true, onMerchantChange: true },
      intentSummary: (summary as string).trim(),
    },
  };
}
