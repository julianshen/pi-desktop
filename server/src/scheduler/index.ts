import { env } from "../config/env.js";
import { getAgentDeps } from "../agent/deps.js";
import { resolveModelById } from "../agent/models.js";
import { RunStore } from "./run-store.js";
import { SchedulerService } from "./service.js";
import { ScheduledRunExecutor, createScheduledSession } from "./session.js";
import { TaskStore } from "./task-store.js";

let schedulerPromise: Promise<SchedulerService> | undefined;

export { createScheduledSession };

export function getSchedulerService(): Promise<SchedulerService> {
  if (!schedulerPromise) {
    schedulerPromise = (async () => {
      const runStore = new RunStore(env.dataDir);
      const runner = new ScheduledRunExecutor({ runStore });
      const service = new SchedulerService({
        taskStore: new TaskStore(env.agentDir),
        runStore,
        runner,
        resolveModel: async (id) => {
          const { modelRegistry } = await getAgentDeps();
          return Boolean(await resolveModelById(id, modelRegistry));
        },
      });
      await service.start();
      return service;
    })();
  }
  return schedulerPromise;
}

export async function startScheduler(): Promise<void> {
  const service = await getSchedulerService();
  if (service.listTasks().length === 0) {
    console.log(`[scheduler] no scheduled agents configured (edit ${new TaskStore(env.agentDir).configPath})`);
  }
}
