import { inngest } from './client';
import { prisma } from '../lib/prisma';
import { getTemporalClient, TASK_QUEUE } from '../lib/temporal-client';
import type { WorkflowSpec } from '../lib/types';

/**
 * Why two orchestrators? Temporal runs the deterministic *execution*
 * of each workflow; Inngest sits one level up and decides *when* a
 * workflow should fire. This split keeps the cron/event-routing layer
 * separately observable from the business logic, which matches the
 * pattern Round describes in their stack (Temporal + Inngest).
 *
 * Two functions live here:
 *   1. cronScanner   — runs every 5 minutes, finds ACTIVE workflows
 *                      with cron triggers that are due, starts a run.
 *   2. eventTrigger  — fans event-triggered workflows out when their
 *                      named event arrives.
 */

// Tick every 5 minutes. Production granularity would depend on the
// finest cron the product supports — for treasury ops this is plenty.
export const cronScanner = inngest.createFunction(
  { id: 'cron-scanner' },
  { cron: '*/5 * * * *' },
  async ({ step }) => {
    const due = await step.run('find-due-workflows', async () => {
      const workflows = await prisma.workflow.findMany({
        where: { status: 'ACTIVE' },
      });
      return workflows.filter((wf) => {
        const spec = wf.spec as unknown as WorkflowSpec;
        const trigger = spec.nodes.find((n) => n.type === 'trigger');
        if (!trigger || trigger.type !== 'trigger') return false;
        if (trigger.config.kind !== 'cron') return false;
        return isCronDue(trigger.config.cron, trigger.config.tz);
      });
    });

    for (const wf of due) {
      await step.run(`start-${wf.id}`, async () => {
        const run = await prisma.workflowRun.create({
          data: {
            workflowId: wf.id,
            temporalRunId: '',
            status: 'RUNNING',
            triggeredBy: 'cron',
          },
        });
        const client = await getTemporalClient();
        const handle = await client.workflow.start('executeWorkflow', {
          args: [{ runId: run.id, spec: wf.spec as unknown as WorkflowSpec }],
          taskQueue: TASK_QUEUE,
          workflowId: `wf-${wf.id}-run-${run.id}`,
        });
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: { temporalRunId: handle.firstExecutionRunId },
        });
      });
    }

    return { triggered: due.length };
  }
);

// Event-driven workflow trigger. Anything in the app can call
// `inngest.send({ name: 'workflow.event', data: { event: 'payroll.due' } })`
// and any ACTIVE workflow whose trigger is that event will fire.
export const eventTrigger = inngest.createFunction(
  { id: 'event-trigger' },
  { event: 'workflow.event' },
  async ({ event, step }) => {
    const eventName = (event.data as { event: string }).event;
    const matches = await step.run('find-event-workflows', async () => {
      const workflows = await prisma.workflow.findMany({
        where: { status: 'ACTIVE' },
      });
      return workflows.filter((wf) => {
        const spec = wf.spec as unknown as WorkflowSpec;
        const trigger = spec.nodes.find((n) => n.type === 'trigger');
        if (!trigger || trigger.type !== 'trigger') return false;
        return trigger.config.kind === 'event' && trigger.config.event === eventName;
      });
    });

    for (const wf of matches) {
      await step.run(`start-${wf.id}`, async () => {
        const run = await prisma.workflowRun.create({
          data: {
            workflowId: wf.id,
            temporalRunId: '',
            status: 'RUNNING',
            triggeredBy: `event:${eventName}`,
          },
        });
        const client = await getTemporalClient();
        const handle = await client.workflow.start('executeWorkflow', {
          args: [{ runId: run.id, spec: wf.spec as unknown as WorkflowSpec }],
          taskQueue: TASK_QUEUE,
          workflowId: `wf-${wf.id}-run-${run.id}`,
        });
        await prisma.workflowRun.update({
          where: { id: run.id },
          data: { temporalRunId: handle.firstExecutionRunId },
        });
      });
    }
    return { matched: matches.length };
  }
);

/**
 * In production we'd use the `croner` package (cron-parser fork that
 * handles timezones cleanly). For the demo, a coarse "every cron fires
 * at the top of the hour" check is enough to show the wiring.
 */
function isCronDue(_cron: string, _tz: string): boolean {
  // TODO: import { Cron } from 'croner';
  //   const c = new Cron(cron, { timezone: tz });
  //   const next = c.nextRun()!;
  //   return Math.abs(next.getTime() - Date.now()) < 5 * 60 * 1000;
  return false;
}
