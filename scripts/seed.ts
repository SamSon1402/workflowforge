import { PrismaClient } from '@prisma/client';
import type { WorkflowSpec } from '../src/lib/types';

const prisma = new PrismaClient();

// A realistic sample workflow that exercises every node type:
// trigger → activity → decision → approval → activity → activity
const treasurySweep: WorkflowSpec = {
  name: 'treasury_sweep_friday',
  description: 'Sweep idle cash above £100k into BlackRock MMF, with CFO sign-off if over £150k',
  audit: true,
  nodes: [
    {
      id: 'trigger',
      type: 'trigger',
      label: 'Friday 16:00',
      config: { kind: 'cron', cron: '0 16 * * 5', tz: 'Europe/London' },
    },
    {
      id: 'fetch_balances',
      type: 'activity',
      label: 'Fetch balances',
      activity: 'banks.aggregate',
      args: {},
      timeoutSeconds: 30,
      retry: { maxAttempts: 3, backoff: 'exponential' },
    },
    {
      id: 'check_threshold',
      type: 'decision',
      label: 'Balance over £100k?',
      condition: 'balance > 100000',
    },
    {
      id: 'approve_sweep',
      type: 'approval',
      label: 'CFO sign-off',
      approverRole: 'CFO',
      slaHours: 4,
    },
    {
      id: 'sweep',
      type: 'activity',
      label: 'Sweep to MMF',
      activity: 'insignis.deposit',
      args: { amount: 50000 },
      timeoutSeconds: 60,
      retry: { maxAttempts: 3, backoff: 'exponential' },
    },
    {
      id: 'notify',
      type: 'activity',
      label: 'Notify CFO on Slack',
      activity: 'slack.dm',
      args: { user: '@cfo', message: 'Treasury sweep complete' },
      timeoutSeconds: 15,
      retry: { maxAttempts: 3, backoff: 'exponential' },
    },
  ],
  edges: [
    { from: 'trigger', to: 'fetch_balances', when: 'always' },
    { from: 'fetch_balances', to: 'check_threshold', when: 'always' },
    { from: 'check_threshold', to: 'approve_sweep', when: 'true' },
    { from: 'approve_sweep', to: 'sweep', when: 'always' },
    { from: 'sweep', to: 'notify', when: 'always' },
  ],
};

async function main(): Promise<void> {
  const wf = await prisma.workflow.create({
    data: {
      name: treasurySweep.name,
      description: treasurySweep.description ?? null,
      prompt:
        'Sweep idle cash above £100k into BlackRock MMF every Friday at 4pm. ' +
        'Require CFO sign-off if the amount is over £150k. Notify CFO on Slack when done.',
      spec: treasurySweep as never,
      status: 'ACTIVE',
      createdById: 'u_demo',
    },
  });
  console.log(`seeded workflow ${wf.id} (${wf.name})`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
