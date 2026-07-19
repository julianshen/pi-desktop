export type CountBucket = "0" | "1" | "2_5" | "6_10" | "11_plus";
export type DurationBucket = "under_1s" | "1_10s" | "10_60s" | "over_60s";
export type SizeBucket = "under_1mib" | "1_10mib" | "10_25mib" | "over_25mib" | "unknown";

export type ServerAnalyticsEvent =
  | { name: "chat_turn_terminal"; properties: { outcome: "completed" | "stopped" | "failed"; retryable: boolean; model_provider: string; duration_bucket: DurationBucket } }
  | { name: "chat_attachment_dispositioned"; properties: { outcome: "sent" | "rejected" | "missing" | "local_only"; media_category: string; size_bucket: SizeBucket; reason_code?: string } }
  | { name: "web_search_run_completed"; properties: { provider: string; outcome: "success" | "not_configured" | "rate_limited" | "failed"; result_count_bucket: CountBucket; latency_bucket: DurationBucket } };

export type DispatchedServerAnalyticsEvent = ServerAnalyticsEvent & { platform: "server" };
type EventSink = (event: DispatchedServerAnalyticsEvent) => void;
let sink: EventSink = () => {};

const sensitive = new Set(["prompt", "content", "query", "url", "key", "filename", "path", "hash"]);

function assertPrivate(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    if ([...sensitive].some((field) => normalized.includes(field))) {
      throw new Error(`Analytics field is forbidden: ${key}`);
    }
    assertPrivate(nested);
  }
}

export function setServerAnalyticsSink(next?: EventSink): void { sink = next ?? (() => {}); }

export function trackServerEvent(event: ServerAnalyticsEvent): void {
  assertPrivate(event.properties);
  sink({ ...event, platform: "server" });
}

export function countBucket(count: number): CountBucket {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2_5";
  if (count <= 10) return "6_10";
  return "11_plus";
}

export function durationBucket(milliseconds: number): DurationBucket {
  if (milliseconds < 1_000) return "under_1s";
  if (milliseconds < 10_000) return "1_10s";
  if (milliseconds < 60_000) return "10_60s";
  return "over_60s";
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
  if (mediaType.startsWith("text/") || mediaType.includes("json") || mediaType.includes("yaml")) return "text";
  return "other";
}
