export type LogLevel = "info" | "warn" | "error";

export function logJson(
  level: LogLevel,
  message: string,
  fields?: Record<string, string | number | boolean | null | undefined>
): void {
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.log(payload);
  }
}
