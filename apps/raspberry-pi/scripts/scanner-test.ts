/**
 * Checks the ESP32-CAM QR scanner on its own — no kiosk, no database.
 *
 *   npm run scanner:pi                 lists serial ports
 *   npm run scanner:pi -- COM7         (Windows)   listen and print scans
 *   npm run scanner:pi -- /dev/ttyUSB0 (Raspberry Pi)
 *
 * Shows every decoded QR code and whether it is a valid school ID.
 */
import { parseStudentQr } from '@calc-rental/shared';
import { SerialPort } from 'serialport';
import { SerialQRScanner } from '../src/hardware/real/serial-qr-scanner';

const path = process.argv[2];

if (!path) {
  const ports = await SerialPort.list();
  console.log('\nSerial ports on this computer:');
  for (const p of ports) {
    const hint = /wch|1a86|ch340/i.test(`${p.manufacturer} ${p.vendorId}`) ? '  ← likely the ESP32-CAM (CH340)' : '';
    console.log(`  ${p.path}  ${p.manufacturer ?? ''} ${p.vendorId ? `(VID ${p.vendorId})` : ''}${hint}`);
  }
  console.log('\nRun again with the port, e.g.:  npm run scanner:pi -- COM7\n');
  process.exit(0);
}

const scanner = new SerialQRScanner(path, (level, message, data) => console.log(`[${level}] ${message}`, data ?? ''));
scanner.onScan((raw) => {
  const shown = JSON.stringify(raw); // makes TABs visible as \t
  const parsed = parseStudentQr(raw);
  console.log(`\nQR  ${shown}`);
  console.log(
    parsed.ok
      ? `    ✔ valid school ID: ${parsed.data.fullName} · ${parsed.data.studentNumber} · ${parsed.data.courseProgram}`
      : `    ✘ not a valid school ID: ${parsed.reason}`,
  );
});
scanner.start();
console.log(`Listening on ${path} at 115200 baud. Show a QR code to the camera. Ctrl+C to stop.`);

setInterval(() => {
  const s = scanner.status;
  if (s.connected && s.lastHeardAt === null) console.log('  (port open, but nothing from the ESP32 yet — is the firmware flashed?)');
}, 10_000);

process.on('SIGINT', () => {
  scanner.stop();
  process.exit(0);
});
