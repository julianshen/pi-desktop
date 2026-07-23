const SAFE_SCHEDULED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeScheduledId(value: string): boolean {
  return SAFE_SCHEDULED_ID.test(value);
}

export function assertSafeScheduledId(value: string, label: string): void {
  if (!isSafeScheduledId(value)) throw new Error(`Invalid ${label}`);
}
