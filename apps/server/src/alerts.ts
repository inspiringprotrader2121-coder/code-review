type AlertSeverity = 'warning' | 'critical';

const recentAlerts = new Map<string, number>();
const inFlightAlerts = new Set<string>();
const ALERT_DEDUP_MS = 15 * 60_000;

/**
 * Optional operator-owned alert sink. Keeping this best-effort prevents an
 * unavailable monitoring service from changing review or billing behavior.
 * The event key is locally deduplicated so a retry loop cannot page repeatedly.
 */
export async function sendOperationalAlert(
  input: {
    event: string;
    severity: AlertSeverity;
    message: string;
  },
  webhookUrl?: string,
): Promise<boolean> {
  const url = webhookUrl?.trim();
  if (!url) return false;
  const now = Date.now();
  const previous = recentAlerts.get(input.event);
  if (previous !== undefined && now - previous < ALERT_DEDUP_MS) return false;
  if (inFlightAlerts.has(input.event)) return false;
  inFlightAlerts.add(input.event);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'orvex',
        event: input.event,
        severity: input.severity,
        message: input.message.slice(0, 2_000),
        occurredAt: new Date(now).toISOString(),
      }),
    });
    if (!response.ok) {
      console.error(`[alert] ${input.event}: webhook returned HTTP ${response.status}`);
      return false;
    }
    recentAlerts.set(input.event, now);
    return true;
  } catch (err) {
    console.error(`[alert] ${input.event}: webhook delivery failed:`, (err as Error).message);
    return false;
  } finally {
    inFlightAlerts.delete(input.event);
    clearTimeout(timer);
  }
}
