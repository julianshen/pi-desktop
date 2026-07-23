import { TaskForm } from "./TaskForm.js";
import type { ScheduledTaskInput } from "./types.js";

export function TaskCreateView({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate?: (value: ScheduledTaskInput) => Promise<unknown>;
}) {
  return <TaskForm mode="create" onCancel={onClose} onSubmit={onCreate ?? (() => Promise.resolve())} />;
}
