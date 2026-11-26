import 'server-only';
import {
  ActorType,
  CalculatorStatus,
  DEVICE_OFFLINE_AFTER_SECONDS,
  DeviceHealth,
  DeviceStatus,
  EventSeverity,
  EventType,
  LockState,
  LockerStatus,
  OPEN_RENTAL_STATUSES,
  OUTSTANDING_RENTAL_STATUSES,
  PaymentStatus,
  PaymentType,
  PenaltyStatus,
  RentalStatus,
  RfidState,
  StudentStatus,
  SystemSettingsSchema,
  operatingCalendar,
  operatingMinutesBetween,
  systemSettingsFromRow,
  type CalculatorCondition,
  type DoorState,
  type PaymentMethod,
  type PenaltyReason,
  type SystemSettings,
} from '@calc-rental/shared';
import { DEFAULT_KIOSK_SETTINGS, getLocalConfig, getLocalDb } from '@/lib/local-db';
import { isLocalBackend } from '@/lib/mode';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const OPEN_LIST = OPEN_RENTAL_STATUSES.map((s) => `'${s}'`).join(', ');
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Manila is UTC+8 year-round (no DST)

/** Start of the current Philippine calendar day expressed as an ISO-8601 UTC string. */
function manilaStartOfDayUtcIso(now: Date = new Date()): string {
  const manilaMs = now.getTime() + MANILA_OFFSET_MS;
  const manilaDate = new Date(manilaMs);
  const startManilaAsUtc = Date.UTC(manilaDate.getUTCFullYear(), manilaDate.getUTCMonth(), manilaDate.getUTCDate());
  return new Date(startManilaAsUtc - MANILA_OFFSET_MS).toISOString();
}

export interface LocalHeartbeatSnapshot {
  lastHeartbeatAt: string | null;
  softwareVersion: string | null;
  kioskState: string | null;
  cpuTempC: number | null;
  clockDriftSeconds: number | null;
  localDbOk: boolean;
  clockSynced?: boolean;
  sync: {
    lastPushAt: string | null;
    lastPullAt: string | null;
    lastError: string | null;
    failedItems: number;
  } | null;
}

function readLocalKioskHeartbeat(): {
  deviceId: string;
  deviceCode: string;
  connectionStatus: DeviceStatus;
  health: DeviceHealth;
  syncQueueCount: number;
  beat: LocalHeartbeatSnapshot;
  clockTrusted: boolean;
  kioskNowIso: string;
} {
  const db = getLocalDb();
  const deviceCode = getLocalConfig(db, 'device_id') ?? 'DEVICE-CALC-KIOSK-001';
  const rawBeat = getLocalConfig(db, 'kiosk_heartbeat');
  let beat: LocalHeartbeatSnapshot = {
    lastHeartbeatAt: null,
    softwareVersion: null,
    kioskState: null,
    cpuTempC: null,
    clockDriftSeconds: 0,
    localDbOk: true,
    sync: null,
  };
  if (rawBeat) {
    try {
      beat = { ...beat, ...(JSON.parse(rawBeat) as Partial<LocalHeartbeatSnapshot>) };
    } catch {
      // ignore malformed JSON
    }
  }

  const nowMs = Date.now();
  const lastMs = beat.lastHeartbeatAt ? new Date(beat.lastHeartbeatAt).getTime() : null;
  const connectionStatus: DeviceStatus =
    lastMs === null
      ? DeviceStatus.NEVER_SEEN
      : nowMs - lastMs <= DEVICE_OFFLINE_AFTER_SECONDS * 1000
        ? DeviceStatus.ONLINE
        : DeviceStatus.OFFLINE;

  const syncQueueCount = (
    db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE synced_at IS NULL AND failed_at IS NULL').get() as { n: number }
  ).n;
  const failedItems = (
    db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE failed_at IS NOT NULL AND synced_at IS NULL').get() as { n: number }
  ).n;

  const health: DeviceHealth =
    connectionStatus === DeviceStatus.NEVER_SEEN
      ? DeviceHealth.UNKNOWN
      : beat.localDbOk && failedItems === 0
        ? DeviceHealth.OK
        : DeviceHealth.DEGRADED;

  const bootCount = getLocalConfig(db, 'boot_count') ?? '0';
  const trustedBoot = getLocalConfig(db, 'clock_trusted_boot_count');
  const offsetMs = Number(getLocalConfig(db, 'clock_offset_ms') ?? '0') || 0;
  const clockTrusted = beat.clockSynced === true || (trustedBoot !== null && trustedBoot === bootCount);
  const kioskNowIso = new Date(nowMs + offsetMs).toISOString();

  return {
    deviceId: '00000000-0000-4000-8000-000000000001',
    deviceCode,
    connectionStatus,
    health,
    syncQueueCount,
    beat: {
      ...beat,
      sync: beat.sync ? { ...beat.sync, failedItems } : { lastPushAt: null, lastPullAt: null, lastError: null, failedItems },
    },
    clockTrusted,
    kioskNowIso,
  };
}

// ---------------------------------------------------------------------------
// 1. Dashboard Summary
// ---------------------------------------------------------------------------

export interface DashboardSummaryData {
  total_calculators: number;
  available_calculators: number;
  rented_calculators: number;
  overdue_rentals: number;
  rentals_today: number;
  returns_today: number;
  income_today: number;
  outstanding_penalties: number;
}

export async function queryDashboardSummary(): Promise<DashboardSummaryData> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    const { data: s, error } = await supabase.from('v_dashboard_summary').select('*').single();
    if (error || !s) throw new Error('Failed to load dashboard summary');
    return {
      total_calculators: s.total_calculators ?? 0,
      available_calculators: s.available_calculators ?? 0,
      rented_calculators: s.rented_calculators ?? 0,
      overdue_rentals: s.overdue_rentals ?? 0,
      rentals_today: s.rentals_today ?? 0,
      returns_today: s.returns_today ?? 0,
      income_today: Number(s.income_today ?? 0),
      outstanding_penalties: Number(s.outstanding_penalties ?? 0),
    };
  }

  const db = getLocalDb();
  const nowIso = new Date().toISOString();
  const todayIso = manilaStartOfDayUtcIso();

  const total_calculators = (
    db.prepare(`SELECT COUNT(*) AS n FROM calculators WHERE status <> 'DISABLED'`).get() as { n: number }
  ).n;
  const available_calculators = (
    db.prepare(`SELECT COUNT(*) AS n FROM calculators WHERE status = 'AVAILABLE'`).get() as { n: number }
  ).n;
  const rented_calculators = (
    db.prepare(`SELECT COUNT(*) AS n FROM rentals WHERE status IN ('ACTIVE', 'OVERDUE', 'RETURNING')`).get() as { n: number }
  ).n;
  const overdue_rentals = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM rentals WHERE status IN ('ACTIVE', 'OVERDUE', 'RETURNING') AND due_at IS NOT NULL AND due_at < ?`)
      .get(nowIso) as { n: number }
  ).n;
  const rentals_today = (
    db.prepare(`SELECT COUNT(*) AS n FROM rentals WHERE rented_at IS NOT NULL AND rented_at >= ?`).get(todayIso) as { n: number }
  ).n;
  const returns_today = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM rentals WHERE status = 'COMPLETED' AND returned_at IS NOT NULL AND returned_at >= ?`)
      .get(todayIso) as { n: number }
  ).n;
  const incomeCentavos = (
    db
      .prepare(`SELECT COALESCE(SUM(received_centavos), 0) AS s FROM payments WHERE status = 'PAID' AND paid_at IS NOT NULL AND paid_at >= ?`)
      .get(todayIso) as { s: number }
  ).s;
  const penaltyCentavos = (
    db
      .prepare(`SELECT COALESCE(SUM(amount_due_centavos), 0) AS s FROM penalties WHERE status IN ('UNPAID', 'PARTIAL')`)
      .get() as { s: number }
  ).s;

  return {
    total_calculators,
    available_calculators,
    rented_calculators,
    overdue_rentals,
    rentals_today,
    returns_today,
    income_today: incomeCentavos / 100,
    outstanding_penalties: penaltyCentavos / 100,
  };
}

// ---------------------------------------------------------------------------
// 2. Settings
// ---------------------------------------------------------------------------

export async function querySystemSettings(): Promise<{ settings: SystemSettings; updatedAt: string | null }> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    const { data: row, error } = await supabase.from('system_settings').select('*').eq('id', 1).single();
    if (error || !row) throw new Error('Failed to load settings');
    return { settings: systemSettingsFromRow(row), updatedAt: row.updated_at };
  }

  const db = getLocalDb();
  const row = db.prepare('SELECT data, updated_at FROM settings WHERE id = 1').get() as
    | { data: string; updated_at: string }
    | undefined;
  if (!row) return { settings: DEFAULT_KIOSK_SETTINGS, updatedAt: null };
  const parsed = SystemSettingsSchema.safeParse(JSON.parse(row.data));
  return { settings: parsed.success ? parsed.data : DEFAULT_KIOSK_SETTINGS, updatedAt: row.updated_at };
}

// ---------------------------------------------------------------------------
// 3. Rentals & Transactions (Active Rentals + Transaction History)
// ---------------------------------------------------------------------------

export interface RentalViewRow {
  id: string;
  transaction_code: string;
  status: RentalStatus;
  effective_status: RentalStatus;
  student_full_name: string;
  student_number: string;
  student_course_program: string;
  calculator_code: string;
  locker_name: string;
  rented_at: string | null;
  due_at: string | null;
  returned_at: string | null;
  created_at: string;
  was_overdue: boolean;
  overdue_minutes: number;
  failure_reason: string | null;
  amount_paid: number;
  penalty_amount_due: number;
}

export async function queryActiveRentals(): Promise<{ rentals: RentalViewRow[]; settings: SystemSettings }> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    const [{ data: rentals, error }, { data: settingsRow }] = await Promise.all([
      supabase.from('v_rentals').select('*').in('status', [...OUTSTANDING_RENTAL_STATUSES]).order('due_at', { ascending: true }),
      supabase.from('system_settings').select('*').eq('id', 1).single(),
    ]);
    if (error) throw new Error('Failed to load active rentals');
    const settings = settingsRow ? systemSettingsFromRow(settingsRow) : DEFAULT_KIOSK_SETTINGS;
    return {
      settings,
      rentals: (rentals ?? []).map((r) => ({
        id: r.id!,
        transaction_code: r.transaction_code!,
        status: r.status!,
        effective_status: r.effective_status ?? r.status!,
        student_full_name: r.student_full_name!,
        student_number: r.student_number!,
        student_course_program: r.student_course_program!,
        calculator_code: r.calculator_code!,
        locker_name: r.locker_name!,
        rented_at: r.rented_at,
        due_at: r.due_at,
        returned_at: r.returned_at,
        created_at: r.created_at!,
        was_overdue: Boolean(r.was_overdue),
        overdue_minutes: r.overdue_minutes ?? 0,
        failure_reason: r.failure_reason,
        amount_paid: Number(r.amount_paid ?? 0),
        penalty_amount_due: Number(r.penalty_amount_due ?? 0),
      })),
    };
  }

  const { settings } = await querySystemSettings();
  const rentals = queryLocalRentals({ onlyOutstanding: true, limit: 200 });
  return { rentals, settings };
}

export async function queryTransactions(filters: {
  q: string;
  status: RentalStatus | '';
  limit: number;
}): Promise<RentalViewRow[]> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    let query = supabase.from('v_rentals').select('*').order('created_at', { ascending: false }).limit(filters.limit);
    if (filters.q) {
      query = query.or(
        `transaction_code.ilike.%${filters.q}%,student_full_name.ilike.%${filters.q}%,student_number.ilike.%${filters.q}%,calculator_code.ilike.%${filters.q}%`,
      );
    }
    if (filters.status) query = query.eq('status', filters.status);
    const { data, error } = await query;
    if (error) throw new Error('Failed to load transactions');
    return (data ?? []).map((r) => ({
      id: r.id!,
      transaction_code: r.transaction_code!,
      status: r.status!,
      effective_status: r.effective_status ?? r.status!,
      student_full_name: r.student_full_name!,
      student_number: r.student_number!,
      student_course_program: r.student_course_program!,
      calculator_code: r.calculator_code!,
      locker_name: r.locker_name!,
      rented_at: r.rented_at,
      due_at: r.due_at,
      returned_at: r.returned_at,
      created_at: r.created_at!,
      was_overdue: Boolean(r.was_overdue),
      overdue_minutes: r.overdue_minutes ?? 0,
      failure_reason: r.failure_reason,
      amount_paid: Number(r.amount_paid ?? 0),
      penalty_amount_due: Number(r.penalty_amount_due ?? 0),
    }));
  }

  return queryLocalRentals({ q: filters.q, status: filters.status, limit: filters.limit });
}

function queryLocalRentals(opts: {
  onlyOutstanding?: boolean;
  q?: string;
  status?: RentalStatus | '';
  limit: number;
}): RentalViewRow[] {
  const db = getLocalDb();
  const nowIso = new Date().toISOString();
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.onlyOutstanding) {
    clauses.push(`r.status IN ('ACTIVE', 'OVERDUE', 'RETURNING')`);
  }
  if (opts.status) {
    clauses.push(`r.status = ?`);
    params.push(opts.status);
  }
  if (opts.q) {
    const like = `%${opts.q.toLowerCase()}%`;
    clauses.push(
      `(LOWER(r.transaction_code) LIKE ? OR LOWER(s.full_name) LIKE ? OR LOWER(s.student_number) LIKE ? OR LOWER(c.code) LIKE ?)`,
    );
    params.push(like, like, like, like);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderBy = opts.onlyOutstanding ? 'ORDER BY r.due_at ASC' : 'ORDER BY r.created_at DESC';
  params.push(opts.limit);

  const rows = db
    .prepare(
      `SELECT r.*, s.full_name AS student_full_name, s.student_number, s.course_program AS student_course_program,
              c.code AS calculator_code, l.name AS locker_name,
              COALESCE((SELECT SUM(pe.amount_due_centavos) FROM penalties pe WHERE pe.rental_id = r.id), 0) AS penalty_due_centavos
       FROM rentals r
       JOIN students s ON s.id = r.student_id
       JOIN calculators c ON c.id = r.calculator_id
       JOIN lockers l ON l.id = r.locker_id
       ${where}
       ${orderBy}
       LIMIT ?`,
    )
    .all(...params) as Array<{
    id: string;
    transaction_code: string;
    status: RentalStatus;
    student_full_name: string;
    student_number: string;
    student_course_program: string;
    calculator_code: string;
    locker_name: string;
    rented_at: string | null;
    due_at: string | null;
    returned_at: string | null;
    created_at: string;
    was_overdue: number;
    overdue_minutes: number;
    failure_reason: string | null;
    amount_paid_centavos: number;
    penalty_due_centavos: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    transaction_code: r.transaction_code,
    status: r.status,
    effective_status: r.status === RentalStatus.ACTIVE && r.due_at !== null && nowIso > r.due_at ? RentalStatus.OVERDUE : r.status,
    student_full_name: r.student_full_name,
    student_number: r.student_number,
    student_course_program: r.student_course_program,
    calculator_code: r.calculator_code,
    locker_name: r.locker_name,
    rented_at: r.rented_at,
    due_at: r.due_at,
    returned_at: r.returned_at,
    created_at: r.created_at,
    was_overdue: r.was_overdue === 1,
    overdue_minutes: r.overdue_minutes,
    failure_reason: r.failure_reason,
    amount_paid: r.amount_paid_centavos / 100,
    penalty_amount_due: r.penalty_due_centavos / 100,
  }));
}

// ---------------------------------------------------------------------------
// 4. Payments
// ---------------------------------------------------------------------------

export interface PaymentViewRow {
  id: string;
  payment_type: PaymentType;
  method: PaymentMethod;
  status: PaymentStatus;
  required_amount: number;
  amount_received: number;
  created_at: string;
  paid_at: string | null;
  student_full_name: string | null;
  student_number: string | null;
  transaction_code: string | null;
}

export async function queryPayments(filters: {
  status: PaymentStatus | '';
  type: PaymentType | '';
  limit: number;
}): Promise<PaymentViewRow[]> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    let query = supabase
      .from('payments')
      .select('*, students(full_name, student_number), rental_transactions(transaction_code)')
      .order('created_at', { ascending: false })
      .limit(filters.limit);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.type) query = query.eq('payment_type', filters.type);
    const { data, error } = await query;
    if (error) throw new Error('Failed to load payments');
    return (data ?? []).map((p) => ({
      id: p.id,
      payment_type: p.payment_type,
      method: p.method,
      status: p.status,
      required_amount: Number(p.required_amount),
      amount_received: Number(p.amount_received),
      created_at: p.created_at,
      paid_at: p.paid_at,
      student_full_name: p.students?.full_name ?? null,
      student_number: p.students?.student_number ?? null,
      transaction_code: p.rental_transactions?.transaction_code ?? null,
    }));
  }

  const db = getLocalDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    clauses.push('p.status = ?');
    params.push(filters.status);
  }
  if (filters.type) {
    clauses.push('p.payment_type = ?');
    params.push(filters.type);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(filters.limit);

  const rows = db
    .prepare(
      `SELECT p.*, s.full_name AS student_full_name, s.student_number, r.transaction_code
       FROM payments p
       LEFT JOIN students s ON s.id = p.student_id
       LEFT JOIN rentals r ON r.id = p.rental_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    id: string;
    payment_type: PaymentType;
    method: PaymentMethod;
    status: PaymentStatus;
    required_centavos: number;
    received_centavos: number;
    created_at: string;
    paid_at: string | null;
    student_full_name: string | null;
    student_number: string | null;
    transaction_code: string | null;
  }>;

  return rows.map((p) => ({
    id: p.id,
    payment_type: p.payment_type,
    method: p.method,
    status: p.status,
    required_amount: p.required_centavos / 100,
    amount_received: p.received_centavos / 100,
    created_at: p.created_at,
    paid_at: p.paid_at,
    student_full_name: p.student_full_name,
    student_number: p.student_number,
    transaction_code: p.transaction_code,
  }));
}

// ---------------------------------------------------------------------------
// 5. Penalties
// ---------------------------------------------------------------------------

export interface PenaltyViewRow {
  id: string;
  reason: PenaltyReason;
  overdue_minutes: number;
  calculated_amount: number;
  amount_paid: number;
  waived_amount: number;
  amount_due: number;
  status: PenaltyStatus;
  calculated_at: string;
  waive_reason: string | null;
  student_full_name: string | null;
  student_number: string | null;
  transaction_code: string | null;
}

export async function queryPenalties(filters: {
  status: PenaltyStatus | '';
  limit: number;
}): Promise<PenaltyViewRow[]> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    let query = supabase
      .from('penalties')
      .select('*, students(full_name, student_number), rental_transactions(transaction_code)')
      .order('created_at', { ascending: false })
      .limit(filters.limit);
    if (filters.status) query = query.eq('status', filters.status);
    const { data, error } = await query;
    if (error) throw new Error('Failed to load penalties');
    return (data ?? []).map((p) => ({
      id: p.id,
      reason: p.reason,
      overdue_minutes: p.overdue_minutes,
      calculated_amount: Number(p.calculated_amount),
      amount_paid: Number(p.amount_paid),
      waived_amount: Number(p.waived_amount),
      amount_due: Number(p.amount_due),
      status: p.status,
      calculated_at: p.calculated_at,
      waive_reason: p.waive_reason,
      student_full_name: p.students?.full_name ?? null,
      student_number: p.students?.student_number ?? null,
      transaction_code: p.rental_transactions?.transaction_code ?? null,
    }));
  }

  const db = getLocalDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    clauses.push('pe.status = ?');
    params.push(filters.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(filters.limit);

  const rows = db
    .prepare(
      `SELECT pe.*, s.full_name AS student_full_name, s.student_number, r.transaction_code
       FROM penalties pe
       LEFT JOIN students s ON s.id = pe.student_id
       LEFT JOIN rentals r ON r.id = pe.rental_id
       ${where}
       ORDER BY COALESCE(pe.calculated_at, pe.updated_at) DESC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    id: string;
    reason: PenaltyReason;
    overdue_minutes: number;
    calculated_centavos: number;
    amount_paid_centavos: number;
    waived_centavos: number;
    amount_due_centavos: number;
    status: PenaltyStatus;
    calculated_at: string | null;
    updated_at: string;
    waive_reason: string | null;
    student_full_name: string | null;
    student_number: string | null;
    transaction_code: string | null;
  }>;

  return rows.map((pe) => ({
    id: pe.id,
    reason: pe.reason,
    overdue_minutes: pe.overdue_minutes,
    calculated_amount: pe.calculated_centavos / 100,
    amount_paid: pe.amount_paid_centavos / 100,
    waived_amount: pe.waived_centavos / 100,
    amount_due: pe.amount_due_centavos / 100,
    status: pe.status,
    calculated_at: pe.calculated_at ?? pe.updated_at,
    waive_reason: pe.waive_reason,
    student_full_name: pe.student_full_name,
    student_number: pe.student_number,
    transaction_code: pe.transaction_code,
  }));
}

// ---------------------------------------------------------------------------
// 6. Calculators
// ---------------------------------------------------------------------------

export interface CalculatorViewRow {
  id: string;
  code: string;
  model: string;
  rfid_uid: string;
  locker_id: string | null;
  locker_name: string | null;
  status: CalculatorStatus;
  condition: CalculatorCondition;
  notes: string | null;
  open_rental_id: string | null;
  open_rental_due_at: string | null;
  borrower_full_name: string | null;
  borrower_student_number: string | null;
  last_transaction_at: string | null;
  rental_count: number;
}

export async function queryCalculatorsPageData(filters: {
  q: string;
  status: CalculatorStatus | '';
}): Promise<{
  calculators: CalculatorViewRow[];
  lockers: Array<{ id: string; locker_number: number; name: string; calculator_id: string | null }>;
  allCodes: string[];
}> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    let query = supabase.from('v_calculators').select('*').order('code');
    if (filters.q) query = query.or(`code.ilike.%${filters.q}%,model.ilike.%${filters.q}%,rfid_uid.ilike.%${filters.q}%`);
    if (filters.status) query = query.eq('status', filters.status);

    const [{ data: calculators, error }, { data: lockers }, { data: allCodes }] = await Promise.all([
      query,
      supabase.from('v_lockers').select('id, locker_number, name, calculator_id').order('locker_number'),
      supabase.from('calculators').select('code'),
    ]);
    if (error) throw new Error('Failed to load calculators');
    return {
      calculators: (calculators ?? []).map((c) => ({
        id: c.id!,
        code: c.code!,
        model: c.model!,
        rfid_uid: c.rfid_uid!,
        locker_id: c.locker_id,
        locker_name: c.locker_name,
        status: c.status!,
        condition: c.condition!,
        notes: c.notes,
        open_rental_id: c.open_rental_id,
        open_rental_due_at: c.open_rental_due_at,
        borrower_full_name: c.borrower_full_name,
        borrower_student_number: c.borrower_student_number,
        last_transaction_at: c.last_transaction_at,
        rental_count: c.rental_count ?? 0,
      })),
      lockers: (lockers ?? []).map((l) => ({
        id: l.id!,
        locker_number: l.locker_number!,
        name: l.name!,
        calculator_id: l.calculator_id,
      })),
      allCodes: (allCodes ?? []).map((c) => c.code),
    };
  }

  const db = getLocalDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.q) {
    const like = `%${filters.q.toLowerCase()}%`;
    clauses.push(`(LOWER(c.code) LIKE ? OR LOWER(c.model) LIKE ? OR LOWER(c.rfid_uid) LIKE ?)`);
    params.push(like, like, like);
  }
  if (filters.status) {
    clauses.push('c.status = ?');
    params.push(filters.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const calculators = db
    .prepare(
      `SELECT c.id, c.code, c.model, c.rfid_uid, c.locker_id, l.name AS locker_name, c.status, c.condition, c.notes,
              o.id AS open_rental_id, o.due_at AS open_rental_due_at,
              s.full_name AS borrower_full_name, s.student_number AS borrower_student_number,
              (SELECT MAX(r2.created_at) FROM rentals r2 WHERE r2.calculator_id = c.id) AS last_transaction_at,
              (SELECT COUNT(*) FROM rentals r3 WHERE r3.calculator_id = c.id AND r3.status IN ('ACTIVE', 'OVERDUE', 'RETURNING', 'COMPLETED')) AS rental_count
       FROM calculators c
       LEFT JOIN lockers l ON l.id = c.locker_id
       LEFT JOIN rentals o ON o.calculator_id = c.id AND o.status IN (${OPEN_LIST})
       LEFT JOIN students s ON s.id = o.student_id
       ${where}
       ORDER BY c.code`,
    )
    .all(...params) as CalculatorViewRow[];

  const lockers = db
    .prepare(
      `SELECT l.id, l.locker_number, l.name, c.id AS calculator_id
       FROM lockers l
       LEFT JOIN calculators c ON c.locker_id = l.id
       ORDER BY l.locker_number`,
    )
    .all() as Array<{ id: string; locker_number: number; name: string; calculator_id: string | null }>;

  const allCodes = (db.prepare('SELECT code FROM calculators').all() as Array<{ code: string }>).map((c) => c.code);

  return { calculators, lockers, allCodes };
}

// ---------------------------------------------------------------------------
// 7. Lockers
// ---------------------------------------------------------------------------

export interface LockerViewRow {
  id: string;
  device_id: string;
  locker_number: number;
  name: string;
  hardware_channel: number;
  status: LockerStatus;
  lock_state: LockState;
  door_state: DoorState;
  rfid_state: RfidState;
  last_detected_rfid_uid: string | null;
  last_seen_at: string | null;
  notes: string | null;
  device_code: string;
  device_connection_status: DeviceStatus;
  calculator_id: string | null;
  calculator_code: string | null;
  expected_rfid_uid: string | null;
  is_assignable: boolean;
  has_inventory_mismatch: boolean;
  has_open_rental: boolean;
}

export async function queryLockersPageData(): Promise<LockerViewRow[]> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    const [{ data: lockers, error }, { data: openRentals }] = await Promise.all([
      supabase.from('v_lockers').select('*').order('locker_number'),
      supabase.from('rental_transactions').select('locker_id').in('status', [...OPEN_RENTAL_STATUSES]),
    ]);
    if (error) throw new Error('Failed to load lockers');
    const busy = new Set((openRentals ?? []).map((r) => r.locker_id));
    return (lockers ?? []).map((l) => ({
      id: l.id!,
      device_id: l.device_id!,
      locker_number: l.locker_number!,
      name: l.name!,
      hardware_channel: l.hardware_channel!,
      status: l.status!,
      lock_state: l.lock_state!,
      door_state: l.door_state!,
      rfid_state: l.rfid_state!,
      last_detected_rfid_uid: l.last_detected_rfid_uid,
      last_seen_at: l.last_seen_at,
      notes: l.notes,
      device_code: l.device_code!,
      device_connection_status: (l.device_connection_status as DeviceStatus) ?? DeviceStatus.NEVER_SEEN,
      calculator_id: l.calculator_id,
      calculator_code: l.calculator_code,
      expected_rfid_uid: l.expected_rfid_uid,
      is_assignable: Boolean(l.is_assignable),
      has_inventory_mismatch: Boolean(l.has_inventory_mismatch),
      has_open_rental: busy.has(l.id!),
    }));
  }

  const db = getLocalDb();
  const kiosk = readLocalKioskHeartbeat();
  const rows = db
    .prepare(
      `SELECT l.*, c.id AS calculator_id, c.code AS calculator_code, c.rfid_uid AS expected_rfid_uid, c.status AS calculator_status,
              EXISTS (SELECT 1 FROM rentals r WHERE r.locker_id = l.id AND r.status IN (${OPEN_LIST})) AS has_open_rental
       FROM lockers l
       LEFT JOIN calculators c ON c.locker_id = l.id
       ORDER BY l.locker_number`,
    )
    .all() as Array<{
    id: string;
    locker_number: number;
    name: string;
    hardware_channel: number;
    status: LockerStatus;
    lock_state: LockState;
    door_state: DoorState;
    rfid_state: RfidState;
    last_detected_rfid_uid: string | null;
    last_seen_at: string | null;
    notes: string | null;
    calculator_id: string | null;
    calculator_code: string | null;
    expected_rfid_uid: string | null;
    calculator_status: CalculatorStatus | null;
    has_open_rental: number;
  }>;

  return rows.map((l) => {
    const isAssignable =
      l.status === LockerStatus.AVAILABLE &&
      l.calculator_status === CalculatorStatus.AVAILABLE &&
      l.rfid_state === RfidState.EXPECTED_TAG &&
      l.last_detected_rfid_uid === l.expected_rfid_uid &&
      l.lock_state === LockState.LOCKED &&
      kiosk.connectionStatus === DeviceStatus.ONLINE;

    const hasInventoryMismatch =
      (l.status === LockerStatus.AVAILABLE || l.calculator_status === CalculatorStatus.AVAILABLE) &&
      (l.rfid_state === RfidState.NO_TAG || l.rfid_state === RfidState.WRONG_TAG);

    return {
      id: l.id,
      device_id: kiosk.deviceId,
      locker_number: l.locker_number,
      name: l.name,
      hardware_channel: l.hardware_channel,
      status: l.status,
      lock_state: l.lock_state,
      door_state: l.door_state,
      rfid_state: l.rfid_state,
      last_detected_rfid_uid: l.last_detected_rfid_uid,
      last_seen_at: l.last_seen_at,
      notes: l.notes,
      device_code: kiosk.deviceCode,
      device_connection_status: kiosk.connectionStatus,
      calculator_id: l.calculator_id,
      calculator_code: l.calculator_code,
      expected_rfid_uid: l.expected_rfid_uid,
      is_assignable: isAssignable,
      has_inventory_mismatch: hasInventoryMismatch,
      has_open_rental: l.has_open_rental === 1,
    };
  });
}

// ---------------------------------------------------------------------------
// 8. Students
// ---------------------------------------------------------------------------

export interface StudentViewRow {
  id: string;
  student_number: string;
  full_name: string;
  course_program: string;
  status: StudentStatus;
  blocked_reason: string | null;
  open_rental_id: string | null;
  open_rental_status: RentalStatus | null;
  open_rental_due_at: string | null;
  open_rental_calculator_code: string | null;
  rental_count: number;
  overdue_count: number;
  unpaid_penalty_total: number;
}

export async function queryStudents(filters: {
  q: string;
  status: StudentStatus | '';
  limit: number;
}): Promise<StudentViewRow[]> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    let query = supabase.from('v_students').select('*').order('full_name').limit(filters.limit);
    if (filters.q) query = query.or(`full_name.ilike.%${filters.q}%,student_number.ilike.%${filters.q}%,course_program.ilike.%${filters.q}%`);
    if (filters.status) query = query.eq('status', filters.status);
    const { data, error } = await query;
    if (error) throw new Error('Failed to load students');
    return (data ?? []).map((s) => ({
      id: s.id!,
      student_number: s.student_number!,
      full_name: s.full_name!,
      course_program: s.course_program!,
      status: s.status!,
      blocked_reason: s.blocked_reason,
      open_rental_id: s.open_rental_id,
      open_rental_status: s.open_rental_status,
      open_rental_due_at: s.open_rental_due_at,
      open_rental_calculator_code: s.open_rental_calculator_code,
      rental_count: s.rental_count ?? 0,
      overdue_count: s.overdue_count ?? 0,
      unpaid_penalty_total: Number(s.unpaid_penalty_total ?? 0),
    }));
  }

  const db = getLocalDb();
  const nowIso = new Date().toISOString();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.q) {
    const like = `%${filters.q.toLowerCase()}%`;
    clauses.push(`(LOWER(s.full_name) LIKE ? OR LOWER(s.student_number) LIKE ? OR LOWER(s.course_program) LIKE ?)`);
    params.push(like, like, like);
  }
  if (filters.status) {
    clauses.push('s.status = ?');
    params.push(filters.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(nowIso, filters.limit);

  const rows = db
    .prepare(
      `SELECT s.id, s.student_number, s.full_name, s.course_program, s.status, s.blocked_reason,
              o.id AS open_rental_id, o.status AS open_rental_status, o.due_at AS open_rental_due_at,
              c.code AS open_rental_calculator_code,
              (SELECT COUNT(*) FROM rentals r2 WHERE r2.student_id = s.id AND r2.status IN ('ACTIVE', 'OVERDUE', 'RETURNING', 'COMPLETED')) AS rental_count,
              (SELECT COUNT(*) FROM rentals r3 WHERE r3.student_id = s.id AND (r3.was_overdue = 1 OR (r3.status IN ('ACTIVE', 'OVERDUE', 'RETURNING') AND r3.due_at IS NOT NULL AND r3.due_at < ?))) AS overdue_count,
              COALESCE((SELECT SUM(pe.amount_due_centavos) FROM penalties pe WHERE pe.student_id = s.id AND pe.status IN ('UNPAID', 'PARTIAL')), 0) AS unpaid_centavos
       FROM students s
       LEFT JOIN rentals o ON o.student_id = s.id AND o.status IN (${OPEN_LIST})
       LEFT JOIN calculators c ON c.id = o.calculator_id
       ${where}
       ORDER BY s.full_name ASC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    id: string;
    student_number: string;
    full_name: string;
    course_program: string;
    status: StudentStatus;
    blocked_reason: string | null;
    open_rental_id: string | null;
    open_rental_status: RentalStatus | null;
    open_rental_due_at: string | null;
    open_rental_calculator_code: string | null;
    rental_count: number;
    overdue_count: number;
    unpaid_centavos: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    student_number: r.student_number,
    full_name: r.full_name,
    course_program: r.course_program,
    status: r.status,
    blocked_reason: r.blocked_reason,
    open_rental_id: r.open_rental_id,
    open_rental_status: r.open_rental_status,
    open_rental_due_at: r.open_rental_due_at,
    open_rental_calculator_code: r.open_rental_calculator_code,
    rental_count: r.rental_count,
    overdue_count: r.overdue_count,
    unpaid_penalty_total: r.unpaid_centavos / 100,
  }));
}

// ---------------------------------------------------------------------------
// 9. Devices & Commands
// ---------------------------------------------------------------------------

export interface DeviceViewRow {
  id: string;
  device_code: string;
  name: string;
  location: string | null;
  connection_status: DeviceStatus;
  health: DeviceHealth;
  last_heartbeat_at: string | null;
  software_version: string | null;
  cpu_temp_c: number | null;
  sync_queue_count: number;
  last_sync_at: string | null;
  last_pull_at: string | null;
  last_sync_error: string | null;
  kiosk_state: string | null;
  clock_drift_seconds: number | null;
  failed_items: number;
  clock_trusted?: boolean;
  kiosk_now_iso?: string;
}

export interface DeviceCommandViewRow {
  id: string;
  command: string;
  payload: { lockerNumber?: number; requestedBy?: string };
  reason: string | null;
  status: string;
  requested_at: string;
  result_message: string | null;
}

export async function queryDeviceStatusPageData(): Promise<{
  devices: DeviceViewRow[];
  lockers: LockerViewRow[];
  commands: DeviceCommandViewRow[];
}> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    const [devices, lockers, commands] = await Promise.all([
      supabase.from('v_devices').select('*').order('device_code'),
      queryLockersPageData(),
      supabase.from('device_commands').select('*').order('requested_at', { ascending: false }).limit(15),
    ]);
    if (devices.error || commands.error) throw new Error('Failed to load device status');

    return {
      devices: (devices.data ?? []).map((d) => {
        const lastHealth = (d.last_health ?? {}) as {
          kioskState?: string;
          clockDriftSeconds?: number;
          sync?: { lastPushAt: string | null; lastPullAt: string | null; lastError: string | null; failedItems: number } | null;
        };
        return {
          id: d.id!,
          device_code: d.device_code!,
          name: d.name!,
          location: d.location,
          connection_status: (d.connection_status as DeviceStatus) ?? DeviceStatus.NEVER_SEEN,
          health: d.health!,
          last_heartbeat_at: d.last_heartbeat_at,
          software_version: d.software_version,
          cpu_temp_c: d.cpu_temp_c === null ? null : Number(d.cpu_temp_c),
          sync_queue_count: d.sync_queue_count ?? 0,
          last_sync_at: d.last_sync_at ?? lastHealth.sync?.lastPushAt ?? null,
          last_pull_at: d.last_pull_at ?? lastHealth.sync?.lastPullAt ?? null,
          last_sync_error: d.last_sync_error ?? lastHealth.sync?.lastError ?? null,
          kiosk_state: lastHealth.kioskState ?? null,
          clock_drift_seconds: lastHealth.clockDriftSeconds ?? null,
          failed_items: lastHealth.sync?.failedItems ?? 0,
        };
      }),
      lockers,
      commands: (commands.data ?? []).map((c) => ({
        id: c.id,
        command: c.command,
        payload: (c.payload ?? {}) as { lockerNumber?: number; requestedBy?: string },
        reason: c.reason,
        status: c.status,
        requested_at: c.requested_at,
        result_message: c.result_message,
      })),
    };
  }

  const db = getLocalDb();
  const kiosk = readLocalKioskHeartbeat();
  const lockers = await queryLockersPageData();

  const commandRows = db
    .prepare(`SELECT * FROM device_commands ORDER BY requested_at DESC LIMIT 15`)
    .all() as Array<{
    id: string;
    command: string;
    payload: string;
    reason: string | null;
    status: string;
    requested_at: string;
    result_message: string | null;
  }>;

  return {
    devices: [
      {
        id: kiosk.deviceId,
        device_code: kiosk.deviceCode,
        name: 'Raspberry Pi 4 Kiosk (Local)',
        location: 'Local SQLite Authority',
        connection_status: kiosk.connectionStatus,
        health: kiosk.health,
        last_heartbeat_at: kiosk.beat.lastHeartbeatAt,
        software_version: kiosk.beat.softwareVersion,
        cpu_temp_c: kiosk.beat.cpuTempC,
        sync_queue_count: kiosk.syncQueueCount,
        last_sync_at: kiosk.beat.sync?.lastPushAt ?? null,
        last_pull_at: kiosk.beat.sync?.lastPullAt ?? null,
        last_sync_error: kiosk.beat.sync?.lastError ?? null,
        kiosk_state: kiosk.beat.kioskState,
        clock_drift_seconds: kiosk.beat.clockDriftSeconds,
        failed_items: kiosk.beat.sync?.failedItems ?? 0,
        clock_trusted: kiosk.clockTrusted,
        kiosk_now_iso: kiosk.kioskNowIso,
      },
    ],
    lockers,
    commands: commandRows.map((c) => {
      let payload: { lockerNumber?: number; requestedBy?: string } = {};
      try {
        payload = JSON.parse(c.payload) as { lockerNumber?: number; requestedBy?: string };
      } catch {
        // ignore
      }
      return {
        id: c.id,
        command: c.command,
        payload,
        reason: c.reason,
        status: c.status,
        requested_at: c.requested_at,
        result_message: c.result_message,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// 10. Event Logs
// ---------------------------------------------------------------------------

export interface EventLogViewRow {
  id: string;
  event_type: string;
  severity: string;
  message: string | null;
  payload: Record<string, unknown> | null;
  occurred_at: string;
  synced_at: string | null;
  locker_name: string | null;
  transaction_code: string | null;
}

export async function queryEventLogs(filters: {
  q: string;
  severity: EventSeverity | '';
  type: EventType | '';
  limit: number;
}): Promise<EventLogViewRow[]> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    let query = supabase
      .from('device_events')
      .select('id, event_type, severity, message, payload, occurred_at, synced_at, locker_id, transaction_id')
      .order('occurred_at', { ascending: false })
      .limit(filters.limit);
    if (filters.q) query = query.ilike('message', `%${filters.q}%`);
    if (filters.severity) query = query.eq('severity', filters.severity);
    if (filters.type) query = query.eq('event_type', filters.type);
    const [{ data: events, error }, { data: lockers }] = await Promise.all([query, supabase.from('lockers').select('id, name')]);
    if (error) throw new Error('Failed to load events');

    const lockerName = new Map((lockers ?? []).map((l) => [l.id, l.name]));
    const rentalIds = [...new Set((events ?? []).map((e) => e.transaction_id).filter((id): id is string => !!id))];
    const { data: rentals } = rentalIds.length
      ? await supabase.from('rental_transactions').select('id, transaction_code').in('id', rentalIds)
      : { data: [] };
    const rentalCode = new Map((rentals ?? []).map((r) => [r.id, r.transaction_code]));

    return (events ?? []).map((e) => {
      const payload = e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload) && Object.keys(e.payload).length > 0
        ? (e.payload as Record<string, unknown>)
        : null;
      return {
        id: e.id,
        event_type: e.event_type,
        severity: e.severity,
        message: e.message,
        payload,
        occurred_at: e.occurred_at,
        synced_at: e.synced_at,
        locker_name: e.locker_id ? (lockerName.get(e.locker_id) ?? null) : null,
        transaction_code: e.transaction_id ? (rentalCode.get(e.transaction_id) ?? null) : null,
      };
    });
  }

  const db = getLocalDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.q) {
    clauses.push('LOWER(COALESCE(e.message, \'\')) LIKE ?');
    params.push(`%${filters.q.toLowerCase()}%`);
  }
  if (filters.severity) {
    clauses.push('e.severity = ?');
    params.push(filters.severity);
  }
  if (filters.type) {
    clauses.push('e.event_type = ?');
    params.push(filters.type);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(filters.limit);

  const rows = db
    .prepare(
      `SELECT e.*, l.name AS locker_name, r.transaction_code,
              (SELECT sq.synced_at FROM sync_queue sq WHERE sq.entity = 'device_event' AND sq.entity_id = e.id ORDER BY sq.seq DESC LIMIT 1) AS synced_at
       FROM device_events e
       LEFT JOIN lockers l ON l.id = e.locker_id
       LEFT JOIN rentals r ON r.id = e.transaction_id
       ${where}
       ORDER BY e.occurred_at DESC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    id: string;
    event_type: string;
    severity: string;
    message: string | null;
    payload: string;
    occurred_at: string;
    synced_at: string | null;
    locker_name: string | null;
    transaction_code: string | null;
  }>;

  return rows.map((e) => {
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(e.payload) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) payload = parsed;
    } catch {
      // ignore
    }
    return {
      id: e.id,
      event_type: e.event_type,
      severity: e.severity,
      message: e.message,
      payload,
      occurred_at: e.occurred_at,
      synced_at: e.synced_at,
      locker_name: e.locker_name,
      transaction_code: e.transaction_code,
    };
  });
}

// ---------------------------------------------------------------------------
// 11. Audit Logs
// ---------------------------------------------------------------------------

export interface AuditLogViewRow {
  id: string | number;
  actor_type: ActorType;
  actor_label: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  previous_value: unknown;
  new_value: unknown;
  created_at: string;
}

export async function queryAuditLogs(filters: {
  q: string;
  actor: ActorType | '';
  limit: number;
}): Promise<AuditLogViewRow[]> {
  if (!isLocalBackend()) {
    const supabase = await createSupabaseServerClient();
    let query = supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(filters.limit);
    if (filters.q) {
      query = query.or(
        `action.ilike.%${filters.q.replace(/ /g, '_')}%,actor_label.ilike.%${filters.q}%,target_type.ilike.%${filters.q}%,reason.ilike.%${filters.q}%`,
      );
    }
    if (filters.actor) query = query.eq('actor_type', filters.actor);
    const { data, error } = await query;
    if (error) throw new Error('Failed to load audit logs');
    return data ?? [];
  }

  const db = getLocalDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.q) {
    const like = `%${filters.q.toLowerCase()}%`;
    const actionLike = `%${filters.q.toLowerCase().replace(/ /g, '_')}%`;
    clauses.push(
      `(LOWER(action) LIKE ? OR LOWER(COALESCE(actor_label, '')) LIKE ? OR LOWER(COALESCE(target_type, '')) LIKE ? OR LOWER(COALESCE(reason, '')) LIKE ?)`,
    );
    params.push(actionLike, like, like, like);
  }
  if (filters.actor) {
    clauses.push('actor_type = ?');
    params.push(filters.actor);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(filters.limit);

  const rows = db
    .prepare(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as Array<{
    id: string;
    actor_type: ActorType;
    actor_label: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    reason: string | null;
    previous_value: string | null;
    new_value: string | null;
    created_at: string;
  }>;

  const parseJson = (raw: string | null): unknown => {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };

  return rows.map((r) => ({
    id: r.id,
    actor_type: r.actor_type,
    actor_label: r.actor_label,
    action: r.action,
    target_type: r.target_type,
    target_id: r.target_id,
    reason: r.reason,
    previous_value: parseJson(r.previous_value),
    new_value: parseJson(r.new_value),
    created_at: r.created_at,
  }));
}

// Re-export operatingMinutesBetween / operatingCalendar if needed
export { operatingCalendar, operatingMinutesBetween };

// ---------------------------------------------------------------------------
// ID scans from students' phones (scan_sessions, Pi-local SQLite only;
// not synced to the cloud monitor).
// ---------------------------------------------------------------------------

export type IdScanFilter = '' | 'USED' | 'NOT_USED' | 'NO_ID';

export interface IdScanRow {
  id: string;
  code: string;
  status: 'WAITING' | 'SUBMITTED' | 'CONSUMED' | 'EXPIRED';
  qr_payload: string | null;
  created_at: string;
  submitted_at: string | null;
  consumed_at: string | null;
}

export async function queryIdScans(filters: { q: string; show: IdScanFilter; limit: number }): Promise<IdScanRow[]> {
  if (!isLocalBackend()) return [];
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.show === 'NO_ID') clauses.push('qr_payload IS NULL');
  else clauses.push('qr_payload IS NOT NULL');
  if (filters.show === 'USED') clauses.push(`status = 'CONSUMED'`);
  if (filters.show === 'NOT_USED') clauses.push(`status <> 'CONSUMED'`);
  if (filters.q) {
    clauses.push('LOWER(COALESCE(qr_payload, \'\')) LIKE ?');
    params.push(`%${filters.q.toLowerCase()}%`);
  }
  return getLocalDb()
    .prepare(
      `SELECT id, code, status, qr_payload, created_at, submitted_at, consumed_at FROM scan_sessions
       WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT ?`,
    )
    .all(...params, filters.limit) as IdScanRow[];
}
