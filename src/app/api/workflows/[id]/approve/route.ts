import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getTemporalClient } from '@/lib/temporal-client';

/**
 * POST /api/workflows/[id]/approve
 *
 * Delivers an approval decision to a paused Temporal workflow.
 * The flow is:
 *   1. Look up the pending Approval row for this run + node
 *   2. Update it with the decision (DB is the system of record for who decided)
 *   3. Signal the running workflow — Temporal then resumes execution
 *
 * We update the DB first so even if the Temporal signal fails we still
 * have an audit trail of the decision and can reconcile later.
 *
 *   curl -X POST http://localhost:3000/api/workflows/<workflowId>/approve \
 *     -H "content-type: application/json" \
 *     -d '{"runId":"<runId>","nodeId":"approve","decision":"APPROVED","approverId":"u_cfo"}'
 */

export const runtime = 'nodejs';

const Body = z.object({
  runId: z.string(),
  nodeId: z.string(),
  decision: z.enum(['APPROVED', 'REJECTED']),
  approverId: z.string(),
  reason: z.string().max(500).optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } }
): Promise<NextResponse> {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { runId, nodeId, decision, approverId, reason } = parsed.data;

  // Find the pending approval for this run+node. We don't allow
  // double-approval; an already-decided gate returns 409.
  const approval = await prisma.approval.findFirst({
    where: { runId, nodeId, decision: null },
  });
  if (!approval) {
    return NextResponse.json(
      { error: 'no_pending_approval' },
      { status: 409 }
    );
  }

  // Verify the run belongs to the workflow in the path (defence in depth)
  const run = await prisma.workflowRun.findUnique({
    where: { id: runId },
    select: { id: true, workflowId: true },
  });
  if (!run || run.workflowId !== ctx.params.id) {
    return NextResponse.json({ error: 'run_workflow_mismatch' }, { status: 404 });
  }

  // 1) Record the decision in our DB (system of record for compliance)
  await prisma.approval.update({
    where: { id: approval.id },
    data: {
      decision,
      decidedAt: new Date(),
      approverId,
      reason: reason ?? null,
    },
  });

  // 2) Signal the running workflow so it can resume / reject
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(`wf-${run.workflowId}-run-${run.id}`);
  try {
    await handle.signal('approval', { nodeId, decision, reason });
  } catch (err) {
    // Workflow already completed / timed out — DB still records the
    // intent so ops can reconcile.
    console.error('temporal.signal.failed', err);
    return NextResponse.json(
      { ok: false, warning: 'workflow_no_longer_running' },
      { status: 202 }
    );
  }

  return NextResponse.json({ ok: true });
}
