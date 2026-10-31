export const MANDATE = {
  budgetCap: "150.00",
  currency: "USD" as const,
  merchantAllowlist: ["Harbor & Co", "Northline Supply"] as const,
  purchaseKind: "one_time" as const,
  reapproval: {
    onAmountChange: true as const,
    onMerchantChange: true as const,
  },
};

export interface Mandate {
  budgetCap: string;
  currency: "USD";
  merchantAllowlist: readonly string[];
  purchaseKind: "one_time";
  reapproval: { onAmountChange: true; onMerchantChange: true };
}

export interface Cart {
  merchant: string;
  amount: string;
  currency: "USD";
  description: string;
  sku: string;
  kind: "one_time" | "subscription";
}

export interface PurchasePolicy {
  budgetCap: { currency: "USD"; amount: string };
  merchantAllowlist: string[];
  purchaseKind: "one_time";
  reapproval: { onAmountChange: true; onMerchantChange: true };
  intentSummary: string;
}

export interface ApprovalSnapshot {
  merchant: string;
  amount: string;
  currency: "USD";
  policy: PurchasePolicy;
  approvedAt: string;
}
