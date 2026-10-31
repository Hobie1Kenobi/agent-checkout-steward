import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { buildSession } from "../src/runtime";
import { listen } from "../src/server";

describe("checkout desk", () => {
  it("serves the page and runs the mock purchase through the HTTP API", async () => {
    const session = buildSession({
      CHECKOUT_MODE: "mock",
      LLM_PROVIDER: "none",
      CHECKOUT_AUDIT_PATH: "",
    });
    const server = await listen(session);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const page = await fetch(`${base}/`);
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(html, /Agent Checkout Steward/);
      assert.match(readFileSync("public/app.js", "utf8"), /Capture payment/);

      const health = await fetch(`${base}/api/health`);
      const healthBody = (await health.json()) as { ok: boolean; mode: string; paypal: string };
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.mode, "mock");
      assert.equal(healthBody.paypal, "orders-v2");

      const draft = await post(base, "/api/scenarios/happy/draft");
      assert.equal(draft.phase, "draft_ready");
      const confirmed = await post(base, "/api/confirm");
      assert.equal(confirmed.phase, "confirmed");
      const created = await post(base, "/api/order");
      assert.equal(created.phase, "awaiting_buyer");
      assert.match(created.order.approveUrl, /\/mock\/approve\?token=/);
      const approved = await post(base, `/api/approve?token=${created.order.id}`);
      assert.equal(approved.phase, "approved");
      const captured = await post(base, "/api/capture");
      assert.equal(captured.phase, "completed");
      assert.equal(captured.order.status, "COMPLETED");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

async function post(base: string, path: string): Promise<{
  phase: string;
  order: { id: string; approveUrl: string; status: string };
}> {
  const response = await fetch(`${base}${path}`, { method: "POST" });
  const body = (await response.json()) as {
    phase: string;
    error?: string;
    order: { id: string; approveUrl: string; status: string };
  };
  assert.equal(response.status, 200, body.error ?? path);
  return body;
}
