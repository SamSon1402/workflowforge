import Anthropic from '@anthropic-ai/sdk';
import { WorkflowSpec, type WorkflowSpec as WorkflowSpecType } from './types';

/**
 * The compiler turns a finance operator's natural language description
 * into a validated WorkflowSpec. We use Claude as the parser and then
 * strictly Zod-validate the output before persisting anything.
 *
 * The system prompt acts as the language specification — it tells the
 * model exactly which activity names exist, the node grammar, and the
 * output JSON shape. Validation is the safety net: if the model ever
 * drifts, the request fails with a 422 instead of writing a malformed
 * spec to the DB.
 */

const anthropic = new Anthropic();

const COMPILER_SYSTEM_PROMPT = `You are WorkflowForge's compiler. Convert finance-ops natural-language descriptions into a deterministic workflow DAG.

OUTPUT FORMAT — return ONE JSON object, no markdown, no commentary:
{
  "name": "snake_case_workflow_name",
  "description": "one-line summary",
  "nodes": [...],
  "edges": [{ "from": "node_id", "to": "node_id", "when"?: "true" | "false" | "always" }],
  "audit": true
}

NODE TYPES:
- trigger     entry point. config.kind = "cron" (cron + tz) | "event" (name) | "relative" (relativeTo + offset)
- activity    side-effect. activity name from CATALOGUE below. args is a JSON object.
- decision    branch. condition is an expression like "balance > 100000" or "exposure_usd > 500000".
              Decisions MUST emit two edges, one with when="true" and one with when="false".
- approval    human-in-the-loop. approverRole in {"CFO","Treasurer","Head_of_Finance","Controller"}. slaHours optional.

ACTIVITY CATALOGUE:
- banks.aggregate                 fetch balances across all connected accounts
- banks.transfer                  move funds between accounts. args: { fromAccountId, toAccountId, amount, currency }
- insignis.deposit                send GBP to BlackRock MMF via Insignis. args: { amount }
- insignis.withdraw               pull GBP from MMF. args: { amount }
- payroll.estimate                compute next payroll total
- payments.sepa_batch             send a SEPA Faster Payments batch. args: { source: "ap_approved" | string }
- fx.quote                        quote an FX forward. args: { pair, tenor }
- fx.book_forward                 book the quoted forward. args: { quoteId }
- slack.dm                        Slack DM. args: { user, message }
- slack.channel                   Slack channel post. args: { channel, message }
- email.send                      send email. args: { to, subject, body }

RULES:
- Workflow must be a DAG; no cycles.
- Every non-trigger node must have at least one incoming edge.
- Node ids are snake_case starting with a letter.
- Do NOT invent activity names. If the user asks for something outside the catalogue, prefix it with "custom." and the runtime will route to a fallback handler.
- Prefer adding an approval node whenever the user request involves moving > £100k OR using language like "approve", "review", "sign off", or naming a role.
`;

export class CompileError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CompileError';
  }
}

export async function compilePrompt(prompt: string): Promise<WorkflowSpecType> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    temperature: 0,                          // determinism in, determinism out
    system: COMPILER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = response.content[0];
  if (!block || block.type !== 'text') {
    throw new CompileError('compiler returned non-text response');
  }

  // Defensive: strip any stray markdown fences the model might emit
  const text = block.text.trim().replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CompileError('compiler returned invalid JSON', err);
  }

  const result = WorkflowSpec.safeParse(parsed);
  if (!result.success) {
    throw new CompileError(`spec validation failed: ${result.error.issues.map(i => i.message).join('; ')}`);
  }

  ensureAcyclic(result.data);
  return result.data;
}

/** DFS cycle check — Zod can validate shape but not graph structure. */
function ensureAcyclic(spec: WorkflowSpecType): void {
  const adj = new Map<string, string[]>();
  for (const n of spec.nodes) adj.set(n.id, []);
  for (const e of spec.edges) adj.get(e.from)?.push(e.to);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(spec.nodes.map(n => [n.id, WHITE]));

  function visit(id: string): void {
    color.set(id, GRAY);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next);
      if (c === GRAY) throw new CompileError(`workflow contains a cycle through ${next}`);
      if (c === WHITE) visit(next);
    }
    color.set(id, BLACK);
  }

  for (const n of spec.nodes) {
    if (color.get(n.id) === WHITE) visit(n.id);
  }
}
