import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPlanner, parsePolicyJson } from "../src/planner/planner";
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
});
