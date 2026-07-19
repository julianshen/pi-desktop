import { GitBranchIcon } from "lucide-react";

export interface BranchView {
  id: string;
  parentBranchId?: string;
  sourceMessageId?: string;
  createdAt: string;
}

export function BranchPicker({ branches, activeBranchId, onSelect }: {
  branches: readonly BranchView[];
  activeBranchId?: string;
  onSelect: (branchId: string) => void;
}) {
  if (branches.length <= 1) return null;
  return (
    <label className="flex items-center gap-ds-1 font-heading text-[11px] uppercase tracking-[0.08em] text-text/60">
      <GitBranchIcon size={13} aria-hidden />
      Branch
      <select
        aria-label="Conversation branch"
        className="input h-8 min-w-28 py-0 text-[12px]"
        value={activeBranchId ?? branches[0]?.id}
        onChange={(event) => onSelect(event.target.value)}
      >
        {branches.map((branch, index) => (
          <option key={branch.id} value={branch.id}>{index === 0 ? "Original" : `Branch ${index + 1}`}</option>
        ))}
      </select>
    </label>
  );
}
