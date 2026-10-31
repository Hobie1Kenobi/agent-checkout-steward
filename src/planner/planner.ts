import type { Cart, Mandate } from "../policy/mandate";

export interface PolicyPrompt {
  mandate: Mandate;
  cart: Cart;
  intent: string;
}

export interface Planner {
  readonly id: string;
  readonly label: string;
  proposePolicy(input: PolicyPrompt): Promise<unknown | null>;
}

export class DeterministicPlanner implements Planner {
  readonly id = "deterministic";
  readonly label = "Deterministic fallback (no model call)";

  async proposePolicy(input: PolicyPrompt): Promise<unknown> {
    return {
      budgetCap: { currency: "USD", amount: input.mandate.budgetCap },
      merchantAllowlist: [...input.mandate.merchantAllowlist],
      purchaseKind: "one_time",
      reapproval: { onAmountChange: true, onMerchantChange: true },
      intentSummary: `One-time purchase of ${input.cart.description} from ${input.cart.merchant} for USD ${input.cart.amount}.`,
    };
  }
}

export function createPlanner(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = globalThis.fetch): Planner {
  const choice = (env.LLM_PROVIDER ?? "auto").trim().toLowerCase();
  if (choice === "none" || choice === "deterministic") return new DeterministicPlanner();
  if (choice === "anthropic") return new AnthropicPlanner(env, fetchImpl);
  if (choice === "openai") return new OpenAiCompatiblePlanner(env, fetchImpl);
  if (choice !== "auto") {
    throw new Error(`Unknown LLM_PROVIDER "${choice}". Use auto, anthropic, openai, or none.`);
  }
  if ((env.ANTHROPIC_API_KEY ?? "").trim()) return new AnthropicPlanner(env, fetchImpl);
  if ((env.OPENAI_BASE_URL ?? "").trim()) return new OpenAiCompatiblePlanner(env, fetchImpl);
  return new DeterministicPlanner();
}

export function parsePolicyJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced?.[1] ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(source.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export function policyPrompt(input: PolicyPrompt): string {
  return [
    "You draft a purchase policy. Application code accepts or rejects it. You do not approve payment and you do not call PayPal.",
    "Return JSON only, with this shape:",
    '{"budgetCap":{"currency":"USD","amount":"150.00"},"merchantAllowlist":["Harbor & Co"],"purchaseKind":"one_time","reapproval":{"onAmountChange":true,"onMerchantChange":true},"intentSummary":"one sentence"}',
    "Rules the validator enforces:",
    `- currency is USD and amount is at most ${input.mandate.budgetCap} with two decimals.`,
    `- merchantAllowlist is a non-empty subset of: ${input.mandate.merchantAllowlist.join(", ")}.`,
    "- purchaseKind is one_time.",
    "- both reapproval flags are true. A false flag is discarded.",
    "- intentSummary is one sentence, at most 280 characters, with no card numbers, emails, or secrets.",
    `Operator intent: ${input.intent.slice(0, 500)}`,
    `Cart merchant: ${input.cart.merchant}`,
    `Cart amount: USD ${input.cart.amount}`,
    `Cart description: ${input.cart.description}`,
  ].join("\n");
}

class AnthropicPlanner implements Planner {
  readonly id = "anthropic";
  readonly label: string;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.label = `Anthropic (${env.ANTHROPIC_MODEL || "claude-sonnet-4-5"})`;
  }

  async proposePolicy(input: PolicyPrompt): Promise<unknown | null> {
    const key = (this.env.ANTHROPIC_API_KEY ?? "").trim();
    if (!key) return null;
    const response = await this.fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
        max_tokens: 700,
        messages: [{ role: "user", content: policyPrompt(input) }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic request failed (${response.status}).`);
    const body = (await response.json()) as { content?: Array<{ text?: string }> };
    const text = (body.content ?? []).map((block) => block.text ?? "").join("\n");
    return parsePolicyJson(text);
  }
}

class OpenAiCompatiblePlanner implements Planner {
  readonly id = "openai";
  readonly label: string;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.label = `OpenAI-compatible (${env.OPENAI_MODEL || "llama3.1"})`;
  }

  async proposePolicy(input: PolicyPrompt): Promise<unknown | null> {
    const base = (this.env.OPENAI_BASE_URL ?? "").trim().replace(/\/$/, "");
    if (!base) return null;
    const headers: Record<string, string> = { "content-type": "application/json" };
    const apiKey = (this.env.OPENAI_API_KEY ?? "").trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await this.fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.env.OPENAI_MODEL || "llama3.1",
        temperature: 0,
        messages: [
          { role: "system", content: "You draft purchase policy JSON. Return JSON only." },
          { role: "user", content: policyPrompt(input) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI-compatible request failed (${response.status}).`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parsePolicyJson(body.choices?.[0]?.message?.content ?? "");
  }
}
