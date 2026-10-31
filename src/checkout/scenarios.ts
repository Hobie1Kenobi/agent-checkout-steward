import type { Cart } from "../policy/mandate";

export interface Scenario {
  id: string;
  title: string;
  detail: string;
  intent: string;
  hint: string;
  cart: Cart;
  revision?: { amount: string; description: string };
}

const sensor: Cart = {
  merchant: "Harbor & Co",
  amount: "86.00",
  currency: "USD",
  description: "Replacement humidity sensor",
  sku: "HBR-SENSOR-14",
  kind: "one_time",
};

export const SCENARIOS: Scenario[] = [
  {
    id: "happy",
    title: "Sensor, within cap",
    detail: "Harbor & Co · USD 86.00",
    intent: "Buy a one-time replacement humidity sensor from Harbor & Co for USD 86.00.",
    hint: "Confirm the policy, create the order, approve as the buyer, then capture.",
    cart: sensor,
  },
  {
    id: "over-cap",
    title: "Over the budget cap",
    detail: "Harbor & Co · USD 240.00",
    intent: "Buy a one-time calibration bench from Harbor & Co for USD 240.00.",
    hint: "The merchant is allowed. The amount is over the cap, so checkout must stop before PayPal.",
    cart: {
      ...sensor,
      amount: "240.00",
      description: "Calibration bench",
      sku: "HBR-BENCH-2",
    },
  },
  {
    id: "off-list",
    title: "Merchant not allowed",
    detail: "Night Market LLC · USD 40.00",
    intent: "Buy a one-time cable kit from Night Market LLC for USD 40.00.",
    hint: "The amount is under the cap. The merchant is not on the allowlist.",
    cart: {
      merchant: "Night Market LLC",
      amount: "40.00",
      currency: "USD",
      description: "Cable kit",
      sku: "NM-CABLE-9",
      kind: "one_time",
    },
  },
  {
    id: "amount-change",
    title: "Amount changes",
    detail: "Harbor & Co · USD 86.00 then 110.00",
    intent: "Buy a one-time replacement humidity sensor from Harbor & Co for USD 86.00.",
    hint: "Confirm USD 86.00, apply the supplier revision, then approve the new amount before PayPal is contacted.",
    cart: sensor,
    revision: { amount: "110.00", description: "Replacement humidity sensor, revised quote" },
  },
  {
    id: "cancel",
    title: "Buyer cancels",
    detail: "Harbor & Co · USD 86.00",
    intent: "Buy a one-time replacement humidity sensor from Harbor & Co for USD 86.00.",
    hint: "Create the order, then cancel before capture.",
    cart: sensor,
  },
  {
    id: "declined",
    title: "Payment declined",
    detail: "Harbor & Co · USD 86.00",
    intent: "Buy a one-time replacement humidity sensor from Harbor & Co for USD 86.00.",
    hint: "Approve the order. Capture is prepared to come back declined.",
    cart: sensor,
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((item) => item.id === id);
}
