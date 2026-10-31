const state = { view: null, error: "", fingerprint: "" };
let poll = null;

document.getElementById("scenario-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-scenario]");
  if (!button || button.disabled) return;
  post(`/api/scenarios/${button.dataset.scenario}/draft`);
});

document.getElementById("reset").addEventListener("click", () => post("/api/reset"));

document.querySelector("main").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  const routes = {
    confirm: "/api/confirm",
    revise: "/api/revise",
    create: "/api/order",
    refresh: "/api/refresh",
    capture: "/api/capture",
    cancel: "/api/cancel",
    approve: "/api/approve",
  };
  if (routes[action]) post(routes[action]);
});

load();

async function load() {
  const response = await fetch("/api/state");
  render(await response.json());
}

async function post(url, quiet) {
  if (!quiet) state.error = "";
  const response = await fetch(url, { method: "POST" });
  const body = await response.json();
  if (!response.ok) {
    state.error = body.error || "Request failed";
    if (state.view) render(state.view, true);
    return;
  }
  state.error = "";
  render(body);
}

function render(view, force) {
  const next = JSON.stringify({
    phase: view.phase,
    narrative: view.narrative,
    warning: view.warning,
    error: state.error,
    order: view.order,
    audit: view.audit.length,
    gates: view.gates,
    policy: view.policy,
    validatorNote: view.validatorNote,
  });
  state.view = view;
  if (!force && next === state.fingerprint) return;
  state.fingerprint = next;
  syncPoll(view);

  document.getElementById("mode-badge").textContent = view.mode === "sandbox" ? "PayPal sandbox" : "Mock ledger";
  document.getElementById("planner-badge").textContent = view.planner.label;

  const list = document.getElementById("scenario-list");
  list.innerHTML = view.scenarios
    .map(
      (item) =>
        `<li><button type="button" data-scenario="${esc(item.id)}" class="${item.id === view.activeScenarioId ? "active" : ""}"><strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></button></li>`,
    )
    .join("");

  const stop =
    view.phase === "rejected" ? 2 : view.phase === "cancelled" ? 3 : view.phase === "declined" ? 4 : -1;
  const current = currentStep(view.phase);
  const steps = ["Draft", "Confirm", "Order", "Approve", "Capture"]
    .map((label, index) => {
      const cls = index === stop ? "stop" : view.phase === "completed" || index < current ? "done" : index === current ? "current" : "wait";
      return `<li class="${cls}">${label}</li>`;
    })
    .join("");

  document.getElementById("story").innerHTML = `
    <h2>Status</h2>
    <ol class="steps">${steps}</ol>
    <p class="story">${esc(view.narrative)}</p>
    ${view.hint ? `<p class="note">${esc(view.hint)}</p>` : ""}
    ${view.validatorNote ? `<p class="note">${esc(view.validatorNote)}</p>` : ""}
    ${view.warning ? `<p class="warning">${esc(view.warning)}</p>` : ""}
    ${state.error ? `<p class="warning">${esc(state.error)}</p>` : ""}`;

  document.getElementById("checkout").innerHTML = checkoutHtml(view);

  const rules = view.policy
    ? [
        `Budget cap USD ${view.policy.budgetCap.amount}`,
        `Merchants: ${view.policy.merchantAllowlist.join(", ")}`,
        "One-time purchase",
        "New approval if the amount or the merchant changes",
      ]
    : [
        `Operator cap USD ${view.mandate.budgetCap}`,
        `Allowlist: ${view.mandate.merchantAllowlist.join(", ")}`,
        "One-time purchases only",
        "Re-approval stays on",
      ];
  document.getElementById("policy-panel").innerHTML = `
    <div class="panel-head">
      <h2>${view.policy ? "Accepted policy" : "Operator mandate"}</h2>
      <p>${view.policy ? "The validator kept this JSON." : "The model has to fit inside these limits."}</p>
    </div>
    <ul class="policy-list">${rules.map((rule) => `<li>${esc(rule)}</li>`).join("")}</ul>
    ${view.policy ? `<pre class="json">${esc(JSON.stringify(view.policy, null, 2))}</pre>` : ""}`;

  const audit = document.getElementById("audit");
  audit.innerHTML = view.audit.length
    ? view.audit
        .map(
          (event) =>
            `<li><time>${esc(event.at)}</time><strong>${esc(event.event)}</strong><div>${esc(event.detail)}</div>${
              event.orderId ? `<div class="meta">Order ${esc(event.orderId)}</div>` : ""
            }</li>`,
        )
        .join("")
    : `<li class="muted">No events yet.</li>`;
}

function checkoutHtml(view) {
  const cart = view.cart
    ? `<p class="cart-line"><strong>${esc(view.cart.merchant)}</strong> · USD ${esc(view.cart.amount)} · ${esc(view.cart.description)}</p>`
    : `<p class="muted">Pick a purchase to draft a policy.</p>`;
  const buttons = [];
  if (view.gates.canConfirm) {
    buttons.push(`<button type="button" class="primary" data-action="confirm">${view.phase === "reapproval" ? "Approve the new cart" : "Confirm policy"}</button>`);
  }
  if (view.gates.canRevise) {
    buttons.push(`<button type="button" data-action="revise">Apply supplier revision (${esc(view.revisionLabel)})</button>`);
  }
  if (view.gates.canCreate) {
    buttons.push(`<button type="button" class="primary" data-action="create">Create PayPal order</button>`);
  }
  if (view.gates.canSimulate) {
    buttons.push(`<button type="button" data-action="approve">Simulate buyer approval</button>`);
  }
  if (view.gates.canRefresh) {
    buttons.push(`<button type="button" data-action="refresh">Check approval</button>`);
  }
  if (view.phase === "approved" || view.phase === "awaiting_buyer" || view.phase === "declined") {
    buttons.push(`<button type="button" class="primary" data-action="capture" ${view.gates.canCapture ? "" : "disabled"}>Capture payment</button>`);
  }
  if (view.gates.canCancel) {
    buttons.push(`<button type="button" data-action="cancel">Cancel checkout</button>`);
  }
  const approval = view.approval
    ? `<div class="approve">
        <h3>Buyer approval</h3>
        <p>${esc(view.approval.instructions)}</p>
        ${
          view.approval.url
            ? `<a class="primary" href="${esc(view.approval.url)}" target="_blank" rel="noopener noreferrer">${esc(view.approval.linkLabel)}</a>
               <label class="url"><span>Approval link</span><input readonly value="${esc(view.approval.url)}" /></label>`
            : `<p class="warning">PayPal did not return an approval link for this order.</p>`
        }
      </div>`
    : "";
  const facts = view.order
    ? `<div class="facts">
        <div>Order <b>${esc(view.order.id)}</b></div>
        <div>PayPal status <b>${esc(view.order.status)}</b></div>
        <div>Amount <b>USD ${esc(view.order.amount.value)}</b></div>
        <div>Capture <b>${esc(view.order.captureId || "—")} ${esc(view.order.captureStatus || "")}</b></div>
      </div>`
    : "";
  return `<h2>Checkout</h2>${cart}${facts}${approval}${buttons.length ? `<div class="row-actions">${buttons.join("")}</div>` : ""}`;
}

function currentStep(phase) {
  switch (phase) {
    case "draft_ready":
      return 0;
    case "reapproval":
      return 1;
    case "confirmed":
    case "rejected":
      return 2;
    case "awaiting_buyer":
    case "cancelled":
      return 3;
    case "approved":
    case "declined":
      return 4;
    case "completed":
      return 5;
    default:
      return -1;
  }
}

function syncPoll(view) {
  if (poll) clearInterval(poll);
  poll = null;
  if (view.phase === "awaiting_buyer") {
    poll = setInterval(() => post("/api/refresh", true), 3000);
  }
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}
