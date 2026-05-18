import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  log,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import type { WorkflowSpec, NodeSpec, Edge } from '../../lib/types';

/**
 * The dynamic workflow interpreter.
 *
 * One Temporal workflow definition handles every WorkflowSpec — instead of
 * compiling the DSL to a separate workflow per spec, we interpret it at
 * runtime. This keeps workflow registration constant and makes the
 * "human types a prompt → workflow runs in production" loop tight.
 *
 * Determinism: this file uses NO Date.now(), Math.random(), file I/O, or
 * other non-deterministic APIs. Everything mutating goes through an
 * activity. That's what makes Temporal able to replay the workflow safely
 * after a worker restart.
 */

// All activities run through the proxy with a default retry policy.
// Per-activity overrides come from the spec's `timeoutSeconds` and `retry`.
const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '1s',
    maximumInterval: '1m',
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

// Signals are the canonical Temporal pattern for human-in-the-loop:
// the workflow stays running (suspended waiting for a condition) while
// an external system — our /approve API route — sends a signal.
// Approvals are keyed by nodeId because a workflow can have multiple
// approval gates.
export interface ApprovalPayload {
  nodeId: string;
  decision: 'APPROVED' | 'REJECTED';
  reason?: string;
}
export const approvalSignal = defineSignal<[ApprovalPayload]>('approval');

export interface WorkflowExecutionInput {
  runId: string;          // our DB run id, used for audit logging
  spec: WorkflowSpec;
}

export interface WorkflowExecutionResult {
  status: 'COMPLETED' | 'REJECTED';
  results: Record<string, unknown>;
  decisions: Record<string, boolean>;
}

export async function executeWorkflow(
  input: WorkflowExecutionInput
): Promise<WorkflowExecutionResult> {
  const { runId, spec } = input;
  log.info('run.start', { runId, name: spec.name });

  // Per-run state. Activity outputs flow here so downstream decision
  // nodes can reference them by id.
  const results: Record<string, unknown> = {};
  const decisions: Record<string, boolean> = {};
  const pendingApprovals = new Map<string, ApprovalPayload>();

  // Register the approval handler ONCE at workflow start.
  // Multiple approval nodes are disambiguated by `nodeId`.
  setHandler(approvalSignal, (payload: ApprovalPayload) => {
    pendingApprovals.set(payload.nodeId, payload);
  });

  await acts.recordAudit({
    runId,
    eventType: 'RUN_STARTED',
    payload: { workflow: spec.name },
  });

  // Topological order over the DAG gives us a valid execution sequence.
  // (In a v2 we'd parallelise independent branches — the topo sort
  // already makes that trivial — but for the demo this is clearer.)
  const order = topologicalSort(spec);
  const reachable = computeReachability(spec, order, decisions);

  for (const node of order) {
    // Skip nodes pruned by a false decision branch
    if (!reachable(node.id)) {
      await acts.recordAudit({
        runId,
        nodeId: node.id,
        eventType: 'STEP_SKIPPED',
        payload: { reason: 'unreachable from decision branch' },
      });
      continue;
    }

    await acts.recordAudit({
      runId,
      nodeId: node.id,
      eventType: 'STEP_START',
      payload: { type: node.type, label: node.label },
    });

    try {
      switch (node.type) {
        case 'trigger':
          // Triggers are dispatched upstream (Inngest or HTTP).
          // By the time the workflow is running, the trigger has fired.
          break;

        case 'activity': {
          // Substitute references like "{previous_node_id.balance}" in args.
          const resolved = resolveArgs(node.args, results);
          const out = await acts.dispatchActivity({
            name: node.activity,
            args: resolved,
          });
          results[node.id] = out;
          break;
        }

        case 'decision': {
          const passed = evaluateCondition(node.condition, results);
          decisions[node.id] = passed;
          await acts.recordAudit({
            runId,
            nodeId: node.id,
            eventType: 'DECISION',
            payload: { condition: node.condition, result: passed },
          });
          break;
        }

        case 'approval': {
          // Persist the pending row so the UI/API can see it
          await acts.recordPendingApproval({
            runId,
            nodeId: node.id,
            role: node.approverRole,
            slaHours: node.slaHours,
          });

          // Block until the matching signal arrives, with SLA timeout.
          const slaMs = node.slaHours * 3_600_000;
          const got = await condition(
            () => pendingApprovals.has(node.id),
            slaMs
          );

          if (!got) {
            await acts.recordAudit({
              runId,
              nodeId: node.id,
              eventType: 'APPROVAL_TIMED_OUT',
              payload: { slaHours: node.slaHours },
            });
            throw new Error(`approval timed out after ${node.slaHours}h`);
          }

          const decision = pendingApprovals.get(node.id)!;
          if (decision.decision === 'REJECTED') {
            await acts.recordAudit({
              runId,
              nodeId: node.id,
              eventType: 'REJECTED',
              payload: { reason: decision.reason },
            });
            return { status: 'REJECTED', results, decisions };
          }
          break;
        }
      }

      await acts.recordAudit({
        runId,
        nodeId: node.id,
        eventType: 'STEP_DONE',
        payload: {},
      });
    } catch (err) {
      const message = (err as Error).message;
      await acts.recordAudit({
        runId,
        nodeId: node.id,
        eventType: 'STEP_FAILED',
        payload: { error: message },
      });
      // Notify ops via Slack — but don't fail the whole audit pipeline if
      // notification itself errors out (best-effort).
      await acts.notifyException({ runId, nodeId: node.id, error: message })
        .catch(() => undefined);
      throw err;
    }
  }

  await acts.recordAudit({
    runId,
    eventType: 'RUN_COMPLETED',
    payload: { resultKeys: Object.keys(results) },
  });
  log.info('run.complete', { runId });

  return { status: 'COMPLETED', results, decisions };
}

// --------------------------------------------------------------------
// Graph utilities (pure, deterministic — safe inside workflow code)
// --------------------------------------------------------------------

function topologicalSort(spec: WorkflowSpec): NodeSpec[] {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const byId = new Map<string, NodeSpec>();
  for (const n of spec.nodes) {
    indegree.set(n.id, 0);
    adj.set(n.id, []);
    byId.set(n.id, n);
  }
  for (const e of spec.edges) {
    adj.get(e.from)!.push(e.to);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }

  const queue = spec.nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id);
  const order: NodeSpec[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(byId.get(id)!);
    for (const next of adj.get(id) ?? []) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== spec.nodes.length) {
    throw new Error('cyclic workflow reached the worker — compiler should have rejected this');
  }
  return order;
}

/**
 * Returns a function `reachable(nodeId)` which tells the interpreter
 * whether to execute a given node based on which decision branches
 * were taken. Edges with when="true"/"false" are pruned when the
 * source decision evaluated the opposite way.
 */
function computeReachability(
  spec: WorkflowSpec,
  order: NodeSpec[],
  decisions: Record<string, boolean>
): (nodeId: string) => boolean {
  const incoming = new Map<string, Edge[]>();
  for (const n of spec.nodes) incoming.set(n.id, []);
  for (const e of spec.edges) incoming.get(e.to)?.push(e);

  return (nodeId: string) => {
    const edges = incoming.get(nodeId) ?? [];
    if (edges.length === 0) return true;                 // triggers
    return edges.some((e) => {
      if (e.when === 'always') return true;
      const decision = decisions[e.from];
      if (decision === undefined) return true;           // decision not yet evaluated
      return (e.when === 'true' && decision) || (e.when === 'false' && !decision);
    });
  };
}

// --------------------------------------------------------------------
// Tiny expression evaluator for decision conditions.
// Supports: <var> <op> <number>  where op ∈ {>, >=, <, <=, ==, !=}
// Vars are resolved against the flattened results context: e.g. if
// `fetch_balances` returned [{balance: 148000, ...}] then the var
// `balance` resolves to the first matching field anywhere in results.
// --------------------------------------------------------------------
function evaluateCondition(
  expr: string,
  ctx: Record<string, unknown>
): boolean {
  const m = expr.trim().match(/^([a-zA-Z_][a-zA-Z0-9_.]*)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) {
    // Unknown expression shape — fail closed (do not branch).
    throw new Error(`unsupported condition expression: ${expr}`);
  }
  const [, path, op, rhsRaw] = m;
  const rhs = Number(rhsRaw);
  const lhs = resolveVar(path!, ctx);
  if (typeof lhs !== 'number') {
    throw new Error(`condition var ${path} did not resolve to a number`);
  }
  switch (op) {
    case '>':  return lhs >  rhs;
    case '>=': return lhs >= rhs;
    case '<':  return lhs <  rhs;
    case '<=': return lhs <= rhs;
    case '==': return lhs === rhs;
    case '!=': return lhs !== rhs;
    default:   throw new Error(`unreachable op: ${op}`);
  }
}

function resolveVar(path: string, ctx: Record<string, unknown>): unknown {
  // First try dotted lookup directly in ctx (e.g. "fetch.balance")
  const parts = path.split('.');
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else { cur = undefined; break; }
  }
  if (cur !== undefined) return cur;

  // Fallback: find first occurrence of the leaf name anywhere in ctx
  const leaf = parts[parts.length - 1]!;
  for (const v of Object.values(ctx)) {
    const found = findKey(v, leaf);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findKey(obj: unknown, key: string): unknown {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findKey(item, key);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    if (key in o) return o[key];
    for (const v of Object.values(o)) {
      const r = findKey(v, key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

/** Replace "{node_id.field}" placeholders in an args object. */
function resolveArgs(
  args: Record<string, unknown>,
  ctx: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      out[k] = v.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, ref) => {
        const r = resolveVar(ref, ctx);
        return r === undefined ? `{${ref}}` : String(r);
      });
    } else {
      out[k] = v;
    }
  }
  return out;
}
