import { createContext } from "react";

export interface BranchActions {
  createBranch(sourceMessageId: string, replacementContent: string): Promise<void>;
}

export const BranchActionsContext = createContext<BranchActions | null>(null);
