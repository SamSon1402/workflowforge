import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/workflows/[id]/runs
 *
 * Lists recent runs for a workflow with their audit trail and pending
 * approvals. Used by the UI to render the run timeline and surface
 * gates that need attention.
 *
 *   curl http://localhost:3000/api/workflows/<id>/runs
 */

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  ctx: { params: { id: string } }
): Promise<NextResponse> {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '25'), 100);

  const exists = await prisma.workflow.findUnique({
    where: { id: ctx.params.id },
    select: { id: true },
  });
  if (!exists) {
    return NextResponse.json({ error: 'workflow_not_found' }, { status: 404 });
  }

  const runs = await prisma.workflowRun.findMany({
    where: { workflowId: ctx.params.id },
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: {
      events: {
        orderBy: { timestamp: 'asc' },
        take: 200,
      },
      approvals: true,
    },
  });

  return NextResponse.json({
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      triggeredBy: r.triggeredBy,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      pendingApprovals: r.approvals.filter((a) => a.decision === null).map((a) => ({
        id: a.id,
        nodeId: a.nodeId,
        role: a.role,
      })),
      events: r.events.map((e) => ({
        nodeId: e.nodeId,
        eventType: e.eventType,
        payload: e.payload,
        timestamp: e.timestamp,
      })),
    })),
  });
}
