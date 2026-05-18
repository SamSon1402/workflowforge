import { z } from 'zod';

/**
 * WorkflowForge DSL — the intermediate representation produced by the
 * NL compiler and consumed by the Temporal workflow interpreter.
 *
 * Design choices:
 *   - A workflow is a DAG of typed nodes (trigger / activity / decision / approval).
 *   - All side effects happen in `activity` nodes; the workflow interpreter
 *     stays deterministic and can be safely replayed by Temporal.
 *   - Validation lives at the compile boundary — by the time a spec hits
 *     the worker we trust it has shape.
 */

const TriggerConfig = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cron'),
    cron: z.string(),                      // standard 5-field cron
    tz: z.string().default('UTC'),
  }),
  z.object({
    kind: z.literal('event'),
    event: z.string(),                     // e.g. "balance.changed"
  }),
  z.object({
    kind: z.literal('relative'),
    relativeTo: z.string(),                // e.g. "payroll_date"
    offset: z.string(),                    // e.g. "-3 business_days"
  }),
]);

const RetryPolicy = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoff: z.enum(['linear', 'exponential']).default('exponential'),
});

export const NodeSpec = z.discriminatedUnion('type', [
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'node id must be snake_case'),
    type: z.literal('trigger'),
    label: z.string(),
    config: TriggerConfig,
  }),
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    type: z.literal('activity'),
    label: z.string(),
    activity: z.string(),                  // catalogued activity name, e.g. "banks.aggregate"
    args: z.record(z.unknown()).default({}),
    timeoutSeconds: z.number().int().positive().default(30),
    retry: RetryPolicy.default({}),
  }),
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    type: z.literal('decision'),
    label: z.string(),
    condition: z.string(),                 // simple expression DSL, see compiler.ts
  }),
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    type: z.literal('approval'),
    label: z.string(),
    approverRole: z.string(),              // e.g. "CFO", "Treasurer", "Head_of_Finance"
    slaHours: z.number().positive().default(4),
  }),
]);

export type NodeSpec = z.infer<typeof NodeSpec>;

export const Edge = z.object({
  from: z.string(),
  to: z.string(),
  when: z.enum(['always', 'true', 'false']).default('always'),
});
export type Edge = z.infer<typeof Edge>;

export const WorkflowSpec = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().optional(),
  nodes: z.array(NodeSpec).min(2),
  edges: z.array(Edge),
  audit: z.boolean().default(true),
}).superRefine((spec, ctx) => {
  // Exactly one trigger
  const triggers = spec.nodes.filter(n => n.type === 'trigger');
  if (triggers.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `workflow must have exactly 1 trigger (found ${triggers.length})`,
    });
  }
  // All edges reference existing nodes
  const ids = new Set(spec.nodes.map(n => n.id));
  for (const e of spec.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `edge references unknown node: ${e.from} → ${e.to}`,
      });
    }
  }
});

export type WorkflowSpec = z.infer<typeof WorkflowSpec>;
