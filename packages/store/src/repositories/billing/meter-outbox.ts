import type { StripeMeterEvent } from '../../types.js';
import type { BillingConnection } from './shared.js';

/** Durable Stripe meter outbox. Provider delivery and retry policy live above the store. */
export class SqliteStripeMeterOutboxRepository {
  constructor(private readonly db: BillingConnection) {}

  enqueueStripeMeterEvent(input: {
    runId: string;
    tenantId: string;
    customerId: string;
    eventName: string;
    plan: string;
    units: number;
  }): StripeMeterEvent {
    const eventName = input.eventName.trim();
    if (!eventName) throw new Error('Stripe meter event name cannot be blank');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO stripe_meter_events
       (run_id, tenant_id, customer_id, event_name, plan, units, status, attempts,
        last_error, next_attempt_at, reported_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        input.runId,
        input.tenantId,
        input.customerId,
        eventName,
        input.plan,
        Math.max(0, Math.floor(input.units)),
        now,
        now,
      );
    return this.getStripeMeterEvent(input.runId)!;
  }

  getStripeMeterEvent(runId: string): StripeMeterEvent | null {
    const row = this.db.prepare(`SELECT * FROM stripe_meter_events WHERE run_id = ?`).get(runId) as
      | MeterRow
      | undefined;
    return row ? mapMeter(row) : null;
  }

  listPendingStripeMeterEvents(limit = 50): StripeMeterEvent[] {
    const rows = this.db
      .prepare(
        `SELECT run_id FROM stripe_meter_events
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC LIMIT ?`,
      )
      .all(new Date().toISOString(), Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{
      run_id: string;
    }>;
    return rows.map((row) => this.getStripeMeterEvent(row.run_id)!).filter(Boolean);
  }

  markStripeMeterAttempt(runId: string, error: string, nextAttemptAt: string): void {
    this.db
      .prepare(
        `UPDATE stripe_meter_events
       SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
       WHERE run_id = ? AND status = 'pending'`,
      )
      .run(error.slice(0, 1000), nextAttemptAt, new Date().toISOString(), runId);
  }

  setStripeMeterEventName(runId: string, eventName: string): void {
    const normalized = eventName.trim();
    if (!normalized) throw new Error('Stripe meter event name cannot be blank');
    this.db
      .prepare(
        `UPDATE stripe_meter_events SET event_name = ?, updated_at = ? WHERE run_id = ? AND status = 'pending'`,
      )
      .run(normalized, new Date().toISOString(), runId);
  }

  markStripeMeterReported(runId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE stripe_meter_events
       SET status = 'reported', reported_at = ?, last_error = NULL, next_attempt_at = NULL, updated_at = ?
       WHERE run_id = ? AND status = 'pending'`,
      )
      .run(now, now, runId);
  }
}

interface MeterRow {
  run_id: string;
  tenant_id: string;
  customer_id: string;
  event_name: string;
  plan: string;
  units: number;
  status: 'pending' | 'reported';
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  reported_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapMeter(row: MeterRow): StripeMeterEvent {
  return {
    runId: row.run_id,
    tenantId: row.tenant_id,
    customerId: row.customer_id,
    eventName: row.event_name,
    plan: row.plan,
    units: row.units,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    nextAttemptAt: row.next_attempt_at ?? undefined,
    reportedAt: row.reported_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
