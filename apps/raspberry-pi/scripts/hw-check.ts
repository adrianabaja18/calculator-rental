/**
 * Hardware bring-up tool — test each part on its own, no kiosk logic.
 *
 *   npm run hwcheck:pi              on the Raspberry Pi (real pins)
 *   npm run hwcheck:pi -- --mock    on a laptop (simulated, to learn the tool)
 *
 * Commands:
 *   lcd [text]        show text (default: a test pattern)
 *   beep [ok|error|attention]
 *   unlock <locker>   pulse that locker's relay/solenoid (LOCK_PULSE_MS)
 *   rfid              read every reader once (shows real tag UIDs)
 *   watch             keep reading RFID; prints whenever a tag appears/leaves (Enter stops)
 *   quit
 * Coins are printed automatically as they are inserted.
 */
import readline from 'node:readline';
import { bridgeArgs, config } from '../src/config';
import { BridgeClient } from '../src/hardware/real/bridge-client';

const mock = process.argv.includes('--mock');
const channels = config.RFID_SPI.split(',').length;
const relays = config.RELAY_PINS.split(',').length;

const bridge = new BridgeClient({
  pythonBin: config.PYTHON_BIN,
  args: bridgeArgs(config, { mock }),
  log: (level, message) => console.log(`  [${level}] ${message}`),
});
bridge.onCoin((pulses) =>
  console.log(`\n  COIN: ${pulses} pulse(s) = P${pulses}${[1, 5, 10, 20].includes(pulses) ? '' : '  ← not a programmed value: check the coin selector setting'}`),
);
bridge.start();

const ready = await Promise.race([bridge.ready, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
if (!ready) {
  console.log(`\nThe hardware bridge did not start. Check that ${config.PYTHON_BIN} works and see docs/raspberry-pi.md §7.`);
  process.exit(1);
}
console.log(`\nHardware bridge ${ready.version} (${ready.mode}) — devices found:`, ready.devices);
console.log(`Pins: relays ${config.RELAY_PINS} (${config.RELAY_ACTIVE_LOW ? 'active-LOW' : 'active-HIGH'}), coin ${config.COIN_PIN}, buzzer ${config.BUZZER_PIN}, RFID SPI ${config.RFID_SPI}, LCD ${config.LCD_I2C_ADDRESS}`);
console.log('Commands: lcd [text] | beep [ok|error|attention] | unlock <1..n> | rfid | watch | quit\n');

let watching: NodeJS.Timeout | null = null;
const last = new Map<number, string | null>();

async function readAll(onlyChanges: boolean) {
  for (let ch = 1; ch <= channels; ch++) {
    const r = await bridge.request('read_rfid', { channel: ch }).catch((e: Error) => ({ uid: null, readerOk: false, message: e.message }));
    const uid = (r.uid as string | null) ?? null;
    if (onlyChanges && last.get(ch) === uid) continue;
    last.set(ch, uid);
    console.log(`  RFID reader ${ch}: ${r.readerOk ? (uid ? `tag ${uid}` : 'no tag') : 'NOT RESPONDING (check wiring / SPI enabled)'}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const [cmd = '', ...rest] = line.trim().split(/\s+/);
  if (watching) {
    clearInterval(watching);
    watching = null;
    console.log('  (watch stopped)');
    if (!cmd) return;
  }
  try {
    switch (cmd.toLowerCase()) {
      case 'lcd': {
        const text = rest.join(' ');
        await bridge.request('lcd', { lines: text ? [text.slice(0, 16), text.slice(16, 32)] : ['0123456789ABCDEF', 'LCD TEST OK  P20'] });
        return console.log('  LCD updated. Nothing visible? Adjust the blue contrast potentiometer, check address with: i2cdetect -y 1');
      }
      case 'beep':
        await bridge.request('beep', { pattern: rest[0] ?? 'ok' });
        return console.log('  beep sent');
      case 'unlock': {
        const ch = Number(rest[0]);
        if (!(ch >= 1 && ch <= relays)) return console.log(`  usage: unlock <1..${relays}>`);
        await bridge.request('unlock', { channel: ch, ms: config.LOCK_PULSE_MS });
        return console.log(`  relay ${ch} ON for ${config.LOCK_PULSE_MS} ms (you should hear the relay click twice and the solenoid pull in)`);
      }
      case 'rfid':
        return await readAll(false);
      case 'watch':
        console.log('  watching RFID readers… place/remove a calculator tag. Press Enter to stop.');
        last.clear();
        watching = setInterval(() => void readAll(true), 500);
        return;
      case 'quit':
      case 'exit':
        bridge.stop();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      case '':
        return;
      default:
        return console.log('  commands: lcd [text] | beep [ok|error|attention] | unlock <n> | rfid | watch | quit');
    }
  } catch (error) {
    console.log(`  ✘ ${(error as Error).message}`);
  }
});

process.on('SIGINT', () => {
  bridge.stop();
  process.exit(0);
});
