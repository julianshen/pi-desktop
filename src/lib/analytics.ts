export type CountBucket = "0" | "1" | "2_5" | "6_20" | "21_100" | "101_plus";
export type SizeBucket = "under_1mib" | "1_10mib" | "10_25mib" | "over_25mib" | "unknown";

export type DesktopAnalyticsEvent =
  | { name: "conversation_restored"; properties: { outcome: "success" | "failed"; had_active_run: boolean; message_count_bucket: CountBucket } }
  | { name: "agent_run_restored"; properties: { outcome: "success" | "failed"; prior_status: string; replayed_event_count_bucket: CountBucket } }
  | { name: "generated_file_save_terminal"; properties: { outcome: "saved" | "cancelled" | "failed"; media_category: string; size_bucket: SizeBucket } };

export type DispatchedDesktopAnalyticsEvent = DesktopAnalyticsEvent & { platform: "desktop" };
type Sink = (event: DispatchedDesktopAnalyticsEvent) => void;
let sink: Sink = () => {};
const denied = ["prompt", "content", "query", "url", "key", "filename", "path", "hash"];

function assertPrivate(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    if (denied.some((field) => normalized.includes(field))) throw new Error(`Analytics field is forbidden: ${key}`);
    assertPrivate(nested);
  }
}

export function setDesktopAnalyticsSink(next?: Sink): void { sink = next ?? (() => {}); }
export function trackDesktopEvent(event: DesktopAnalyticsEvent): void {
  assertPrivate(event.properties);
  sink({ ...event, platform: "desktop" });
}

export function countBucket(count: number): CountBucket {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2_5";
  if (count <= 20) return "6_20";
  if (count <= 100) return "21_100";
  return "101_plus";
}

export function sizeBucket(bytes?: number): SizeBucket {
  if (bytes === undefined) return "unknown";
  if (bytes < 1024 * 1024) return "under_1mib";
  if (bytes < 10 * 1024 * 1024) return "1_10mib";
  if (bytes <= 25 * 1024 * 1024) return "10_25mib";
  return "over_25mib";
}

export function mediaCategory(mediaType?: string): string {
  if (!mediaType) return "unknown";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "application/pdf") return "document";
  if (mediaType.startsWith("text/")) return "text";
  return "other";
}
