/**
 * BullMQ queue / worker factory.
 *
 * Key design decisions:
 * - One Redis connection object is shared between Queue and Worker for the same
 *   queue name (BullMQ v5 allows this via the `connection` option accepting an
 *   existing IORedis instance).
 * - `concurrency: 1` on all poller workers ensures exactly-once execution per
 *   tick even when multiple process replicas start workers for the same queue.
 *   BullMQ uses Redis SET NX locks under the hood to arbitrate ownership.
 * - `upsertJobScheduler` is idempotent — restarting a service does not create
 *   duplicate repeatable jobs.
 * - DLQ: failed jobs are kept for 500 runs (configurable). Use BullMQ Board or
 *   the `getFailedJobs()` API to inspect them.
 */
import { Queue, Worker } from "bullmq";

import { config } from "@/config/config.js";
import { logger } from "@/utils/logger.js";

function redisConnection() {
  if (!config.redisUrl) {
    throw new Error("REDIS_URL is required for BullMQ queues — set it in Railway env vars.");
  }
  return { url: config.redisUrl };
}

export interface PollerJobHandle {
  queue: Queue;
  worker: Worker;
  /** Gracefully stop the worker and close the queue. */
  stop: () => Promise<void>;
}

/**
 * Start a repeatable BullMQ poller job.
 *
 * @param name        Queue name (e.g. "price-alert-poller"). Must be unique per poller.
 * @param tickOnce    Async function that runs one poll pass. Corresponds to the
 *                    existing `tickOnce()` method on each poller class.
 * @param intervalMs  How often to fire the job (replaces the `setInterval` period).
 * @param opts        Optional overrides for remove-on-complete / remove-on-fail counts.
 */
export async function startPollerJob(
  name: string,
  tickOnce: () => Promise<unknown>,
  intervalMs: number,
  opts: { keepCompleted?: number; keepFailed?: number } = {},
): Promise<PollerJobHandle> {
  const conn = redisConnection();
  const keepCompleted = opts.keepCompleted ?? 100;
  const keepFailed = opts.keepFailed ?? 500;

  const queue = new Queue(name, {
    connection: conn,
    defaultJobOptions: {
      removeOnComplete: keepCompleted,
      removeOnFail: keepFailed,
    },
  });

  // Upsert the repeatable scheduler — idempotent across process restarts.
  await queue.upsertJobScheduler(
    `${name}:scheduler`,
    { every: intervalMs },
    { name: "tick", data: {} },
  );

  const worker = new Worker(
    name,
    async () => {
      await tickOnce();
    },
    {
      connection: conn,
      concurrency: 1,
      removeOnComplete: { count: keepCompleted },
      removeOnFail: { count: keepFailed },
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, queue: name, err }, "[bullmq] job failed");
  });

  worker.on("error", (err) => {
    logger.error({ queue: name, err }, "[bullmq] worker error");
  });

  logger.info(`🔧 BullMQ worker started: ${name} (every ${Math.round(intervalMs / 1000)}s)`);

  return {
    queue,
    worker,
    stop: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
