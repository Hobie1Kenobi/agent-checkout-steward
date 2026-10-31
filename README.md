# Agent Checkout Steward

An operator asks an agent to buy something. The agent drafts a purchase policy. Application code accepts that policy only when it stays inside a hard mandate, then PayPal sandbox takes the payment. A model cannot raise the cap, add a merchant, switch the purchase to a subscription, or waive a second approval.

This is a PayPal AI Hackathon 2026 project. It moves sandbox money only. It is not a PayPal product and there is no partnership.

## Problem

An agent that can check out needs a budget, a merchant list, and a stop when the cart changes. Those limits have to live in code. A prompt can suggest them. It cannot be the thing that enforces them.

The mandate in this demo is fixed:

- Budget cap **USD 150.00**
- Merchants **Harbor & Co** and **Northline Supply**
- **One-time** purchases
- A new approval if the **amount** or the **merchant** changes

## How PayPal is used

PayPal is the payment rail. The client speaks Orders v2 on `https://api-m.sandbox.paypal.com`:

1. `POST /v1/oauth2/token` with `grant_type=client_credentials` and HTTP Basic auth (`PAYPAL_CLIENT_ID:PAYPAL_CLIENT_SECRET`).
2. `POST /v2/checkout/orders` with `intent: "CAPTURE"`, a USD amount with two decimals, `custom_id` (a policy hash, not a person), `invoice_id`, and `payment_source.paypal.experience_context` (`PAY_NOW`, `LOGIN`, `NO_SHIPPING`, return and cancel URLs). The call sends `PayPal-Request-Id` and `Prefer: return=representation`. HTTP 200 and 201 are both success.
3. The buyer opens the HATEOAS approval link (`payer-action`, otherwise `approve`). For this sandbox that is `https://www.sandbox.paypal.com/checkoutnow?token=ORDER_ID`. If PayPal omits the link, the client uses that same checkout URL.
4. `GET /v2/checkout/orders/{id}` until the status is `APPROVED`.
5. `POST /v2/checkout/orders/{id}/capture`.

Live hosts (`api-m.paypal.com`, `api.paypal.com`) are rejected before a request is sent. Transient HTTP 429 and 5xx responses are retried up to three times with the same `PayPal-Request-Id`. The declined-payment scenario sends PayPal's sandbox negative-test header `PayPal-Mock-Response: {"mock_application_codes":"INSTRUMENT_DECLINED"}` on capture.

`custom_id` is a hash of the confirmed policy and cart. The audit log stores the PayPal order id next to that policy snapshot. Card numbers, access tokens, and payer ids are not written.

## How AI is used

The planner asks the configured model for policy JSON only: budget cap, merchant allowlist, `purchaseKind: "one_time"`, both re-approval flags, and a one-sentence summary. `validateProposal` accepts the JSON when it fits the mandate. A draft that fails validation is discarded and the deterministic fallback drafts a valid policy.

Status sentences are written from the coded outcome (allowed, over cap, off-list merchant, re-approval, created, approved, captured, cancelled, declined, retry). The model does not get to describe a rejected cart as paid.

With no model key, `LLM_PROVIDER=auto` uses the deterministic fallback, so the desk and the demo run without an AI account.

| `LLM_PROVIDER` | Behavior |
| --- | --- |
| `auto` | Anthropic if `ANTHROPIC_API_KEY` is set, otherwise OpenAI-compatible if `OPENAI_BASE_URL` is set, otherwise the fallback |
| `anthropic` | Anthropic Messages API |
| `openai` | `POST {OPENAI_BASE_URL}/chat/completions` (Ollama works) |
| `none` | Deterministic fallback |

## Architecture

```mermaid
flowchart TD
  operator[Operator]
  desk[Checkout desk]
  planner[Policy planner]
  validator[Policy validator]
  enforcer[Checkout enforcer]
  paypal[PayPal Orders v2 sandbox]
  audit[Audit log]
  operator --> desk
  desk --> planner
  planner -->|policy JSON| validator
  validator --> enforcer
  enforcer -->|cart allowed| paypal
  enforcer --> audit
  paypal --> audit
  paypal -->|approval link| operator
```

Mock mode uses the same session and the same enforcer. The mock client never opens a socket to PayPal.

## Honesty

- No API keys, client ids, or secrets belong in this repo, in screenshots, or in the audit log.
- Sandbox credentials stay in `.env`, which is gitignored.
- The payment rail is PayPal sandbox. There is no production traffic and no claim of a PayPal partnership.
- XRPL is not used.

## Mock mode

Node.js 22.

```bash
npm ci
npm test
npm run typecheck
npm run demo
npm run demo:errors
npm run serve
```

Open http://127.0.0.1:4320 . `npm run demo` forces mock mode so a shell that already has sandbox credentials does not create an order. The desk follows `CHECKOUT_MODE`.

`auto` (the default) uses the sandbox when both `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are non-empty, and mock otherwise.

The desk purchases:

| Purchase | What the code does |
| --- | --- |
| Sensor, within cap | Harbor & Co, USD 86.00. Draft, confirm, create, approve, capture. |
| Over the budget cap | USD 240.00. Create is refused. PayPal is not called. |
| Merchant not allowed | Night Market LLC. Create is refused. |
| Amount changes | Confirm USD 86.00, apply the USD 110.00 revision, approve again, then create. |
| Buyer cancels | Cancel after create. Capture is not requested. |
| Payment declined | Capture returns a declined instrument. |

In mock mode the approval page is local and labeled simulated.

## Sandbox mode

Create a sandbox REST app at https://developer.paypal.com/dashboard/applications/sandbox . Copy `.env.example` to `.env` and set:

```bash
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_API_BASE=https://api-m.sandbox.paypal.com
```

Leave the values out of git. Then:

```bash
npm run serve
```

The badge reads **PayPal sandbox**. Run the sensor purchase:

1. Draft the policy and confirm it.
2. Press **Create PayPal order**.
3. Press **Open PayPal approval** (or copy the approval link). A sandbox checkout tab opens.
4. Sign in as the **US Personal** test buyer. The email and system-generated password are under PayPal Developer Dashboard → Testing Tools → Sandbox Accounts. This is not a live PayPal login.
5. Approve the payment. PayPal redirects the browser to `/paypal/return` on this desk. The desk also checks the order every few seconds.
6. When the status is `APPROVED`, press **Capture payment**.

The same create-and-print-the-link path from a terminal:

```bash
npm run demo:sandbox
npm run capture -- ORDER_ID
```

`demo:sandbox` confirms the USD 86.00 sensor policy, creates one sandbox order, and stops before capture. `npm run capture -- ORDER_ID` loads that order, refuses to capture until PayPal reports `APPROVED`, then captures.

For the declined scenario, capture sends PayPal's negative-test header. Cancel uses the desk button or PayPal's cancel redirect. Orders v2 has no separate merchant cancel call; an uncaptured order is left to expire, and capture is not requested.

If create-order rejects the return URL, set `CHECKOUT_PUBLIC_BASE` to an https origin that reaches this desk. Approval still works from the link when the return URL is only a browser redirect.

## Audit log

The desk appends JSON lines to `data/audit.jsonl` (gitignored). Each checkout line has the event, the PayPal order id when one exists, `custom_id`, and the policy snapshot (cap, allowlist, one-time, re-approval flags, cart merchant, cart amount). Reset clears the on-screen list and appends a reset line. The file is not a place for tokens or payer data; the writer drops those fields.

## Tests

```bash
npm test
npm run typecheck
```

`npm test` covers the mandate validator, the enforcer (over cap, off-list merchant, amount change, merchant change, subscription), the deterministic and Anthropic planners with a fake fetch, the Orders v2 request shape (OAuth, create, approve link, capture retry, declined instrument, live-host refusal), the mock session, and the desk HTTP API. Nothing in the test suite calls `api-m.sandbox.paypal.com`.

## What still needs a live sandbox run

This environment does not have the sandbox credentials, so approval and capture have not been executed against PayPal from here. The client matches the Orders v2 calls above and is ready for that check. With `.env` filled in, still confirm on a machine that has the credentials:

- OAuth and `POST /v2/checkout/orders` succeed, and the response includes an approval link on `www.sandbox.paypal.com`.
- The US Personal buyer can open that link, sign in, and approve.
- `GET /v2/checkout/orders/{id}` then shows `APPROVED`, and capture returns `COMPLETED` with a capture id.
- The return URL on `http://127.0.0.1:4320/paypal/return` is accepted. If it is not, set `CHECKOUT_PUBLIC_BASE`.
- The declined scenario's negative-test header returns `INSTRUMENT_DECLINED` and the desk explains it.
- The audit line for the live order contains the order id and the policy snapshot, and does not contain the client secret or the access token.
