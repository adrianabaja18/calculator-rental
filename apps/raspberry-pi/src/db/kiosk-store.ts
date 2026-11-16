import { randomUUID } from 'node:crypto';
import {
  OPEN_RENTAL_STATUSES,
  SystemSettingsSchema,
  type CalculatorCondition,
  type CalculatorStatus,
  type EventSeverity,
  type EventType,
  type LockState,
  type LockerSnapshot,
  type LockerStatus,
  type RentalStatus,
  type RfidState,
  type StudentStatus,
  type SystemSettings,
} from '@calc-rental/shared';
import type { LocalDatabase } from './sqlite';

/**
 * Data access for the kiosk's SQLite database (SQLite-first).
 *
 * Every method that changes data also appends to `sync_queue` IN THE SAME
 * TRANSACTION (outbox pattern), so a change can never be saved locally
 * without also being scheduled for upload to Supabase.
 *
 * Only this file writes SQL; the rental service works with typed objects.
 */

export interface StudentRecord {
  id: string;
  student_number: string;
  full_name: string;
  course_program: string;
  status: StudentStatus;
  blocked_reason: string | null;
  qr_identifier: string | null;
  last_transaction_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RentalRecord {
  id: string;
  transaction_code: string;
  student_id: string;
  calculator_id: string;
  locker_id: string;
  status: RentalStatus;
  rental_fee_centavos: number;
  amount_paid_centavos: number;
  rental_duration_minutes: number;
  settings_snapshot: string;
  reserved_at: string;
  payment_expires_at: string | null;
  paid_at: string | null;
  rented_at: string | null;
  due_at: string | null;
  return_started_at: string | null;
  returned_at: string | null;
  ended_at: string | null;
  was_overdue: number;
  overdue_minutes: number;
  rental_rfid_verified: number;
  return_rfid_verified: number;
  return_rfid_uid: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentRecord {
  id: string;
  rental_id: string;
  student_id: string;
  payment_type: 'RENTAL' | 'PENALTY' | 'MANUAL_ADJUSTMENT';
  method: 'COIN' | 'CASH' | 'GCASH' | 'OTHER';
  required_centavos: number;
  received_centavos: number;
  status: 'PENDING' | 'PARTIAL' | 'PAID' | 'CANCELLED' | 'REFUNDED';
  session_id: string;
  penalty_id: string | null;
  expires_at: string | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PenaltyRecord {
  id: string;
  rental_id: string | null;
  student_id: string;
  reason: 'OVERDUE' | 'DAMAGE' | 'LOST' | 'OTHER';
  overdue_minutes: number;
  calculated_centavos: number;
  amount_paid_centavos: number;
  /** Remaining balance (calculated − paid). */
  amount_due_centavos: number;
  status: 'UNPAID' | 'PARTIAL' | 'PAID' | 'WAIVED';
  paid_at: string | null;
  updated_at: string;
}

export type SyncEntity = 'student' | 'rental' | 'device_event' | 'coin_event' | 'payment' | 'locker_state' | 'penalty';

const OPEN_LIST = OPEN_RENTAL_STATUSES.map((s) => `'${s}'`).join(', ');

export class KioskStore {
  constructor(readonly db: LocalDatabase) {}

  /** Runs `fn` atomically: everything inside commits together or not at all. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------------------------------------------------------------- settings
  getSettings(): SystemSettings | null {
    const row = this.db.prepare('SELECT data FROM settings WHERE id = 1').get() as { data: string } | undefined;
    if (!row) return null;
    const parsed = SystemSettingsSchema.safeParse(JSON.parse(row.data));
    return parsed.success ? parsed.data : null;
  }

  saveSettings(settings: SystemSettings, nowIso: string): void {
    const data = JSON.stringify(SystemSettingsSchema.parse(settings));
    this.db
      .prepare(
        `INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(data, nowIso);
  }

  // ---------------------------------------------------------------- students
  findStudentByNumber(studentNumber: string): StudentRecord | null {
    return (this.db.prepare('SELECT * FROM students WHERE student_number = ?').get(studentNumber) as StudentRecord) ?? null;
  }

  insertStudent(student: Omit<StudentRecord, 'created_at' | 'updated_at' | 'last_transaction_at'>, nowIso: string): StudentRecord {
    this.db
      .prepare(
        `INSERT INTO students (id, student_number, full_name, course_program, status, blocked_reason, qr_identifier, created_at, updated_at)
         VALUES (@id, @student_number, @full_name, @course_program, @status, @blocked_reason, @qr_identifier, @now, @now)`,
      )
      .run({ ...student, now: nowIso });
    const saved = this.findStudentByNumber(student.student_number)!;
    this.enqueue('student', saved.id, saved);
    return saved;
  }

  /** Keeps name/course in sync with the latest ID scan (status is owned by officers). */
  refreshStudentFromQr(id: string, fields: { full_name: string; course_program: string; qr_identifier: string }, nowIso: string): StudentRecord {
    const changed = this.db
      .prepare(
        `UPDATE students SET full_name = @full_name, course_program = @course_program, qr_identifier = @qr_identifier, updated_at = @now
         WHERE id = @id AND (full_name <> @full_name OR course_program <> @course_program OR IFNULL(qr_identifier, '') <> @qr_identifier)`,
      )
      .run({ id, ...fields, now: nowIso }).changes;
    const saved = this.db.prepare('SELECT * FROM students WHERE id = ?').get(id) as StudentRecord;
    if (changed) this.enqueue('student', id, saved);
    return saved;
  }

  touchStudentTransaction(id: string, nowIso: string): void {
    this.db.prepare('UPDATE students SET last_transaction_at = ?, updated_at = ? WHERE id = ?').run(nowIso, nowIso, id);
    this.enqueue('student', id, this.db.prepare('SELECT * FROM students WHERE id = ?').get(id));
  }

  // ---------------------------------------------------------------- penalties
  getUnpaidPenaltyCentavos(studentId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(amount_due_centavos), 0) AS total FROM penalties WHERE student_id = ? AND status IN ('UNPAID', 'PARTIAL')`)
      .get(studentId) as { total: number };
    return row.total;
  }

  // ---------------------------------------------------------------- rentals
  getRental(id: string): RentalRecord | null {
    return (this.db.prepare('SELECT * FROM rentals WHERE id = ?').get(id) as RentalRecord) ?? null;
  }

  getOpenRentalForStudent(studentId: string): RentalRecord | null {
    return (
      (this.db.prepare(`SELECT * FROM rentals WHERE student_id = ? AND status IN (${OPEN_LIST})`).get(studentId) as RentalRecord) ??
      null
    );
  }

  insertRental(rental: RentalRecord): void {
    this.db
      .prepare(
        `INSERT INTO rentals (${Object.keys(rental).join(', ')})
         VALUES (${Object.keys(rental).map((k) => `@${k}`).join(', ')})`,
      )
      .run(rental);
    this.enqueue('rental', rental.id, this.getRental(rental.id));
  }

  /**
   * Changes a rental ONLY if it is still in `expectedStatus` (optimistic
   * locking): a duplicate or late request can't apply the same step twice.
   * Returns false if someone else already moved it.
   */
  updateRental(id: string, expectedStatus: RentalStatus, changes: Partial<RentalRecord>): boolean {
    const keys = Object.keys(changes);
    const result = this.db
      .prepare(`UPDATE rentals SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id AND status = @__expected`)
      .run({ ...changes, __id: id, __expected: expectedStatus });
    if (result.changes === 0) return false;
    this.enqueue('rental', id, this.getRental(id));
    return true;
  }

  // ---------------------------------------------------------------- lockers & calculators
  /** Everything the availability rule needs, in one query. */
  getLockerSnapshots(): LockerSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT l.id, l.locker_number, l.status, l.lock_state, l.rfid_state, l.last_detected_rfid_uid,
                c.id AS calc_id, c.code AS calc_code, c.rfid_uid AS calc_rfid_uid, c.status AS calc_status, c.condition AS calc_condition,
                EXISTS (SELECT 1 FROM rentals r WHERE (r.locker_id = l.id OR r.calculator_id = c.id) AND r.status IN (${OPEN_LIST})) AS has_open_rental
         FROM lockers l
         LEFT JOIN calculators c ON c.locker_id = l.id
         ORDER BY l.locker_number`,
      )
      .all() as Array<{
      id: string;
      locker_number: number;
      status: LockerStatus;
      lock_state: LockState;
      rfid_state: RfidState;
      last_detected_rfid_uid: string | null;
      calc_id: string | null;
      calc_code: string | null;
      calc_rfid_uid: string | null;
      calc_status: CalculatorStatus | null;
      calc_condition: CalculatorCondition | null;
      has_open_rental: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      lockerNumber: r.locker_number,
      status: r.status,
      lockState: r.lock_state,
      rfidState: r.rfid_state,
      detectedRfidUid: r.last_detected_rfid_uid,
      hasOpenRental: r.has_open_rental === 1,
      calculator: r.calc_id
        ? {
            id: r.calc_id,
            code: r.calc_code!,
            rfidUid: r.calc_rfid_uid!,
            status: r.calc_status!,
            condition: r.calc_condition!,
          }
        : null,
    }));
  }

  setLockerStatus(lockerId: string, status: LockerStatus, nowIso: string): void {
    this.db.prepare('UPDATE lockers SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso, lockerId);
    this.enqueue('locker_state', lockerId, this.db.prepare('SELECT * FROM lockers WHERE id = ?').get(lockerId));
  }

  /** Records what the locker's sensors report (called by the hardware layer, Phase 9/11). */
  setLockerSensors(
    lockerId: string,
    sensors: { lockState?: LockState; rfidState?: RfidState; detectedRfidUid?: string | null },
    nowIso: string,
  ): void {
    this.db
      .prepare(
        `UPDATE lockers SET
           lock_state = COALESCE(@lockState, lock_state),
           rfid_state = COALESCE(@rfidState, rfid_state),
           last_detected_rfid_uid = CASE WHEN @setUid = 1 THEN @detectedRfidUid ELSE last_detected_rfid_uid END,
           last_seen_at = @now, updated_at = @now
         WHERE id = @lockerId`,
      )
      .run({
        lockerId,
        lockState: sensors.lockState ?? null,
        rfidState: sensors.rfidState ?? null,
        setUid: sensors.detectedRfidUid === undefined ? 0 : 1,
        detectedRfidUid: sensors.detectedRfidUid ?? null,
        now: nowIso,
      });
  }

  setCalculatorStatus(calculatorId: string, status: CalculatorStatus, nowIso: string): void {
    this.db.prepare('UPDATE calculators SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso, calculatorId);
  }

  getCalculatorRfidUid(calculatorId: string): string | null {
    const row = this.db.prepare('SELECT rfid_uid FROM calculators WHERE id = ?').get(calculatorId) as { rfid_uid: string } | undefined;
    return row?.rfid_uid ?? null;
  }

  // ---------------------------------------------------------------- payments
  getPaymentBySession(sessionId: string): PaymentRecord | null {
    return (this.db.prepare('SELECT * FROM payments WHERE session_id = ?').get(sessionId) as PaymentRecord) ?? null;
  }

  getLivePaymentForRental(rentalId: string): PaymentRecord | null {
    return (
      (this.db
        .prepare(`SELECT * FROM payments WHERE rental_id = ? AND payment_type = 'RENTAL' AND status <> 'CANCELLED'`)
        .get(rentalId) as PaymentRecord) ?? null
    );
  }

  insertPayment(payment: Omit<PaymentRecord, 'paid_at' | 'notes'>): PaymentRecord {
    this.db
      .prepare(
        `INSERT INTO payments (id, rental_id, student_id, payment_type, method, required_centavos, received_centavos, status, session_id, penalty_id, expires_at, created_at, updated_at)
         VALUES (@id, @rental_id, @student_id, @payment_type, @method, @required_centavos, @received_centavos, @status, @session_id, @penalty_id, @expires_at, @created_at, @updated_at)`,
      )
      .run(payment);
    const saved = this.getPaymentBySession(payment.session_id)!;
    this.enqueue('payment', saved.id, saved);
    return saved;
  }

  /** Same optimistic guard as updateRental: only applies if still in `expectedStatus`. */
  updatePayment(id: string, expectedStatus: PaymentRecord['status'], changes: Partial<PaymentRecord>): boolean {
    const keys = Object.keys(changes);
    const result = this.db
      .prepare(`UPDATE payments SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id AND status = @__expected`)
      .run({ ...changes, __id: id, __expected: expectedStatus });
    if (result.changes === 0) return false;
    this.enqueue('payment', id, this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id));
    return true;
  }

  /** Returns false if this coin event was already recorded (duplicate). */
  insertCoinEvent(coin: {
    id: string;
    payment_id: string | null;
    session_id: string | null;
    value_centavos: number;
    pulse_count: number;
    occurred_at: string;
  }): boolean {
    const inserted =
      this.db
        .prepare(
          `INSERT OR IGNORE INTO coin_events (id, payment_id, session_id, value_centavos, pulse_count, occurred_at)
           VALUES (@id, @payment_id, @session_id, @value_centavos, @pulse_count, @occurred_at)`,
        )
        .run(coin).changes === 1;
    if (inserted) this.enqueue('coin_event', coin.id, coin);
    return inserted;
  }

  /** Open payment sessions (rental or penalty) whose window has passed. */
  listExpiredPaymentSessions(nowIso: string): PaymentRecord[] {
    return this.db
      .prepare(`SELECT * FROM payments WHERE status IN ('PENDING', 'PARTIAL') AND expires_at < ?`)
      .all(nowIso) as PaymentRecord[];
  }

  getOpenPaymentForPenalty(penaltyId: string): PaymentRecord | null {
    return (
      (this.db
        .prepare(`SELECT * FROM payments WHERE penalty_id = ? AND status IN ('PENDING', 'PARTIAL')`)
        .get(penaltyId) as PaymentRecord) ?? null
    );
  }

  // ---------------------------------------------------------------- returns & penalties
  /** The rental a student still has to return (calculator is out). */
  getOutstandingRentalForStudent(studentId: string): RentalRecord | null {
    return (
      (this.db
        .prepare(`SELECT * FROM rentals WHERE student_id = ? AND status IN ('ACTIVE', 'OVERDUE', 'RETURNING')`)
        .get(studentId) as RentalRecord) ?? null
    );
  }

  listActiveRentalsPastDue(nowIso: string): RentalRecord[] {
    return this.db.prepare(`SELECT * FROM rentals WHERE status = 'ACTIVE' AND due_at < ?`).all(nowIso) as RentalRecord[];
  }

  getOverduePenalty(rentalId: string): PenaltyRecord | null {
    return (
      (this.db.prepare(`SELECT * FROM penalties WHERE rental_id = ? AND reason = 'OVERDUE'`).get(rentalId) as PenaltyRecord) ?? null
    );
  }

  private savePenalty(penalty: PenaltyRecord): PenaltyRecord {
    const due = Math.max(0, penalty.calculated_centavos - penalty.amount_paid_centavos);
    const status = due === 0 ? 'PAID' : penalty.amount_paid_centavos > 0 ? 'PARTIAL' : 'UNPAID';
    const row = { ...penalty, amount_due_centavos: due, status, paid_at: due === 0 ? (penalty.paid_at ?? penalty.updated_at) : null };
    this.db
      .prepare(
        `INSERT INTO penalties (id, rental_id, student_id, reason, overdue_minutes, calculated_centavos, amount_paid_centavos, amount_due_centavos, status, paid_at, updated_at)
         VALUES (@id, @rental_id, @student_id, @reason, @overdue_minutes, @calculated_centavos, @amount_paid_centavos, @amount_due_centavos, @status, @paid_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET overdue_minutes = excluded.overdue_minutes, calculated_centavos = excluded.calculated_centavos,
           amount_paid_centavos = excluded.amount_paid_centavos, amount_due_centavos = excluded.amount_due_centavos,
           status = excluded.status, paid_at = excluded.paid_at, updated_at = excluded.updated_at`,
      )
      .run(row);
    this.enqueue('penalty', row.id, row);
    return row as PenaltyRecord;
  }

  /**
   * Creates or raises the overdue penalty of a rental to `calculatedCentavos`
   * (it only ever grows; what was already paid is kept).
   */
  quoteOverduePenalty(
    rental: { id: string; student_id: string },
    quote: { overdueMinutes: number; calculatedCentavos: number },
    newId: string,
    nowIso: string,
  ): PenaltyRecord {
    const existing = this.getOverduePenalty(rental.id);
    return this.savePenalty({
      id: existing?.id ?? newId,
      rental_id: rental.id,
      student_id: rental.student_id,
      reason: 'OVERDUE',
      overdue_minutes: Math.max(existing?.overdue_minutes ?? 0, quote.overdueMinutes),
      calculated_centavos: Math.max(existing?.calculated_centavos ?? 0, quote.calculatedCentavos),
      amount_paid_centavos: existing?.amount_paid_centavos ?? 0,
      amount_due_centavos: 0,
      status: 'UNPAID',
      paid_at: existing?.paid_at ?? null,
      updated_at: nowIso,
    });
  }

  /** Credits coins to a penalty (never beyond what is owed; overpayment stays on the payment). */
  applyPenaltyPayment(penaltyId: string, centavos: number, nowIso: string): PenaltyRecord {
    const penalty = this.db.prepare('SELECT * FROM penalties WHERE id = ?').get(penaltyId) as PenaltyRecord;
    return this.savePenalty({
      ...penalty,
      amount_paid_centavos: Math.min(penalty.calculated_centavos, penalty.amount_paid_centavos + centavos),
      updated_at: nowIso,
    });
  }

  // ---------------------------------------------------------------- events & outbox
  recordEvent(event: {
    type: EventType;
    severity: EventSeverity;
    message: string;
    lockerId?: string | null;
    transactionId?: string | null;
    payload?: Record<string, unknown>;
    occurredAt: string;
  }): void {
    const row = {
      id: randomUUID(),
      event_type: event.type,
      severity: event.severity,
      locker_id: event.lockerId ?? null,
      transaction_id: event.transactionId ?? null,
      message: event.message,
      payload: JSON.stringify(event.payload ?? {}),
      occurred_at: event.occurredAt,
    };
    this.db
      .prepare(
        `INSERT INTO device_events (id, event_type, severity, locker_id, transaction_id, message, payload, occurred_at)
         VALUES (@id, @event_type, @severity, @locker_id, @transaction_id, @message, @payload, @occurred_at)`,
      )
      .run(row);
    this.enqueue('device_event', row.id, { ...row, payload: event.payload ?? {} });
  }

  enqueue(entity: SyncEntity, entityId: string, payload: unknown): void {
    this.db
      .prepare('INSERT INTO sync_queue (entity, entity_id, payload) VALUES (?, ?, ?)')
      .run(entity, entityId, JSON.stringify(payload));
  }

  pendingSyncCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE synced_at IS NULL').get() as { n: number }).n;
  }
}
