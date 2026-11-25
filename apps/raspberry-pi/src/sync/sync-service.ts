import {
  EventSeverity,
  EventType,
  systemSettingsFromRow,
  type SyncItem,
  type SyncStatusReport,
  type SystemSettings,
  type SystemSettingsRow,
} from '@calc-rental/shared';
import type { BackendClient } from '../backend/client';
import type { KioskStore, PullSummary } from '../db/kiosk-store';
import { getLocalConfig, setLocalConfig } from '../db/sqlite';

/**
 * Two-way sync between the kiosk's SQLite database and Supabase (Phase 12).
 *
 *   push()  outbox → Supabase, oldest first, in batches. Stops at the first
 *           item Supabase refuses (it is retried with back-off: 10 s … 10 min;
 *           after `maxAttempts` it is set aside and a CRITICAL event is logged).
 *   pull()  officer data → kiosk: settings, lockers, calculators (always
 *           complete), students and penalties (only what changed, paged).
 *
 * Works offline-first: the kiosk never waits for sync. When the network is
 * down, changes simply stay in the outbox until it comes back.
 */

export type SyncTransport = Pick<BackendClient, 'syncPush' | 'syncPull'>;

export interface SyncOptions {
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
  /** Outbox items per request. */
  batchSize?: number;
  /** Attempts before an item is set aside. */
  maxAttempts?: number;
  pushIntervalMs?: number;
  pullIntervalMs?: number;
  /** Synced outbox rows are deleted after this many days. */
  keepSyncedDays?: number;
}

const CURSOR_STUDENTS = 'sync_cursor_students';
const CURSOR_PENALTIES = 'sync_cursor_penalties';
/** Safety limit for one push/pull run (the next run continues). */
const MAX_ROUNDS = 20;

export class SyncService {
  private pushing = false;
  private pulling = false;
  private timers: NodeJS.Timeout[] = [];
  private lastPushAt: string | null = null;
  private lastPullAt: string | null = null;
  private lastError: string | null = null;
  private readonly now: () => Date;
  private readonly log: NonNullable<SyncOptions['log']>;
  private readonly batchSize: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly store: KioskStore,
    private readonly transport: SyncTransport,
    private readonly options: SyncOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.batchSize = options.batchSize ?? 50;
    this.maxAttempts = options.maxAttempts ?? 20;
  }

  /** Sends pending outbox items until the queue is empty, an item is refused, or the network fails. */
  async push(): Promise<{ sent: number; ok: boolean }> {
    if (this.pushing) return { sent: 0, ok: true };
    this.pushing = true;
    let sent = 0;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const now = this.now();
        const batch = this.store.nextSyncBatch(this.batchSize, now.toISOString());
        if (batch.length === 0) break;

        const items: SyncItem[] = batch.map((b) => ({ seq: b.seq, entity: b.entity, payload: JSON.parse(b.payload) as Record<string, unknown> }));
        const result = await this.transport.syncPush({ items });
        if (!result.ok) {
          this.noteError(`push: ${result.message}`);
          return { sent, ok: false };
        }

        const reply = result.data;
        if (reply.appliedThroughSeq !== null) {
          this.store.markSynced(reply.appliedThroughSeq, now.toISOString());
          sent += reply.applied;
        }
        if (reply.failure) {
          const { seq, entity, message } = reply.failure;
          const { attempts, gaveUp } = this.store.markSyncFailure(seq, message, now, this.maxAttempts);
          this.noteError(`outbox item ${seq} (${entity}) refused: ${message}`);
          if (gaveUp) {
            this.store.recordEvent({
              type: EventType.SYNC_FAILED,
              severity: EventSeverity.CRITICAL,
              message: `Gave up syncing outbox item ${seq} (${entity}) after ${attempts} attempts`,
              payload: { seq, entity, error: message },
              occurredAt: now.toISOString(),
            });
            this.log('error', 'Outbox item set aside after too many attempts', { seq, entity, error: message });
          }
          return { sent, ok: false };
        }

        this.lastPushAt = now.toISOString();
        this.clearError();
        if (batch.length < this.batchSize) break;
      }
      return { sent, ok: true };
    } finally {
      this.pushing = false;
    }
  }

  /** Applies officer data from Supabase (one or more pages). */
  async pull(): Promise<{ ok: boolean; summary: PullSummary | null }> {
    if (this.pulling) return { ok: true, summary: null };
    this.pulling = true;
    const total: PullSummary = { settingsChanged: false, lockers: 0, calculators: 0, students: 0, penalties: 0, warnings: [] };
    try {
      let cursors = {
        students: getLocalConfig(this.store.db, CURSOR_STUDENTS),
        penalties: getLocalConfig(this.store.db, CURSOR_PENALTIES),
      };
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const result = await this.transport.syncPull(cursors);
        if (!result.ok) {
          this.noteError(`pull: ${result.message}`);
          return { ok: false, summary: null };
        }
        const reply = result.data;
        const nowIso = this.now().toISOString();

        let settings: SystemSettings | null = null;
        try {
          settings = systemSettingsFromRow(reply.settings as unknown as SystemSettingsRow);
        } catch {
          this.log('warn', 'Settings from the dashboard were not valid; keeping the current ones');
        }
        const summary = this.store.applyPull(reply, settings, nowIso);
        total.settingsChanged ||= summary.settingsChanged;
        total.lockers += summary.lockers;
        total.calculators += summary.calculators;
        total.students += summary.students;
        total.penalties += summary.penalties;
        total.warnings.push(...summary.warnings);

        cursors = reply.cursors;
        this.store.transaction(() => {
          if (cursors.students) setLocalConfig(this.store.db, CURSOR_STUDENTS, cursors.students);
          if (cursors.penalties) setLocalConfig(this.store.db, CURSOR_PENALTIES, cursors.penalties);
        });
        if (!reply.hasMore) break;
      }

      this.lastPullAt = this.now().toISOString();
      this.clearError();
      const changed = total.settingsChanged || total.lockers + total.calculators + total.students + total.penalties > 0;
      if (changed) {
        this.log('info', 'Applied changes from the dashboard', {
          settings: total.settingsChanged,
          lockers: total.lockers,
          calculators: total.calculators,
          students: total.students,
          penalties: total.penalties,
        });
      }
      for (const warning of total.warnings) this.log('warn', `Sync: could not apply ${warning}`);
      return { ok: true, summary: total };
    } finally {
      this.pulling = false;
    }
  }

  /** Removes synced outbox rows older than `keepSyncedDays`. */
  prune(): number {
    const days = this.options.keepSyncedDays ?? 7;
    return this.store.pruneSynced(new Date(this.now().getTime() - days * 86_400_000).toISOString());
  }

  /** Reported with every heartbeat and shown on the Devices page. */
  status(): SyncStatusReport {
    return {
      lastPushAt: this.lastPushAt,
      lastPullAt: this.lastPullAt,
      lastError: this.lastError,
      failedItems: this.store.failedSyncCount(),
    };
  }

  /** Pull first (fresh settings and lockers), then push; then keep both going on timers. */
  start(): void {
    void this.pull().then(() => this.push());
    this.prune();
    this.timers.push(setInterval(() => void this.push(), this.options.pushIntervalMs ?? 10_000));
    this.timers.push(setInterval(() => void this.pull(), this.options.pullIntervalMs ?? 60_000));
    this.timers.push(setInterval(() => this.prune(), 6 * 3_600_000));
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private noteError(message: string) {
    if (message !== this.lastError) this.log('warn', `Sync: ${message} (the kiosk keeps working; it will retry)`);
    this.lastError = message.slice(0, 500);
  }

  private clearError() {
    if (this.lastError) this.log('info', 'Sync recovered');
    this.lastError = null;
  }
}
