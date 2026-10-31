import { isSandboxApiBase } from "../env";
import { usdCents } from "../money";
import type { CheckoutOrder, CreateOrderInput, PayPalLink } from "./types";

export interface CreateOrderBody {
  intent: "CAPTURE";
  purchase_units: Array<{
    reference_id: "default";
    description: string;
    custom_id: string;
    invoice_id: string;
    amount: { currency_code: "USD"; value: string };
  }>;
  payment_source: {
    paypal: {
      experience_context: {
        brand_name: "Agent Checkout Steward";
        landing_page: "LOGIN";
        shipping_preference: "NO_SHIPPING";
        user_action: "PAY_NOW";
        return_url: string;
        cancel_url: string;
        payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED";
      };
    };
  };
}

function bounded(name: string, value: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new Error(`${name} must be 1 to ${max} characters.`);
  }
  return trimmed;
}

function absoluteUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http or https URL.`);
  }
  return url.toString();
}

export function buildCreateOrderBody(input: CreateOrderInput): CreateOrderBody {
  if (input.currency !== "USD" || usdCents(input.amount) == null) {
    throw new Error("PayPal order amount must be a positive USD value with two decimals.");
  }
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: "default",
        description: bounded("Description", input.description, 127),
        custom_id: bounded("custom_id", input.customId, 127),
        invoice_id: bounded("invoice_id", input.invoiceId, 127),
        amount: { currency_code: "USD", value: input.amount },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "Agent Checkout Steward",
          landing_page: "LOGIN",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url: absoluteUrl("return_url", input.returnUrl),
          cancel_url: absoluteUrl("cancel_url", input.cancelUrl),
          payment_method_preference: "IMMEDIATE_PAYMENT_REQUIRED",
        },
      },
    },
  };
}

export function assertOrderId(id: string): string {
  if (!/^[A-Z0-9]+$/.test(id) || id.length < 1 || id.length > 36) {
    throw new Error("That is not a PayPal order id.");
  }
  return id;
}

function acceptApprovalUrl(href: string | undefined, apiBase: string): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const sandbox = isSandboxApiBase(apiBase);
  if (sandbox && url.host === "www.sandbox.paypal.com") return url.toString();
  if (!sandbox && url.host === "www.paypal.com") return url.toString();
  return null;
}

export function extractApprovalUrl(
  links: PayPalLink[] | undefined,
  apiBase: string,
  orderId: string,
): string | null {
  const list = links ?? [];
  const ordered = [
    ...list.filter((link) => link.rel === "payer-action"),
    ...list.filter((link) => link.rel === "approve"),
  ];
  for (const link of ordered) {
    const accepted = acceptApprovalUrl(link.href, apiBase);
    if (accepted) return accepted;
  }
  if (isSandboxApiBase(apiBase) && /^[A-Z0-9]+$/.test(orderId)) {
    return `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`;
  }
  return null;
}

export function mapPayPalOrder(payload: unknown, apiBase: string): CheckoutOrder {
  if (!payload || typeof payload !== "object") {
    throw new Error("PayPal returned an empty order.");
  }
  const order = payload as {
    id?: unknown;
    status?: unknown;
    links?: PayPalLink[];
    purchase_units?: Array<{
      custom_id?: unknown;
      invoice_id?: unknown;
      amount?: { currency_code?: unknown; value?: unknown };
      payments?: { captures?: Array<{ id?: unknown; status?: unknown }> };
    }>;
  };
  if (typeof order.id !== "string" || !/^[A-Z0-9]+$/.test(order.id)) {
    throw new Error("PayPal order response did not include an order id.");
  }
  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  const currency = typeof unit?.amount?.currency_code === "string" ? unit.amount.currency_code : "USD";
  const value = typeof unit?.amount?.value === "string" ? unit.amount.value : "";
  return {
    id: order.id,
    status: typeof order.status === "string" ? order.status : "UNKNOWN",
    approveUrl: extractApprovalUrl(order.links, apiBase, order.id),
    amount: { currency_code: currency, value },
    customId: typeof unit?.custom_id === "string" ? unit.custom_id : "",
    invoiceId: typeof unit?.invoice_id === "string" ? unit.invoice_id : "",
    captureId: typeof capture?.id === "string" ? capture.id : null,
    captureStatus: typeof capture?.status === "string" ? capture.status : null,
  };
}
