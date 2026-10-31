import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type CheckoutMode = "mock" | "sandbox";

const SANDBOX_BASES = new Set([
  "https://api-m.sandbox.paypal.com",
  "https://api.sandbox.paypal.com",
]);

const LIVE_BASES = new Set([
  "https://api-m.paypal.com",
  "https://api.paypal.com",
]);

export function loadDotEnv(file = path.join(process.cwd(), ".env")): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function credential(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

export function hasPayPalCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(credential(env, "PAYPAL_CLIENT_ID") && credential(env, "PAYPAL_CLIENT_SECRET"));
}

export function resolveMode(env: NodeJS.ProcessEnv = process.env): CheckoutMode {
  const explicit = (env.CHECKOUT_MODE ?? "auto").trim().toLowerCase();
  if (explicit === "mock") return "mock";
  if (explicit === "sandbox") {
    if (!hasPayPalCredentials(env)) {
      throw new Error(
        "CHECKOUT_MODE=sandbox requires PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. Create a sandbox REST app at https://developer.paypal.com/dashboard/applications/sandbox and put the values in .env.",
      );
    }
    return "sandbox";
  }
  if (explicit !== "auto") {
    throw new Error(`Unknown CHECKOUT_MODE "${explicit}". Use auto, mock, or sandbox.`);
  }
  return hasPayPalCredentials(env) ? "sandbox" : "mock";
}

export function assertSandboxBase(raw: string | undefined): string {
  const base = (raw ?? "https://api-m.sandbox.paypal.com").trim().replace(/\/$/, "");
  if (LIVE_BASES.has(base)) {
    throw new Error("Live PayPal is disabled. Set PAYPAL_API_BASE to https://api-m.sandbox.paypal.com.");
  }
  if (!SANDBOX_BASES.has(base)) {
    throw new Error(
      `PAYPAL_API_BASE must be https://api-m.sandbox.paypal.com. Received "${base || "(empty)"}".`,
    );
  }
  return base;
}

export function isSandboxApiBase(base: string): boolean {
  return SANDBOX_BASES.has(base.replace(/\/$/, ""));
}

export function publicBase(env: NodeJS.ProcessEnv, port: number): string {
  const configured = (env.CHECKOUT_PUBLIC_BASE ?? "").trim().replace(/\/$/, "");
  if (configured) return configured;
  return `http://127.0.0.1:${port}`;
}

export function listenPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.PORT ?? "4320").trim();
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a TCP port. Received "${raw}".`);
  }
  return port;
}
