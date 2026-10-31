import path from "node:path";
import { AuditLog } from "./audit";
import { CheckoutSession } from "./checkout/session";
import { resolveMode } from "./env";
import { createPayPalClient } from "./paypal";
import { createPlanner } from "./planner/planner";

export function auditFile(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CHECKOUT_AUDIT_PATH === "") return null;
  if (env.CHECKOUT_AUDIT_PATH) return env.CHECKOUT_AUDIT_PATH;
  return path.join(process.cwd(), "data", "audit.jsonl");
}

export function buildSession(env: NodeJS.ProcessEnv = process.env): CheckoutSession {
  const configured = (env.CHECKOUT_PUBLIC_BASE ?? "").trim().replace(/\/$/, "");
  return new CheckoutSession(
    createPayPalClient(env),
    createPlanner(env),
    new AuditLog(auditFile(env)),
    configured || null,
  );
}

export function describeRuntime(env: NodeJS.ProcessEnv = process.env): { mode: string; planner: string } {
  return { mode: resolveMode(env), planner: createPlanner(env).label };
}
