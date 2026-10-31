import { resolveMode } from "../env";
import { MockPayPalClient } from "./mock-client";
import { SandboxPayPalClient, type SandboxClientOptions } from "./sandbox-client";
import type { PayPalOrdersClient } from "./types";

export function createPayPalClient(
  env: NodeJS.ProcessEnv = process.env,
  options: SandboxClientOptions = {},
): PayPalOrdersClient {
  if (resolveMode(env) === "mock") return new MockPayPalClient();
  return new SandboxPayPalClient(env, options);
}

export function supportsLocalApproval(client: PayPalOrdersClient): client is MockPayPalClient {
  return client.mode === "mock" && client instanceof MockPayPalClient;
}
