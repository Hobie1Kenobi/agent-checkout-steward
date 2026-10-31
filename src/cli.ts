import { loadDotEnv, listenPort, publicBase, resolveMode } from "./env";
import { createPayPalClient } from "./paypal";
import { assertOrderId } from "./paypal/contract";
import { buildSession, describeRuntime } from "./runtime";
import { serve } from "./server";
import type { DeskView } from "./checkout/session";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "demo") {
    if (rest.includes("--errors") && rest.includes("--sandbox")) {
      throw new Error("The error-path demo runs in mock mode. Omit --sandbox.");
    }
    process.env.CHECKOUT_MODE = rest.includes("--sandbox") ? "sandbox" : "mock";
  }
  loadDotEnv();
  if (command === "serve") {
    await serve();
    return;
  }
  if (command === "demo") {
    await demo(rest.includes("--errors"), rest.includes("--sandbox"));
    return;
  }
  if (command === "capture") {
    await captureExisting(rest[0]);
    return;
  }
  console.log("Usage: tsx src/cli.ts demo [--errors | --sandbox] | tsx src/cli.ts serve | tsx src/cli.ts capture ORDER_ID");
  process.exitCode = 1;
}

async function demo(errors: boolean, sandbox: boolean): Promise<void> {
  const runtime = describeRuntime();
  console.log(`Agent Checkout Steward — ${runtime.mode} mode — ${runtime.planner}`);
  if (errors) {
    await runErrors();
    return;
  }
  if (sandbox) {
    await runSandboxOrder();
    return;
  }
  await runHappy();
}

async function runHappy(): Promise<void> {
  const session = buildSession();
  const origin = publicBase(process.env, listenPort());
  await session.draft("happy");
  session.confirm();
  await session.createOrder(origin);
  session.approveMock();
  const view = await session.capture();
  printView(view);
  if (view.phase !== "completed" || !view.order?.captureId) {
    throw new Error("Mock demo did not capture.");
  }
  console.log(`\nOrder ${view.order.id} captured (${view.order.captureId}).`);
}

async function runSandboxOrder(): Promise<void> {
  if (resolveMode() !== "sandbox") {
    throw new Error("Sandbox demo needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the environment or .env.");
  }
  const session = buildSession();
  const origin = publicBase(process.env, listenPort());
  await session.draft("happy");
  session.confirm();
  const view = await session.createOrder(origin);
  printView(view);
  if (view.phase !== "awaiting_buyer" || !view.order?.approveUrl) {
    throw new Error(view.warning ?? "PayPal did not return an order waiting for buyer approval.");
  }
  console.log(`\nOrder ${view.order.id}`);
  console.log(`Approve: ${view.order.approveUrl}`);
  console.log("Sign in as the sandbox US Personal buyer and approve the payment.");
  console.log(`Then capture with: npm run capture -- ${view.order.id}`);
  console.log("Or use the desk (npm run serve), press Check approval, then Capture payment.");
}

async function runErrors(): Promise<void> {
  const origin = publicBase(process.env, listenPort());
  await expectPhase(await overCap(origin), "rejected", "over cap");
  await expectPhase(await offList(origin), "rejected", "off list");
  await expectPhase(await amountChange(origin), "completed", "amount change");
  await expectPhase(await cancelled(origin), "cancelled", "cancel");
  await expectPhase(await declined(origin), "declined", "declined");
  console.log("Error paths finished in mock mode.");
}

async function overCap(origin: string): Promise<DeskView> {
  const session = buildSession();
  await session.draft("over-cap");
  session.confirm();
  return session.createOrder(origin);
}

async function offList(origin: string): Promise<DeskView> {
  const session = buildSession();
  await session.draft("off-list");
  session.confirm();
  return session.createOrder(origin);
}

async function amountChange(origin: string): Promise<DeskView> {
  const session = buildSession();
  await session.draft("amount-change");
  session.confirm();
  session.revise();
  const blocked = session.view();
  if (blocked.phase !== "reapproval") throw new Error("Amount change did not ask for a new approval.");
  session.confirm();
  await session.createOrder(origin);
  session.approveMock();
  return session.capture();
}

async function cancelled(origin: string): Promise<DeskView> {
  const session = buildSession();
  await session.draft("cancel");
  session.confirm();
  await session.createOrder(origin);
  return session.cancel();
}

async function declined(origin: string): Promise<DeskView> {
  const session = buildSession();
  await session.draft("declined");
  session.confirm();
  await session.createOrder(origin);
  session.approveMock();
  return session.capture();
}

async function expectPhase(view: DeskView, phase: DeskView["phase"], label: string): Promise<void> {
  console.log(`\n=== ${label} ===`);
  printView(view);
  if (view.phase !== phase) throw new Error(`${label} ended in ${view.phase}, expected ${phase}.`);
}

function printView(view: DeskView): void {
  console.log(view.narrative);
  if (view.warning) console.log(`Warning: ${view.warning}`);
  if (view.order) {
    console.log(`Order ${view.order.id} status ${view.order.status} capture ${view.order.captureId ?? "-"}`);
  }
}

async function captureExisting(orderId: string | undefined): Promise<void> {
  if (!orderId) throw new Error("Usage: tsx src/cli.ts capture ORDER_ID");
  const id = assertOrderId(orderId);
  const client = createPayPalClient();
  if (client.mode !== "sandbox") {
    throw new Error("CLI capture needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET. The mock demo captures inside npm run demo.");
  }
  const current = await client.getOrder(id);
  if (current.status === "COMPLETED") {
    console.log(`Order ${current.id} is already COMPLETED. Capture ${current.captureId ?? "-"}.`);
    return;
  }
  if (current.status !== "APPROVED") {
    console.log(`Order ${current.id} is ${current.status}.`);
    if (current.approveUrl) console.log(`Approve: ${current.approveUrl}`);
    throw new Error("Approve the order as the sandbox US Personal buyer, then capture again.");
  }
  const captured = await client.captureOrder(id, `cap-${id}`);
  console.log(`Captured order ${captured.id}. Capture ${captured.captureId ?? "-"} status ${captured.captureStatus ?? captured.status}.`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export { CheckoutSession } from "./checkout/session";
