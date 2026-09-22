import type { Command, Task } from '../../shared/contracts.js';
import { parseCommand } from '../../shared/validate.js';
import type { Store } from '../store/task-store.js';
import type { Coordinator } from './coordinator.js';

export async function applyHumanCommand(store: Store, coordinator: Coordinator, input: Command): Promise<Task> {
  const command = parseCommand(input);
  const accepted = await store.apply(command.taskId, command.expectedRevision,
    command.requestId, { kind: 'human', command });
  if (accepted.intent === 'pause' || accepted.intent === 'cancel') {
    const current = await store.get(accepted.id);
    const acceptedRun = accepted.runs.find(run => run.phase === 'running' || run.phase === 'launch-intent');
    const currentRun = current.runs.find(run => run.phase === 'running' || run.phase === 'launch-intent');
    if (acceptedRun && current.intent === accepted.intent && current.generation === accepted.generation &&
        currentRun?.id === acceptedRun.id) {
      await coordinator.stopTask(accepted.id, acceptedRun.id);
    }
  }
  return accepted;
}
