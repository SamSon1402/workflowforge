import { prisma } from '../../lib/prisma';

/**
 * Audit is a first-class concept — every step start, end, exception
 * and decision flows through here. Kept as a Temporal activity (not
 * called from workflow code directly) because writing to Postgres is
 * a side effect.
 */
export async function recordAudit(args: {
  runId: string;
  nodeId?: string;
  eventType: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      runId: args.runId,
      nodeId: args.nodeId ?? null,
      eventType: args.eventType,
      payload: args.payload as never,
    },
  });
}
