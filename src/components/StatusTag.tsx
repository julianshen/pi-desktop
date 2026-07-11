import type { Status } from "../data/mockData";

const RUNNING_COLOR = "var(--color-accent)";
const OK_COLOR = "var(--color-accent)";
const BAD_COLOR = "#b4463f";
const NEUTRAL_COLOR = "var(--color-neutral-500)";

const OK_STATUSES = new Set(["Connected", "Active", "Deployed", "Done", "Fresh"]);
const BAD_STATUSES = new Set(["Failed", "Blocked"]);

export function StatusTag({ status }: { status: Status }) {
  let color = NEUTRAL_COLOR;
  let pulse = false;
  let tagClass = "tag tag-neutral";

  if (status === "Running") {
    color = RUNNING_COLOR;
    pulse = true;
    tagClass = "tag tag-accent";
  } else if (OK_STATUSES.has(status)) {
    color = OK_COLOR;
    tagClass = "tag tag-accent";
  } else if (BAD_STATUSES.has(status)) {
    color = BAD_COLOR;
  }

  return (
    <span className={tagClass}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
          flex: "none",
          display: "inline-block",
          marginRight: 5,
          ...(pulse ? { animation: "pulse 1.4s ease-in-out infinite" } : {}),
        }}
      />
      {status}
    </span>
  );
}
