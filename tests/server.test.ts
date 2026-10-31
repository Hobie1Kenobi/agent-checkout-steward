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

      const again = buildSession({
        CHECKOUT_MODE: "mock",
        LLM_PROVIDER: "none",
        CHECKOUT_AUDIT_PATH: "",
      });
      const againServer = await listen(again);
      const againPort = (againServer.address() as AddressInfo).port;
      const againBase = `http://127.0.0.1:${againPort}`;
      try {
        const drafted = await post(againBase, "/api/scenarios/happy/draft");
        assert.equal(drafted.phase, "draft_ready");
        await post(againBase, "/api/confirm");
        const opened = await post(againBase, "/api/order");
        const payer = "PAYER-SHOULD-NOT-APPEAR";
        const returned = await fetch(`${againBase}/paypal/return?token=${opened.order.id}&PayerID=${payer}`);
        const html = await returned.text();
        assert.equal(returned.status, 200);
        assert.doesNotMatch(html, /does not match the open order/);
        assert.doesNotMatch(html, new RegExp(payer));
        await post(againBase, `/api/approve?token=${opened.order.id}`);
        const approved = await fetch(`${againBase}/paypal/return?token=${opened.order.id}&PayerID=${payer}`);
        const approvedHtml = await approved.text();
        assert.equal(approved.status, 200);
        assert.match(approvedHtml, /approved/i);
        assert.doesNotMatch(approvedHtml, new RegExp(payer));
        const finished = await post(againBase, "/api/capture");
        assert.equal(finished.phase, "completed");
      } finally {
        await new Promise<void>((resolve, reject) => againServer.close((error) => (error ? reject(error) : resolve())));
      }
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
