/**
 * Sample data for views that have no backend yet (artifacts, scheduled tasks,
 * coding agents, MCP servers, skills, provider settings). The Chat view is the
 * only one wired to the real server — see views/ChatView.tsx.
 */

export type Status =
  | "Running"
  | "Connected"
  | "Active"
  | "Deployed"
  | "Done"
  | "Fresh"
  | "Failed"
  | "Blocked"
  | "Draft"
  | "Shared"
  | "Review"
  | "Paused"
  | "Auth required"
  | "Not connected";

export interface Conversation {
  id: string;
  title: string;
  preview?: string;
  time: string;
}

export const convToday: Conversation[] = [
  { id: "c1", title: "July investor update", preview: "Chart WAU, draft memo", time: "2m" },
  { id: "c2", title: "Refactor auth module", preview: "Split session + token logic", time: "1h" },
  { id: "c3", title: "Q3 board deck outline", preview: "18 slides from update doc", time: "3h" },
];

export const convYesterday: Conversation[] = [
  { id: "c4", title: "Postgres migration plan", time: "1d" },
  { id: "c5", title: "Customer churn analysis", time: "1d" },
  { id: "c6", title: "Landing page copy pass", time: "1d" },
];

export interface ModelOption {
  name: string;
  note: string;
}

export const models: ModelOption[] = [
  { name: "pi-2 Sonnet", note: "Balanced · 200k ctx" },
  { name: "pi-2 Opus", note: "Deep reasoning · slow" },
  { name: "pi-2 Mini", note: "Fast · cheap" },
  { name: "pi-code-1", note: "Coding + tools" },
];

export interface Artifact {
  type: string;
  title: string;
  desc: string;
  meta: string;
  status: Status;
}

export const artifacts: Artifact[] = [
  { type: "React App", title: "WAU Dashboard", desc: "Weekly active users with cohort + retention filter.", meta: "v3 · edited 2m ago", status: "Deployed" },
  { type: "Document", title: "Q3 Investor Update", desc: "Narrative draft with embedded live metrics.", meta: "v7 · edited 1h ago", status: "Draft" },
  { type: "Dataset", title: "signups_2026.csv", desc: "42,318 rows pulled from postgres-prod.", meta: "edited yesterday", status: "Fresh" },
  { type: "Chart", title: "Churn by Plan", desc: "Stacked area, monthly, last 12 months.", meta: "v2 · 2d ago", status: "Shared" },
  { type: "Web App", title: "Pricing Simulator", desc: "Interactive slider model for CFO review.", meta: "v5 · 3d ago", status: "Deployed" },
  { type: "Slide Deck", title: "Board Deck — July", desc: "18 slides generated from the update doc.", meta: "v1 · 4d ago", status: "Review" },
];

export interface ScheduledTask {
  name: string;
  schedule: string;
  cadence: string;
  last: string;
  next: string;
  status: Status;
}

export const schedules: ScheduledTask[] = [
  { name: "Daily metrics digest", schedule: "0 8 * * *", cadence: "Every day · 08:00", last: "Today 08:00", next: "Tomorrow 08:00", status: "Active" },
  { name: "Warehouse sync", schedule: "*/30 * * * *", cadence: "Every 30 min", last: "12m ago", next: "in 18m", status: "Active" },
  { name: "Churn model retrain", schedule: "0 3 * * 1", cadence: "Weekly · Mon 03:00", last: "Mon 03:00", next: "in 5d", status: "Active" },
  { name: "Competitor news scan", schedule: "0 */6 * * *", cadence: "Every 6 hours", last: "2h ago", next: "paused", status: "Paused" },
  { name: "Support triage sweep", schedule: "*/15 9-18 * * *", cadence: "15 min · work hrs", last: "8m ago", next: "in 7m", status: "Active" },
  { name: "Nightly test agent", schedule: "0 2 * * *", cadence: "Every day · 02:00", last: "02:00", next: "retry queued", status: "Failed" },
];

export interface TaskRun {
  time: string;
  dur: string;
  tokens: string;
  out: string;
  status: Status;
}

export const taskRuns: TaskRun[] = [
  { time: "Today · 08:00", dur: "4.2s", tokens: "12.4k", out: "metrics_digest.md", status: "Done" },
  { time: "Yesterday · 08:00", dur: "3.9s", tokens: "11.8k", out: "metrics_digest.md", status: "Done" },
  { time: "Jul 9 · 08:00", dur: "5.1s", tokens: "13.1k", out: "metrics_digest.md", status: "Done" },
  { time: "Jul 8 · 08:00", dur: "—", tokens: "2.1k", out: "timeout: warehouse unreachable", status: "Failed" },
  { time: "Jul 7 · 08:00", dur: "4.0s", tokens: "12.0k", out: "metrics_digest.md", status: "Done" },
];

export interface McpServer {
  name: string;
  transport: string;
  tools: number;
  latency: string;
  status: Status;
}

export const servers: McpServer[] = [
  { name: "postgres-prod", transport: "stdio", tools: 8, latency: "42ms", status: "Connected" },
  { name: "github", transport: "HTTP", tools: 23, latency: "88ms", status: "Connected" },
  { name: "linear", transport: "HTTP", tools: 14, latency: "110ms", status: "Connected" },
  { name: "filesystem", transport: "stdio", tools: 6, latency: "3ms", status: "Connected" },
  { name: "brave-search", transport: "HTTP", tools: 2, latency: "204ms", status: "Connected" },
  { name: "slack", transport: "HTTP", tools: 11, latency: "—", status: "Auth required" },
];

export interface Skill {
  name: string;
  desc: string;
  trigger: string;
  uses: string;
  tag: string;
}

export const skillsList: Skill[] = [
  { name: "chart-builder", desc: "Turn a dataset into a labelled chart artifact.", trigger: "Auto · on data", uses: "214", tag: "Data" },
  { name: "investor-update", desc: "Draft a structured investor memo from metrics.", trigger: "Manual", uses: "37", tag: "Writing" },
  { name: "sql-explain", desc: "Explain and optimize a Postgres query plan.", trigger: "Auto · on SQL", uses: "96", tag: "Data" },
  { name: "pr-reviewer", desc: "Review a diff and leave inline comments.", trigger: "On PR open", uses: "340", tag: "Coding" },
  { name: "deep-research", desc: "Multi-source web research with citations.", trigger: "Manual", uses: "128", tag: "Research" },
  { name: "slide-smith", desc: "Compose a slide deck from a source document.", trigger: "Manual", uses: "52", tag: "Writing" },
];

export interface CodeRun {
  repo: string;
  branch: string;
  task: string;
  status: Status;
  added: string;
  removed: string;
  step: string;
}

export const codeRuns: CodeRun[] = [
  { repo: "pi-agent-web", branch: "feat/wau-panel", task: "Add cohort filter to WAU dashboard", status: "Running", added: "+218", removed: "−64", step: "Editing DashboardPanel.tsx · step 7 / 11" },
  { repo: "billing-svc", branch: "fix/proration", task: "Fix mid-cycle proration rounding", status: "Review", added: "+41", removed: "−12", step: "Opened PR #482 · tests passing" },
  { repo: "pi-agent-web", branch: "chore/deps", task: "Bump dependencies & fix types", status: "Done", added: "+9", removed: "−9", step: "Merged 20m ago" },
  { repo: "infra", branch: "feat/cron-agents", task: "Provision scheduled-agent workers", status: "Blocked", added: "+130", removed: "−4", step: "Waiting on approval · terraform plan" },
];

export interface Provider {
  name: string;
  note: string;
  status: Status;
  models: number;
  url: string;
}

export const providersList: Provider[] = [
  { name: "pi Cloud", note: "Native · hosted", status: "Connected", models: 6, url: "api.pi.dev" },
  { name: "OpenAI", note: "", status: "Connected", models: 14, url: "api.openai.com/v1" },
  { name: "Anthropic", note: "", status: "Connected", models: 8, url: "api.anthropic.com" },
  { name: "Ollama", note: "Local runtime", status: "Connected", models: 11, url: "localhost:11434" },
  { name: "Google Vertex", note: "", status: "Not connected", models: 0, url: "—" },
  { name: "Mistral", note: "", status: "Not connected", models: 0, url: "—" },
  { name: "OpenRouter", note: "", status: "Not connected", models: 0, url: "—" },
];

export const filterConfig: Record<string, { heading: string; items: [string, string][] }> = {
  artifacts: { heading: "Type", items: [["All", "24"], ["Apps", "7"], ["Documents", "9"], ["Charts", "5"], ["Datasets", "3"]] },
  scheduled: { heading: "Status", items: [["All", "6"], ["Active", "4"], ["Paused", "1"], ["Failed", "1"]] },
  coding: { heading: "Repository", items: [["pi-agent-web", "2"], ["billing-svc", "1"], ["infra", "1"]] },
  mcp: { heading: "Category", items: [["All", "6"], ["Databases", "1"], ["Search", "1"], ["DevOps", "2"], ["Files", "1"]] },
  skills: { heading: "Category", items: [["All", "24"], ["Writing", "6"], ["Data", "8"], ["Coding", "5"], ["Research", "5"]] },
};

export const bars = [42.3, 43.1, 44.8, 45.2, 47.9, 48.9, 51.9].map((v, i, arr) => ({
  label: `w${i + 1}`,
  value: v,
  isLast: i === arr.length - 1,
}));
