import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface PolicySnapshot {
  budgetCap: string;
  currency: "USD";
  merchantAllowlist: string[];
  purchaseKind: "one_time";
  reapproval: { onAmountChange: true; onMerchantChange: true };
  cartMerchant: string;
  cartAmount: string;
  intentSummary: string;
}

export type AuditEventName =
  | "policy_drafted"
  | "policy_rejected_by_validator"
  | "policy_confirmed"
  | "checkout_rejected"
  | "reapproval_required"
  | "order_created"
  | "buyer_approved"
  | "capture_retry"
  | "create_retry"
  | "read_retry"
  | "captured"
  | "cancelled"
  | "declined"
  | "paypal_error"
  | "order_adopted"
  | "desk_reset";

export interface AuditEvent {
  at: string;
  event: AuditEventName;
  orderId?: string;
  customId?: string;
  policy?: PolicySnapshot;
  detail: string;
}

const SECRET_KEYS = new Set([
  "accesstoken",
  "access_token",
  "clientsecret",
  "client_secret",
  "refreshtoken",
  "refresh_token",
  "authorization",
  "password",
  "secret",
  "email",
  "emailaddress",
  "email_address",
  "payer",
  "payerid",
  "payer_id",
  "card",
  "cvv",
  "pan",
  "ssn",
  "cookie",
  "apikey",
  "api_key",
  "paypalclientsecret",
]);

function isSecretKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (SECRET_KEYS.has(norm) || SECRET_KEYS.has(key.toLowerCase())) return true;
  return norm.includes("secret") || norm.includes("password") || norm.endsWith("token");
}

function scrubString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted]")
    .replace(/\b(access_token|client_secret|refresh_token)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

export function redact<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((item) => walk(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSecretKey(key)) continue;
    out[key] = walk(item);
  }
  return out;
}

export class AuditLog {
  readonly events: AuditEvent[] = [];

  constructor(private readonly filePath: string | null) {
    if (filePath) mkdirSync(path.dirname(filePath), { recursive: true });
  }

  record(event: AuditEvent): AuditEvent {
    const clean = redact(event);
    this.events.push(clean);
    this.append(clean);
    return clean;
  }

  reset(): void {
    this.events.length = 0;
    this.append({
      at: new Date().toISOString(),
      event: "desk_reset",
      detail: "Desk reset.",
    });
  }

  policyForOrder(orderId: string, customId?: string): PolicySnapshot | undefined {
    const events = [...this.storedEvents(), ...this.events];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.orderId === orderId && event.policy) return event.policy;
    }
    if (!customId) return undefined;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.customId === customId && event.policy) return event.policy;
    }
    return undefined;
  }

  private storedEvents(): AuditEvent[] {
    if (!this.filePath || !existsSync(this.filePath)) return [];
    const events: AuditEvent[] = [];
    for (const line of readFileSync(this.filePath, "utf8").split(/\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AuditEvent;
        if (parsed && typeof parsed.event === "string" && typeof parsed.detail === "string") events.push(parsed);
      } catch {
        continue;
      }
    }
    return events;
  }

  private append(event: AuditEvent): void {
    if (!this.filePath) return;
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
