import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlanner, DEFAULT_GATEWAY_MODEL, parsePolicyJson } from "../src/planner/planner";
import { narrationAgrees } from "../src/narrate";
import { MANDATE, type Cart } from "../src/policy/mandate";
import { validateProposal } from "../src/policy/validate";

const cart: Cart = {
  merchant: "Harbor & Co",
  amount: "86.00",
  currency: "USD",
  description: "Replacement humidity sensor",
  sku: "HBR-SENSOR-14",
  kind: "one_time",
};

describe("policy planner", () => {
  it("uses the deterministic fallback when no model is configured", async () => {
    const planner = createPlanner({ LLM_PROVIDER: "auto" });
    assert.equal(planner.id, "deterministic");
    const proposal = await planner.proposePolicy({ mandate: MANDATE, cart, intent: "Buy the sensor." });
    const validated = validateProposal(proposal);
    assert.equal(validated.ok, true);
  });

  it("parses fenced policy JSON and ignores prose", () => {
    const parsed = parsePolicyJson('Here you go:\n```json\n{"purchaseKind":"one_time"}\n```\nThanks');
    assert.deepEqual(parsed, { purchaseKind: "one_time" });
    assert.equal(parsePolicyJson("no object here"), null);
  });

  it("reads an Anthropic policy draft without keeping a failed response", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          content: [
            {
              text: '```json\n{"budgetCap":{"currency":"USD","amount":"150.00"},"merchantAllowlist":["Harbor & Co","Northline Supply"],"purchaseKind":"one_time","reapproval":{"onAmountChange":true,"onMerchantChange":true},"intentSummary":"One-time sensor from Harbor & Co."}\n```',
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const planner = createPlanner({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key" }, fetchImpl);
    const proposal = await planner.proposePolicy({ mandate: MANDATE, cart, intent: "Buy the sensor." });
    assert.equal(validateProposal(proposal).ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /api\.anthropic\.com/);
  });

  it("drafts and narrates through the AI Gateway with an injected model", async () => {
    const models: string[] = [];
    const planner = createPlanner(
      { LLM_PROVIDER: "auto", AI_GATEWAY_API_KEY: "test-gateway-key", AI_GATEWAY_MODEL: "google/gemini-2.5-flash" },
      {
        generateText: async (request) => {
          models.push(request.model);
          if (request.prompt.includes("Outcome:")) return "PayPal approved the order. You can capture it.";
          return '{"budgetCap":{"currency":"USD","amount":"150.00"},"merchantAllowlist":["Harbor & Co","Northline Supply"],"purchaseKind":"one_time","reapproval":{"onAmountChange":true,"onMerchantChange":true},"intentSummary":"One-time sensor from Harbor & Co."}';
        },
      },
    );
    assert.equal(planner.id, "gateway");
    assert.equal(planner.label, "AI Gateway (google/gemini-2.5-flash)");
    const proposal = await planner.proposePolicy({ mandate: MANDATE, cart, intent: "Buy the sensor." });
    assert.equal(validateProposal(proposal).ok, true);
    const spoken = await planner.narrateStatus?.({
      outcome: "approved",
      facts: "PayPal reports order 5V428860R6140020E as APPROVED.",
      orderId: "5V428860R6140020E",
      orderStatus: "APPROVED",
    });
    assert.match(spoken ?? "", /capture/);
    assert.deepEqual(models, ["google/gemini-2.5-flash", "google/gemini-2.5-flash"]);
  });

  it("uses the documented default gateway model and rejects a paid claim on a refusal", () => {
    const planner = createPlanner({ LLM_PROVIDER: "gateway", AI_GATEWAY_API_KEY: "test-gateway-key" }, {
      generateText: async () => "{}",
    });
    assert.equal(planner.label, `AI Gateway (${DEFAULT_GATEWAY_MODEL})`);
    assert.equal(narrationAgrees("rejected", "Captured successfully. Status COMPLETED."), false);
    assert.equal(narrationAgrees("captured", "The sandbox capture finished and the payment is complete."), true);
  });
});
