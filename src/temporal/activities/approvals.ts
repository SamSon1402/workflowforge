import { prisma } from '../../lib/prisma';
import { slackChannel } from './notifications';

/**
 * Persists a pending approval row at the moment the workflow hits the
 * gate. The UI / API surface reads from this table to drive the
 * "Pending approval" inbox. The actual decision is delivered back to
 * the workflow via the approvalSignal — see executeWorkflow.
 */
export async function recordPendingApproval(args: {
  runId: string;
  nodeId: string;
  role: string;
  slaHours: number;
}): Promise<void> {
  await prisma.approval.create({
    data: {
      runId: args.runId,
      nodeId: args.nodeId,
      role: args.role,
    },
  });

  // Best-effort heads-up to the relevant role channel.
  await slackChannel({
    channel: `#${args.role.toLowerCase().replace(/_/g, '-')}-approvals`,
    message: `🔔 Approval requested for run ${args.runId} step ${args.nodeId} (SLA ${args.slaHours}h)`,
  }).catch(() => undefined);
}
