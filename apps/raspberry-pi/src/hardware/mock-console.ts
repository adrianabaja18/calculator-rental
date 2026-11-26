import readline from 'node:readline';
import { DoorState } from '@calc-rental/shared';
import { DEV_RFID, DEV_STUDENT_QR } from '../db/dev-seed';
import type { KioskStore } from '../db/kiosk-store';
import type { KioskController } from '../kiosk/kiosk-controller';
import type { LcdScreen } from '../kiosk/lcd';
import type { MockHardware } from './mock';

/**
 * Keyboard control for the kiosk in HARDWARE_MODE=mock (development only).
 * Lets the team play the student and the sensors before any wiring exists.
 * For a clickable version in the browser, use the simulator: npm run sim:pi
 */

const STUDENTS: Record<string, string> = DEV_STUDENT_QR;
const CALC_UIDS: Record<string, string> = { '1': DEV_RFID.calc1, '2': DEV_RFID.calc2 };

const HELP = `
  Mock kiosk controls (type and press Enter):
    juan | maria | pedro | carlo | ana   scan that student's ID   (ana is blocked)
    blue <locker>                        press that locker's BLUE button (choose locker)
    red <locker>                         press that locker's RED button (door closed -> lock)
    coin <1|5|10|20>                     insert a coin
    take <locker>                        remove the calculator from a locker
    put <locker> <calc>                  place CALC-00<calc> into a locker (e.g. put 1 2 = wrong one)
    door <locker> <open|closed>          door sensor (default: no sensor)
    wait <minutes>                       move the kiosk clock forward (try: wait 240)
    state                                show kiosk state
    help                                 this list
`;

export function printLcd(screen: LcdScreen) {
  console.log(`\n   ┌────────────────┐\n   │${screen[0]}│\n   │${screen[1]}│\n   └────────────────┘`);
}

export function startMockConsole(opts: {
  hw: MockHardware;
  kiosk: KioskController;
  store: KioskStore;
  addMinutes: (minutes: number) => void;
}) {
  const { hw, kiosk, store } = opts;
  const channelOf = (locker: string) => store.listLockerHardware().find((l) => String(l.number) === locker)?.channel;

  console.log(HELP);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const [cmd = '', a, b] = line.trim().toLowerCase().split(/\s+/);
    if (STUDENTS[cmd]) return void kiosk.handleScan(STUDENTS[cmd]); // works with the real scanner too
    switch (cmd) {
      case 'blue':
      case 'red': {
        const ch = channelOf(a ?? '');
        return ch ? hw.buttons.press(cmd === 'blue' ? 'select' : 'close', ch) : console.log(`  usage: ${cmd} <locker>`);
      }
      case 'coin':
        return hw.coins.insert(Number(a));
      case 'take': {
        const ch = channelOf(a ?? '');
        return ch ? hw.rfid.place(ch, null) : console.log('  unknown locker');
      }
      case 'put': {
        const ch = channelOf(a ?? '');
        const uid = CALC_UIDS[b ?? ''];
        return ch && uid ? hw.rfid.place(ch, uid) : console.log('  usage: put <locker> <calc>');
      }
      case 'door': {
        const ch = channelOf(a ?? '');
        return ch ? hw.lockers.setDoor(ch, b === 'open' ? DoorState.OPEN : DoorState.CLOSED) : console.log('  unknown locker');
      }
      case 'wait':
        opts.addMinutes(Number(a) || 0);
        return console.log(`  clock moved forward ${Number(a) || 0} min`);
      case 'state':
        return console.log(`  ${kiosk.state}`);
      case '':
        return;
      default:
        return console.log(HELP);
    }
  });
  return rl;
}
