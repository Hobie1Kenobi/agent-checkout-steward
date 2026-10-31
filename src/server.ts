import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CheckoutSession } from "./checkout/session";
import { buildSession } from "./runtime";
import { listenPort, loadDotEnv } from "./env";

const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

export function createCheckoutServer(session: CheckoutSession): Server {
  const publicDir = path.join(__dirname, "..", "public");
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/health") {
        const runtime = { mode: session.view().mode, planner: session.view().planner.label };
        return sendJson(res, 200, { ok: true, paypal: "orders-v2", ...runtime });
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        return sendJson(res, 200, session.view());
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        return sendJson(res, 200, session.reset());
      }
      const draft = url.pathname.match(/^\/api\/scenarios\/([a-z0-9-]+)\/draft$/);
      if (req.method === "POST" && draft) {
        return sendJson(res, 200, await session.draft(draft[1]));
      }
      if (req.method === "POST" && url.pathname === "/api/confirm") {
        return sendJson(res, 200, session.confirm());
      }
      if (req.method === "POST" && url.pathname === "/api/revise") {
        return sendJson(res, 200, session.revise());
      }
      if (req.method === "POST" && url.pathname === "/api/order") {
        return sendJson(res, 200, await session.createOrder(requestOrigin(req)));
      }
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        return sendJson(res, 200, await session.refreshApproval());
      }
      if (req.method === "POST" && url.pathname === "/api/capture") {
        return sendJson(res, 200, await session.capture());
      }
      if (req.method === "POST" && url.pathname === "/api/cancel") {
        return sendJson(res, 200, session.cancel());
      }
      if (req.method === "POST" && url.pathname === "/api/approve") {
        return sendJson(res, 200, session.approveMock(url.searchParams.get("token") ?? undefined));
      }
      if (req.method === "GET" && url.pathname === "/paypal/return") {
        const view = await session.noteReturn(requiredToken(url));
        return sendHtml(res, 200, resultPage("Back from PayPal", view.narrative, view.phase === "approved"));
      }
      if (req.method === "GET" && url.pathname === "/paypal/cancel") {
        const view = session.noteCancel(requiredToken(url));
        return sendHtml(res, 200, resultPage("Checkout cancelled", view.narrative, false));
      }
      if (req.method === "GET" && url.pathname === "/mock/approve") {
        const token = requiredToken(url);
        const order = session.view().order;
        if (!order || order.id !== token) {
          return sendHtml(res, 404, resultPage("No matching order", "That simulated approval link does not match the open order.", false));
        }
        return sendHtml(res, 200, mockApprovePage(token, order.amount.value, session.view().cart?.merchant ?? ""));
      }
      const asset = FILES[url.pathname];
      if (req.method === "GET" && asset) {
        const body = await readFile(path.join(publicDir, asset.file));
        res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" });
        res.end(body);
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      const acceptsHtml = (req.headers.accept ?? "").includes("text/html");
      if (req.method === "GET" && acceptsHtml) {
        sendHtml(res, 400, resultPage("Checkout desk", message, false));
        return;
      }
      sendJson(res, 400, { error: message });
    }
  });
}

export function listen(session: CheckoutSession, port = 0, host = "127.0.0.1"): Promise<Server> {
  const server = createCheckoutServer(session);
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

export async function serve(): Promise<void> {
  loadDotEnv();
  const session = buildSession();
  const port = listenPort();
  const server = createCheckoutServer(session);
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  const view = session.view();
  console.log(`Checkout desk at http://127.0.0.1:${port} (${view.mode}, ${view.planner.label})`);
}

function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1:4320";
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded) || "http";
  return `${proto}://${host}`;
}

function requiredToken(url: URL): string {
  const token = url.searchParams.get("token") ?? "";
  if (!/^[A-Z0-9]+$/.test(token)) throw new Error("The PayPal return is missing an order id.");
  return token;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function resultPage(title: string, message: string, ready: boolean): string {
  const next = ready
    ? "Return to the checkout desk and press Capture payment."
    : "Return to the checkout desk.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="sheet">
    <p class="eyebrow">Agent Checkout Steward</p>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <p>${next}</p>
    <p><a class="primary" href="/">Back to the desk</a></p>
  </main>
</body>
</html>`;
}

function mockApprovePage(token: string, amount: string, merchant: string): string {
  const safeToken = encodeURIComponent(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Simulated buyer approval</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="sheet">
    <p class="eyebrow">Mock mode · not PayPal</p>
    <h1>Simulated buyer approval</h1>
    <p>This page stands in for the PayPal sandbox approval screen. No PayPal call is made.</p>
    <p><strong>${escapeHtml(merchant)}</strong> · USD ${escapeHtml(amount)} · order ${escapeHtml(token)}</p>
    <button type="button" class="primary" id="approve">Approve payment</button>
    <p id="result"></p>
    <p><a href="/">Back to the desk</a></p>
  </main>
  <script>
    document.getElementById("approve").addEventListener("click", async () => {
      const response = await fetch("/api/approve?token=${safeToken}", { method: "POST" });
      const body = await response.json();
      document.getElementById("result").textContent = response.ok
        ? "Approved. Return to the desk and press Capture payment."
        : (body.error || "Could not approve");
    });
  </script>
</body>
</html>`;
}
