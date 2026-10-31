import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSandboxBase, hasPayPalCredentials, resolveMode } from "../src/env";

describe("checkout mode", () => {
  it("stays in mock when credentials are absent", () => {
    assert.equal(resolveMode({ CHECKOUT_MODE: "auto" }), "mock");
    assert.equal(hasPayPalCredentials({}), false);
  });

  it("selects sandbox when both credentials are set", () => {
    const env = { PAYPAL_CLIENT_ID: "client-id", PAYPAL_CLIENT_SECRET: "client-secret" };
    assert.equal(resolveMode(env), "sandbox");
    assert.equal(hasPayPalCredentials(env), true);
  });

  it("ignores blank credentials and keeps an explicit mock", () => {
    const env = { CHECKOUT_MODE: "mock", PAYPAL_CLIENT_ID: "  ", PAYPAL_CLIENT_SECRET: "client-secret" };
    assert.equal(resolveMode(env), "mock");
    assert.equal(hasPayPalCredentials({ PAYPAL_CLIENT_ID: " ", PAYPAL_CLIENT_SECRET: " " }), false);
  });

  it("requires credentials for sandbox mode", () => {
    assert.throws(() => resolveMode({ CHECKOUT_MODE: "sandbox" }), /PAYPAL_CLIENT_ID/);
  });

  it("rejects the live PayPal host", () => {
    assert.throws(() => assertSandboxBase("https://api-m.paypal.com"), /Live PayPal is disabled/);
    assert.equal(assertSandboxBase(undefined), "https://api-m.sandbox.paypal.com");
    assert.equal(assertSandboxBase("https://api-m.sandbox.paypal.com/"), "https://api-m.sandbox.paypal.com");
  });
});
