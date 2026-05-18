# WorkflowForge

Natural-language → deterministic Temporal workflow compiler.

A finance operator types *"Sweep idle cash above £100k into BlackRock MMF every Friday at 4pm, require CFO sign-off if over £150k"*. The system compiles that into a typed DAG, persists it, and — when the cron fires — runs it as a Temporal workflow with full audit trail, human-in-the-loop approval, and retry semantics.

Built as a demo for the Round Treasury Founding Product Engineer role.
Stack matches the JD: **Next.js · TypeScript · Prisma · PostgreSQL · Temporal · Inngest** + Anthropic SDK for the NL compiler.

---

## Architecture at a glance

```
                     ┌─────────────────────────────────────┐
                     │   POST /api/workflows/compile       │
                     │   prompt (NL)  ────►   WorkflowSpec │
                     │              compiler.ts (Claude)   │
                     └────────────────────┬────────────────┘
                                          │
                                          ▼
                              ┌────────────────────────┐
                              │  Postgres (Prisma)     │
                              │  • Workflow            │
                              │  • WorkflowRun         │
                              │  • Approval            │
                              │  • AuditEvent          │
                              └───────────┬────────────┘
                                          │
            ┌─────────────────────────────┼──────────────────────────────┐
            │                             │                              │
            ▼                             ▼                              ▼
   ┌────────────────┐         ┌────────────────────┐         ┌─────────────────────┐
   │   Inngest      │         │  POST .../execute  │         │ POST .../approve    │
   │   • cron scan  │────────►│  starts run via    │         │ signals running     │
   │   • event fanout│        │  Temporal client   │         │ Temporal workflow   │
   └────────────────┘         └─────────┬──────────┘         └──────────┬──────────┘
                                        │                               │
                                        ▼                               │
                              ┌────────────────────┐                    │
                              │  Temporal Worker   │◄───────────────────┘
                              │  executeWorkflow() │   approvalSignal
                              │  + activities/     │
                              └────────────────────┘
```

**Two orchestrators, two jobs:**

- **Inngest** decides *when* to fire a workflow (cron polling, event fanout). Sits above Temporal.
- **Temporal** runs the *deterministic execution* of each workflow. Replay-safe, signal-driven, audit-friendly.

---

## What's in the box

| File | What it does |
|---|---|
| `prisma/schema.prisma` | Data model. FCA-grade audit trail (`AuditEvent`), per-run approval gates (`Approval`). |
| `src/lib/types.ts` | The `WorkflowSpec` DSL as a Zod discriminated union. Compile-time + runtime validation. |
| `src/lib/compiler.ts` | NL → DSL via Anthropic Claude. Strict schema validation + cycle detection before persisting. |
| `src/temporal/workflows/execute-workflow.ts` | The DSL interpreter. One workflow that runs any spec. Uses signals for human-in-the-loop approval. |
| `src/temporal/activities/*.ts` | All side effects: Plaid, Insignis MMF, Slack, audit writes. |
| `src/temporal/worker.ts` | Worker entrypoint (`npm run worker`). |
| `src/app/api/workflows/compile/route.ts` | `POST` — compile NL to spec. |
| `src/app/api/workflows/[id]/execute/route.ts` | `POST` — start a run. |
| `src/app/api/workflows/[id]/approve/route.ts` | `POST` — deliver approval decision (DB update + Temporal signal). |
| `src/app/api/workflows/[id]/runs/route.ts` | `GET` — list runs with full audit trail. |
| `src/inngest/functions.ts` | Cron scanner + event fanout. |

---

## Design choices worth flagging

1. **One Temporal workflow for all specs.** Instead of compiling each DSL to a separate workflow definition, `executeWorkflow` interprets the spec at runtime. New activity primitives can be added to the catalogue without redeploying the worker. Trade-off: less per-spec optimisability, more dynamism. For a treasury automation product where every customer has a different shape, dynamism wins.

2. **Signals + `condition()` for human approval.** Hitting an `approval` node calls `condition(() => signalReceived, slaMs)` — the workflow stays paused (and replay-able) until the `/approve` route signals it, or the SLA expires. This is the canonical Temporal pattern for HITL, and it means a 4-hour-long approval doesn't cost a thread.

3. **DB + Temporal are dual-written for approvals, with DB as the system of record.** The `/approve` endpoint writes the decision to Postgres *first*, then signals Temporal. If the signal fails (workflow already timed out, worker down), we still have compliance-grade record of who decided what and when.

4. **Determinism boundary is explicit.** All workflow-side code (`src/temporal/workflows/*`) is deterministic — no `Date.now()`, no `Math.random()`, no I/O. Every external interaction goes through `proxyActivities`. This is what makes Temporal able to recover gracefully from worker restarts and replay event history for debugging.

5. **Compile-time and runtime spec validation.** Zod's `discriminatedUnion` + `superRefine` catches malformed Claude output before anything hits the DB. The compiler also runs a DFS cycle check (Zod can validate shape, not graph properties).

---

## Quickstart

```bash
# 1. Install
npm install

# 2. Spin up infra (separate terminals)
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
temporal server start-dev                          # Temporal dev server on :7233
npx inngest-cli@latest dev                         # Inngest dev server

# 3. Configure
cp .env.example .env.local                          # set ANTHROPIC_API_KEY at minimum

# 4. Migrate + seed
npm run db:migrate
npm run db:seed

# 5. Run (separate terminals)
npm run worker                                      # Temporal worker
npm run dev                                         # Next.js API on :3000
```

Then exercise the API:

```bash
# Compile a workflow
curl -X POST http://localhost:3000/api/workflows/compile \
  -H "content-type: application/json" \
  -d '{
    "prompt": "Sweep idle cash over £100k into BlackRock MMF every Friday 4pm, require CFO approval if over £150k",
    "userId": "u_demo"
  }'
# → { "workflowId": "clxxx...", "name": "treasury_sweep_friday", "spec": {...} }

# Start a run
curl -X POST http://localhost:3000/api/workflows/clxxx.../execute \
  -H "content-type: application/json" \
  -d '{"userId": "u_demo"}'
# → { "runId": "cmyyy...", "status": "RUNNING", ... }

# When the workflow hits the approval gate it pauses. Decide:
curl -X POST http://localhost:3000/api/workflows/clxxx.../approve \
  -H "content-type: application/json" \
  -d '{
    "runId": "cmyyy...",
    "nodeId": "approve_sweep",
    "decision": "APPROVED",
    "approverId": "u_cfo"
  }'

# Inspect the audit trail
curl http://localhost:3000/api/workflows/clxxx.../runs
```

---

## What's not in this demo

This is a focused slice — the parts that show the engineering judgement, not a complete product. Out of scope here but obvious next steps:

- **Auth.** No JWT / session middleware on the API routes. In production these would sit behind a `withAuth(orgId, roles)` wrapper and `createdById` would come from the session, not the request body.
- **Real Plaid integration.** `banks.ts` returns hardcoded balances. The shape mirrors `AccountBase` from `plaid-node` so wiring it up is a small lift.
- **Cron parsing.** `isCronDue` is a stub — production would use `croner` for tz-correct evaluation.
- **Frontend.** The interactive demo at [samson1402.github.io](https://samson1402.github.io) is the UI counterpart.
- **Tests.** Unit tests on `compiler.ts` (golden specs) and the interpreter (graph correctness) are the first thing I'd add.
- **Observability.** OpenTelemetry tracing across the Inngest → Temporal → activity boundaries — Temporal's `interceptor` API makes this clean.

---

Built by Sameer M · 2026 · [samson1402.github.io](https://samson1402.github.io)
