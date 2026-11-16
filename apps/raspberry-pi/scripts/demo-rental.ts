/**
 * Phase 5–6 demo — the borrowing rules and coin payment running on a throwaway in-memory
 * SQLite database with the development seed (fake students).
 *
 *   npm run demo:pi
 *
 * No hardware, no network, nothing saved. The real kiosk state machine,
 * coin acceptor and LCD come in Phases 6, 9 and 11; here we call the
 * rental service directly and print what the LCD would show.
 */
import { randomUUID } from 'node:crypto';
import { formatPaymentLine, formatPhilippineTime } from '@calc-rental/shared';
import { PaymentService } from '../src/payment/payment-service';
import { DEV_IDS, seedDevData } from '../src/db/dev-seed';
import { KioskStore } from '../src/db/kiosk-store';
import { openLocalDatabase } from '../src/db/sqlite';
import { RentalService } from '../src/rental/rental-service';

const store = new KioskStore(openLocalDatabase(':memory:'));
seedDevData(store, { sensorsReady: true, nowIso: new Date().toISOString() });
const service = new RentalService(store, { deviceCode: 'DEVICE-CALC-KIOSK-001' });
const payments = new PaymentService(store, service);

const peso = (centavos: number) => `P${centavos / 100}`;
function lcd(line1: string, line2 = '') {
  const pad = (s: string) => s.slice(0, 16).padEnd(16);
  console.log(`   ┌────────────────┐\n   │${pad(line1)}│\n   │${pad(line2)}│\n   └────────────────┘`);
}
function step(title: string) {
  console.log(`\n▶ ${title}`);
}

console.log('==============================================================');
console.log(' Demo: borrowing + coin payment on the kiosk (SQLite-first)');
console.log('==============================================================');

step('Idle');
lcd('SYSTEM READY', 'Scan Student ID');

step('Juan scans his ID');
const juan = service.startRental('JUAN DELA CRUZ\t2022100001\tBSCpE');
if (!juan.ok) throw new Error(juan.message);
const q = juan.quote;
lcd(q.student.fullName, `Rental: ${peso(q.feeCentavos)}`);
lcd(`Time: ${q.durationMinutes / 60} Hours`, `Locker ${q.locker.number}`);
console.log(`   rental ${q.transactionCode} is PAYMENT_PENDING, locker ${q.locker.number} RESERVED`);

step('Coin acceptor enabled; Juan inserts P5, P5, then P10');
const session = payments.openSession(q.rentalId);
if (!session.ok) throw new Error(session.message);
const pulses = (pesos: number, eventId = randomUUID()) => ({ eventId, pulseCount: pesos, occurredAt: new Date().toISOString() });
const repeated = pulses(5);
for (const c of [repeated, pulses(5), pulses(10)]) {
  const outcome = payments.insertCoin(session.sessionId, c);
  if (outcome.kind === 'credited') lcd(formatPaymentLine(outcome.progress), outcome.paidNow ? 'PAID' : 'Insert coins');
  if (c === repeated) {
    console.log(`   same coin event delivered twice → ${payments.insertCoin(session.sessionId, repeated).kind} (counted once)`);
  }
}
console.log(`   rental is now ${store.getRental(q.rentalId)!.status}`);

step('An extra P1 arrives after payment is complete');
console.log(`   → ${JSON.stringify(payments.insertCoin(session.sessionId, pulses(1)))} (flagged for refund, never reused)`);

step('Unlock the assigned locker');
console.log(`   startDispensing → ${JSON.stringify(service.startDispensing(q.rentalId))}`);
lcd(`LOCKER ${q.locker.number} OPEN`, 'Take Calculator');

step('RFID still sees the calculator (not taken yet)');
console.log(`   confirmRemoval → ${JSON.stringify(service.confirmRemoval(q.rentalId, { detectedRfidUid: '04-A1-B2-C3-D4' }))}`);

step('RFID no longer sees it → rental ACTIVE');
const removed = service.confirmRemoval(q.rentalId, { detectedRfidUid: null });
if (!removed.ok) throw new Error(removed.message);
lcd('RENTAL SUCCESS', `Due ${formatPhilippineTime(removed.dueAt)}`);

step('Juan scans again (duplicate rental attempt)');
const again = service.startRental('JUAN DELA CRUZ\t2022100001\tBSCpE');
console.log(`   ${again.ok ? 'UNEXPECTED SUCCESS' : `${again.code}: ${again.message}`}`);
lcd('ACTIVE RENTAL', 'Return it first');

step('Blocked student scans');
const ana = service.startRental('ANA GARCIA\t2022100004\tBSCpE');
console.log(`   ${ana.ok ? 'UNEXPECTED SUCCESS' : `${ana.code}: ${ana.message}`}`);
lcd('ACCOUNT BLOCKED', 'See an officer');

step('Random QR code');
const bad = service.startRental('https://example.com/promo');
console.log(`   ${bad.ok ? 'UNEXPECTED SUCCESS' : `${bad.code}: ${bad.message}`}`);
lcd('INVALID ID', 'Scan again');

step('Maria borrows the remaining calculator, then Pedro tries');
const maria = service.startRental('MARIA SANTOS\t2023100002\tBSCE');
console.log(`   Maria: ${maria.ok ? `reserved locker ${maria.quote.locker.number}` : maria.message}`);
const pedro = service.startRental('PEDRO REYES\t2024100003\tBSIT');
console.log(`   Pedro: ${pedro.ok ? 'UNEXPECTED SUCCESS' : `${pedro.code}: ${pedro.message}`}`);
lcd('NO CALCULATOR', 'AVAILABLE');

step('Maria walks away without paying → reservation cancelled');
if (maria.ok) console.log(`   cancelRental → ${JSON.stringify(service.cancelRental(maria.quote.rentalId, 'PAYMENT_TIMEOUT'))}`);

step('Inventory: RFID reader in Locker 2 sees nothing although the calculator should be there');
store.setLockerSensors(DEV_IDS.locker2, { rfidState: 'NO_TAG', detectedRfidUid: null }, new Date().toISOString());
const pedro2 = service.startRental('PEDRO REYES\t2024100003\tBSIT');
console.log(`   Pedro: ${pedro2.ok ? 'UNEXPECTED SUCCESS' : `${pedro2.code}: ${pedro2.message}`}`);
console.log('   → Locker 2 was NOT handed out; an INVENTORY_MISMATCH warning was logged.');

console.log('\n--------------------------------------------------------------');
const rentals = store.db.prepare(`SELECT transaction_code, status FROM rentals ORDER BY created_at`).all();
console.log(' Rentals in SQLite:', rentals);
const events = store.db.prepare(`SELECT event_type, COUNT(*) AS n FROM device_events GROUP BY event_type`).all();
console.log(' Device events:', events);
console.log(` Changes waiting in the sync outbox for Supabase: ${store.pendingSyncCount()}`);
console.log('--------------------------------------------------------------\n');
