import { TaskListView } from "./scheduled/TaskListView";
import { TaskDetailView } from "./scheduled/TaskDetailView";
import { TaskCreateView } from "./scheduled/TaskCreateView";

export function ScheduledTasksView({
  taskOpen,
  taskCreate,
  onOpenTask,
  onBackToTasks,
  onCloseCreate,
}: {
  taskOpen: number | null;
  taskCreate: boolean;
  onOpenTask: (index: number) => void;
  onBackToTasks: () => void;
  onCloseCreate: () => void;
}) {
  if (taskCreate) return <TaskCreateView onClose={onCloseCreate} />;
  if (taskOpen !== null) return <TaskDetailView taskIndex={taskOpen} onBack={onBackToTasks} />;
  return <TaskListView onOpenTask={onOpenTask} />;
}
