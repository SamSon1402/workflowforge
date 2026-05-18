import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getTemporalClient, TASK_QUEUE } from '@/lib/temporal-client';
import type { WorkflowSpec } from '@/lib/types';

/**
 * POST /api/workflows/[id]/execute
 *
 * Triggers a new run of a stored workflow. Creates a WorkflowRun row,
 * starts the matching Temporal workflow, and returns the run id so the
 * client can poll /runs for progress.
 *
 *   curl -X POST http://localhost:3000/api/workflows/<id>/execute \
 *     -H "content-type: application/json" -d '{"userId":"u_demo"}'
 */

export const runtime = 'nodejs';

const Body = z.object({
  userId: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: { id: string } }
): Promise<NextResponse> {
  const workflow = await prisma.workflow.findUnique({ where: { id: ctx.params.id } });
  if (!workflow) {
    return NextResponse.json({ error: 'workflow_not_found' }, { status: 404 });
  }
  if (workflow.status === 'ARCHIVED') {
    return NextResponse.json({ error: 'workflow_archived' }, { status: 409 });
  }

  const { userId } = Body.parse(await req.json().catch(() => ({})));

  // Create the DB run row FIRST so its id is available to the workflow
  // (used as the audit-log foreign key throughout the run).
  const run = await prisma.workflowRun.create({
    data: {
      workflowId: workflow.id,
      temporalRunId: '',                  // backfilled after start
      status: 'RUNNING',
      triggeredBy: userId ?? 'manual',
    },
  });

  // Kick off the Temporal workflow. The workflowId we pass to Temporal
  // is deterministic and unique-per-run, which means starting the same
  // run twice would be rejected by Temporal — built-in idempotency.
  const client = await getTemporalClient();
  let handle;
  try {
    handle = await client.workflow.start('executeWorkflow', {
      args: [{ runId: run.id, spec: workflow.spec as unknown as WorkflowSpec }],
      taskQueue: TASK_QUEUE,
      workflowId: `wf-${workflow.id}-run-${run.id}`,
    });
  } catch (err) {
    await prisma.workflowRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', completedAt: new Date() },
    });
    console.error('temporal.start.failed', err);
    return NextResponse.json({ error: 'temporal_start_failed' }, { status: 502 });
  }

  await prisma.workflowRun.update({
    where: { id: run.id },
    data: { temporalRunId: handle.firstExecutionRunId },
  });

  return NextResponse.json({
    runId: run.id,
    temporalWorkflowId: handle.workflowId,
    temporalRunId: handle.firstExecutionRunId,
    status: 'RUNNING',
  }, { status: 202 });
}
