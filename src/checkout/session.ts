import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AuditEvent, AuditLog, PolicySnapshot } from "../audit";
import { scenarioById, SCENARIOS, type Scenario } from "./scenarios";
import type { CheckoutMode } from "../env";
import {
  approvalInstructions,
  narrateApproved,
  narrateAwaiting,
  narrateCancelled,
  narrateCaptured,
  narrateConfirmed,
  narrateDecision,
  narrateDeclined,
  narrateDraft,
  narrateOrderCreated,
  narrateRetry,
} from "../narrate";
import { enforce, type Decision } from "../policy/enforce";
import { MANDATE, type ApprovalSnapshot, type Cart, type PurchasePolicy } from "../policy/mandate";
import { canonicalMerchant, deterministicProposal, validateProposal } from "../policy/validate";
import { supportsLocalApproval } from "../paypal";
import { PayPalApiError } from "../paypal/errors";
import type { CheckoutOrder, PayPalOrdersClient, RetryNotice } from "../paypal/types";
import type { Planner } from "../planner/planner";

export type Phase =
  | "idle"
  | "draft_ready"
  | "confirmed"
  | "reapproval"
  | "rejected"
  | "awaiting_buyer"
  | "approved"
  | "completed"
  | "cancelled"
  | "declined";

export interface DeskView {
  mode: CheckoutMode;
  planner: { id: string; label: string };
  mandate: {
    budgetCap: string;
    currency: "USD";
    merchantAllowlist: string[];
    purchaseKind: "one_time";
    reapproval: { onAmountChange: true; onMerchantChange: true };
  };
  scenarios: Array<{ id: string; title: string; detail: string }>;
  activeScenarioId: string | null;
  phase: Phase;
  cart: Cart | null;
  policy: PurchasePolicy | null;
  narrative: string;
  hint: string | null;
  warning: string | null;
  validatorNote: string | null;
  revisionLabel: string | null;
  order: CheckoutOrder | null;
  approval: {
    url: string | null;
    linkLabel: string;
    instructions: string;
  } | null;
  audit: AuditEvent[];
  gates: {
    canConfirm: boolean;
    canRevise: boolean;
    canCreate: boolean;
    canRefresh: boolean;
    canCapture: boolean;
    canCancel: boolean;
    canSimulate: boolean;
  };
}

export class CheckoutSession {
  private phase: Phase = "idle";
  private scenario: Scenario | null = null;
  private cart: Cart | null = null;
  private policy: PurchasePolicy | null = null;
  private approval: ApprovalSnapshot | null = null;
  private order: CheckoutOrder | null = null;
  private narrative = "Choose a purchase. The steward drafts a policy, and the code decides whether PayPal may be called.";
  private hint: string | null = null;
  private warning: string | null = null;
  private validatorNote: string | null = null;
  private revised = false;
  private busy = false;

  constructor(
    private readonly paypal: PayPalOrdersClient,
    private readonly planner: Planner,
    private readonly audit: AuditLog,
    private readonly configuredBase: string | null = null,
  ) {}

  view(): DeskView {
    const mode = this.paypal.mode;
    const waiting = this.phase === "awaiting_buyer" || this.phase === "approved" || this.phase === "completed" || this.phase === "cancelled" || this.phase === "declined";
    return {
      mode,
      planner: { id: this.planner.id, label: this.planner.label },
      mandate: {
        budgetCap: MANDATE.budgetCap,
        currency: "USD",
        merchantAllowlist: [...MANDATE.merchantAllowlist],
        purchaseKind: "one_time",
        reapproval: { onAmountChange: true, onMerchantChange: true },
      },
      scenarios: SCENARIOS.map((item) => ({ id: item.id, title: item.title, detail: item.detail })),
      activeScenarioId: this.scenario?.id ?? null,
      phase: this.phase,
      cart: this.cart ? { ...this.cart } : null,
      policy: this.policy ? structuredClone(this.policy) : null,
      narrative: this.narrative,
      hint: this.order ? null : this.hint,
      warning: this.warning,
      validatorNote: this.validatorNote,
      revisionLabel: this.scenario?.revision && !this.revised ? `USD ${this.scenario.revision.amount}` : null,
      order: this.order ? { ...this.order } : null,
      approval: this.order && waiting
        ? {
            url: this.order.approveUrl,
            linkLabel: mode === "mock" ? "Open simulated approval" : "Open PayPal approval",
            instructions: approvalInstructions(mode),
          }
        : null,
      audit: [...this.audit.events].reverse(),
      gates: {
        canConfirm: this.phase === "draft_ready" || this.phase === "reapproval",
        canRevise: Boolean(this.scenario?.revision) && !this.revised && (this.phase === "confirmed" || this.phase === "reapproval") && !this.order,
        canCreate: this.phase === "confirmed" && !this.order,
        canRefresh: this.phase === "awaiting_buyer" || this.phase === "approved",
        canCapture: this.phase === "approved",
        canCancel: (this.phase === "awaiting_buyer" || this.phase === "approved") && Boolean(this.order),
        canSimulate: this.phase === "awaiting_buyer" && mode === "mock",
      },
    };
  }

  reset(): DeskView {
    if (this.busy) throw new Error("A checkout step is already running.");
    this.phase = "idle";
    this.scenario = null;
    this.cart = null;
    this.policy = null;
    this.approval = null;
    this.order = null;
    this.hint = null;
    this.warning = null;
    this.validatorNote = null;
    this.revised = false;
    this.narrative = "Desk reset. Choose a purchase to draft a new policy.";
    this.audit.reset();
    return this.view();
  }

  async draft(scenarioId: string): Promise<DeskView> {
    const scenario = scenarioById(scenarioId);
    if (!scenario) throw new Error("Unknown purchase.");
    return this.occupy(async () => {
      this.scenario = scenario;
      this.cart = { ...scenario.cart };
      this.order = null;
      this.approval = null;
      this.revised = false;
      this.warning = null;
      this.hint = scenario.hint;
      const drafted = await this.draftPolicy(scenario.intent, scenario.cart);
      this.policy = drafted.policy;
      this.validatorNote = drafted.note;
      const preview = enforce(drafted.policy, scenario.cart, null);
      this.phase = "draft_ready";
      this.narrative = narrateDraft(drafted.policy, scenario.cart, preview, drafted.note);
      const snapshot = this.snapshot();
      this.audit.record({
        at: new Date().toISOString(),
        event: "policy_drafted",
        policy: snapshot,
        detail: this.narrative,
      });
      if (drafted.note && snapshot) {
        this.audit.record({
          at: new Date().toISOString(),
          event: "policy_rejected_by_validator",
          policy: snapshot,
          detail: drafted.note,
        });
      }
      return this.view();
    });
  }

  confirm(): DeskView {
    if (!this.policy || !this.cart) throw new Error("Draft a policy before confirming it.");
    if (this.phase !== "draft_ready" && this.phase !== "reapproval") {
      throw new Error("This policy is already confirmed.");
    }
    const merchant = canonicalMerchant(this.cart.merchant, this.policy.merchantAllowlist) ?? this.cart.merchant;
    this.approval = {
      merchant,
      amount: this.cart.amount,
      currency: "USD",
      policy: structuredClone(this.policy),
      approvedAt: new Date().toISOString(),
    };
    this.phase = "confirmed";
    this.warning = null;
    this.narrative = narrateConfirmed(this.policy, this.cart);
    this.audit.record({
      at: new Date().toISOString(),
      event: "policy_confirmed",
      policy: this.snapshot(),
      detail: this.narrative,
    });
    return this.view();
  }

  revise(): DeskView {
    if (!this.scenario?.revision || !this.cart || !this.policy || !this.approval) {
      throw new Error("Confirm a policy before applying a revision.");
    }
    if (this.order) throw new Error("The order already exists. A revision needs a new checkout.");
    if (this.revised) throw new Error("The supplier revision is already applied.");
    this.cart = {
      ...this.cart,
      amount: this.scenario.revision.amount,
      description: this.scenario.revision.description,
    };
    this.revised = true;
    const decision = enforce(this.policy, this.cart, this.approval);
    if (decision.ok) {
      throw new Error("The revision did not change the approved cart.");
    }
    this.phase = decision.code === "reapproval_required" ? "reapproval" : "rejected";
    this.narrative = narrateDecision(decision);
    this.audit.record({
      at: new Date().toISOString(),
      event: decision.code === "reapproval_required" ? "reapproval_required" : "checkout_rejected",
      policy: this.snapshot(),
      detail: this.narrative,
    });
    return this.view();
  }

  async createOrder(origin: string): Promise<DeskView> {
    if (this.phase !== "confirmed" || !this.policy || !this.cart || !this.approval) {
      throw new Error("Confirm the policy for this cart before creating a PayPal order.");
    }
    if (this.order) return this.view();
    const decision = enforce(this.policy, this.cart, this.approval);
    if (!decision.ok) return this.rejectCheckout(decision);
    return this.occupy(async () => {
      const base = (this.configuredBase ?? origin).replace(/\/$/, "");
      const customId = policyCustomId(this.policy!, this.cart!);
      try {
        const order = await this.paypal.createOrder(
          {
            amount: this.cart!.amount,
            currency: "USD",
            description: this.cart!.description,
            customId,
            invoiceId: invoiceId(),
            requestId: randomUUID(),
            returnUrl: `${base}/paypal/return`,
            cancelUrl: `${base}/paypal/cancel`,
          },
          { onRetry: (notice) => this.noteRetry("create_retry", notice) },
        );
        this.order = order;
        this.phase = "awaiting_buyer";
        this.warning = null;
        this.narrative = narrateOrderCreated(this.paypal.mode, order, this.cart!);
        this.audit.record({
          at: new Date().toISOString(),
          event: "order_created",
          orderId: order.id,
          customId: order.customId,
          policy: this.snapshot(),
          detail: this.narrative,
        });
      } catch (error) {
        this.notePayPalError(error);
      }
      return this.view();
    });
  }

  async refreshApproval(): Promise<DeskView> {
    if (!this.order) throw new Error("Create an order before checking approval.");
    if (this.phase === "cancelled" || this.phase === "completed" || this.phase === "declined") return this.view();
    return this.occupy(async () => {
      try {
        await this.pullOrder();
      } catch (error) {
        this.notePayPalError(error);
      }
      return this.view();
    });
  }

  async capture(): Promise<DeskView> {
    if (!this.order) throw new Error("Create an order before capture.");
    if (this.phase === "completed") return this.view();
    if (this.phase !== "approved") {
      throw new Error("Capture waits until the buyer approval is recorded.");
    }
    return this.occupy(async () => {
      try {
        const captured = await this.paypal.captureOrder(this.order!.id, randomUUID(), {
          negativeTest: this.scenario?.id === "declined" ? "instrument_declined" : null,
          onRetry: (notice) => this.noteRetry("capture_retry", notice),
        });
        this.order = captured;
        this.phase = "completed";
        this.warning = null;
        this.narrative = narrateCaptured(this.paypal.mode, captured);
        this.audit.record({
          at: new Date().toISOString(),
          event: "captured",
          orderId: captured.id,
          customId: captured.customId,
          policy: this.snapshot(),
          detail: this.narrative,
        });
      } catch (error) {
        if (error instanceof PayPalApiError && error.issue === "INSTRUMENT_DECLINED") {
          this.phase = "declined";
          this.warning = null;
          this.narrative = narrateDeclined(this.paypal.mode, this.order!.id);
          this.audit.record({
            at: new Date().toISOString(),
            event: "declined",
            orderId: this.order!.id,
            customId: this.order!.customId,
            policy: this.snapshot(),
            detail: this.narrative,
          });
        } else if (error instanceof PayPalApiError && error.issue === "ORDER_ALREADY_CAPTURED") {
          await this.pullOrder();
        } else {
          this.notePayPalError(error);
        }
      }
      return this.view();
    });
  }

  cancel(): DeskView {
    if (!this.order || (this.phase !== "awaiting_buyer" && this.phase !== "approved")) {
      throw new Error("There is no open checkout to cancel.");
    }
    if (supportsLocalApproval(this.paypal)) {
      this.order = this.paypal.markCancelled(this.order.id);
    }
    this.phase = "cancelled";
    this.warning = null;
    this.narrative = narrateCancelled(this.paypal.mode, this.order.id);
    this.audit.record({
      at: new Date().toISOString(),
      event: "cancelled",
      orderId: this.order.id,
      customId: this.order.customId,
      policy: this.snapshot(),
      detail: this.narrative,
    });
    return this.view();
  }

  approveMock(token?: string): DeskView {
    if (!supportsLocalApproval(this.paypal)) {
      throw new Error("Buyer approval in the sandbox happens on PayPal. Open the approval link and sign in as the US Personal test buyer, then check approval.");
    }
    if (!this.order || this.phase !== "awaiting_buyer") {
      throw new Error("There is no order waiting for buyer approval.");
    }
    if (token && token !== this.order.id) throw new Error("That approval link does not match the open order.");
    this.order = this.paypal.markBuyerApproved(this.order.id);
    this.phase = "approved";
    this.warning = null;
    this.narrative = narrateApproved(this.paypal.mode, this.order.id);
    this.audit.record({
      at: new Date().toISOString(),
      event: "buyer_approved",
      orderId: this.order.id,
      customId: this.order.customId,
      policy: this.snapshot(),
      detail: this.narrative,
    });
    return this.view();
  }

  async noteReturn(token: string): Promise<DeskView> {
    if (!this.order || token !== this.order.id) {
      throw new Error("That return link does not match the open order.");
    }
    if (this.phase === "cancelled" || this.phase === "completed" || this.phase === "declined") return this.view();
    return this.refreshApproval();
  }

  noteCancel(token: string): DeskView {
    if (!this.order || token !== this.order.id) {
      throw new Error("That cancel link does not match the open order.");
    }
    if (this.phase === "completed" || this.phase === "declined") {
      throw new Error("This checkout is already finished.");
    }
    if (this.phase === "cancelled") return this.view();
    return this.cancel();
  }

  private rejectCheckout(decision: Decision): DeskView {
    this.phase = !decision.ok && decision.code === "reapproval_required" ? "reapproval" : "rejected";
    this.narrative = narrateDecision(decision);
    this.audit.record({
      at: new Date().toISOString(),
      event: !decision.ok && decision.code === "reapproval_required" ? "reapproval_required" : "checkout_rejected",
      policy: this.snapshot(),
      detail: this.narrative,
    });
    return this.view();
  }

  private async pullOrder(): Promise<void> {
    const latest = await this.paypal.getOrder(this.order!.id, {
      onRetry: (notice) => this.noteRetry("read_retry", notice),
    });
    this.applyRemote(latest);
  }

  private applyRemote(latest: CheckoutOrder): void {
    const previous = this.phase;
    this.order = latest;
    this.warning = null;
    if (latest.status === "APPROVED") {
      this.phase = "approved";
      this.narrative = narrateApproved(this.paypal.mode, latest.id);
      if (previous !== "approved") {
        this.audit.record({
          at: new Date().toISOString(),
          event: "buyer_approved",
          orderId: latest.id,
          customId: latest.customId,
          policy: this.snapshot(),
          detail: this.narrative,
        });
      }
      return;
    }
    if (latest.status === "COMPLETED") {
      this.phase = "completed";
      this.narrative = narrateCaptured(this.paypal.mode, latest);
      if (previous !== "completed") {
        this.audit.record({
          at: new Date().toISOString(),
          event: "captured",
          orderId: latest.id,
          customId: latest.customId,
          policy: this.snapshot(),
          detail: this.narrative,
        });
      }
      return;
    }
    if (latest.status === "VOIDED") {
      this.phase = "cancelled";
      this.narrative = narrateCancelled(this.paypal.mode, latest.id);
      if (previous !== "cancelled") {
        this.audit.record({
          at: new Date().toISOString(),
          event: "cancelled",
          orderId: latest.id,
          customId: latest.customId,
          policy: this.snapshot(),
          detail: this.narrative,
        });
      }
      return;
    }
    this.phase = "awaiting_buyer";
    this.narrative = narrateAwaiting(this.paypal.mode, latest, this.cart!);
  }

  private async draftPolicy(intent: string, cart: Cart): Promise<{ policy: PurchasePolicy; note: string | null }> {
    let raw: unknown | null = null;
    let note: string | null = null;
    try {
      raw = await this.planner.proposePolicy({ mandate: MANDATE, cart, intent });
    } catch {
      note = "The model request failed, so the coded fallback drafted the policy.";
    }
    if (raw == null && !note) note = "The model did not return policy JSON, so the coded fallback drafted the policy.";
    const validated = raw ? validateProposal(raw, MANDATE) : { ok: false as const, errors: ["No policy JSON."] };
    if (validated.ok) return { policy: validated.policy, note: null };
    if (!note) {
      note = `The model draft was rejected by the policy validator (${validated.errors.join("; ")}). The coded fallback drafted the policy.`;
    }
    const fallback = validateProposal(deterministicProposal(cart, MANDATE), MANDATE);
    if (!fallback.ok) throw new Error(fallback.errors.join(" "));
    return { policy: fallback.policy, note };
  }

  private noteRetry(event: "create_retry" | "capture_retry" | "read_retry", notice: RetryNotice): void {
    const detail = narrateRetry(notice.status, notice.failedAttempt, notice.maxAttempts);
    this.narrative = detail;
    this.audit.record({
      at: new Date().toISOString(),
      event,
      orderId: this.order?.id,
      customId: this.order?.customId,
      policy: this.snapshot(),
      detail,
    });
  }

  private notePayPalError(error: unknown): void {
    const detail = error instanceof Error ? error.message : "PayPal request failed.";
    this.warning = detail;
    this.narrative = detail;
    this.audit.record({
      at: new Date().toISOString(),
      event: "paypal_error",
      orderId: this.order?.id,
      customId: this.order?.customId,
      policy: this.snapshot(),
      detail,
    });
  }

  private snapshot(): PolicySnapshot | undefined {
    if (!this.policy || !this.cart) return undefined;
    return {
      budgetCap: this.policy.budgetCap.amount,
      currency: "USD",
      merchantAllowlist: [...this.policy.merchantAllowlist],
      purchaseKind: "one_time",
      reapproval: { onAmountChange: true, onMerchantChange: true },
      cartMerchant: this.cart.merchant,
      cartAmount: this.cart.amount,
      intentSummary: this.policy.intentSummary,
    };
  }

  private async occupy<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("A checkout step is already running.");
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
}

export function policyCustomId(policy: PurchasePolicy, cart: Cart): string {
  const canonical = JSON.stringify({
    cap: policy.budgetCap.amount,
    merchants: [...policy.merchantAllowlist].sort(),
    kind: policy.purchaseKind,
    merchant: cart.merchant,
    amount: cart.amount,
  });
  return `pol_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

export function invoiceId(): string {
  return `acs${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}
