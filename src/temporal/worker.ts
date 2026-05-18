import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';

/**
 * Worker entrypoint.
 *
 * Run with: `pnpm worker` (or `npm run worker`).
 *
 * One worker process per task queue. In production we'd run a fleet
 * behind a process supervisor (PM2 / systemd) or as a long-running
 * container in ECS / Cloud Run. Round's Temporal cluster termination
 * concerns mean a graceful shutdown handler is a non-negotiable.
 */
async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'workflowforge',
    workflowsPath: require.resolve('./workflows/execute-workflow'),
    activities,
    // Keep activity & workflow concurrency modest in dev. Tune per env.
    maxConcurrentActivityTaskExecutions: 50,
    maxConcurrentWorkflowTaskExecutions: 25,
  });

  process.on('SIGTERM', () => worker.shutdown());
  process.on('SIGINT',  () => worker.shutdown());

  console.log(`[worker] task_queue=${worker.options.taskQueue} ready`);
  await worker.run();
  console.log('[worker] shutdown complete');
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
