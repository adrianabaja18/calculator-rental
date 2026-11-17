# hw-bridge

Small Python process that does the Raspberry Pi's pin, SPI and I2C I/O for the Node.js kiosk. **It only performs I/O; all rules and decisions stay in Node.**

- `hw_bridge.py`: gpiozero (relays, coin pulses, buzzer, optional door switches), spidev (2× RC522), smbus2 (16×2 LCD)
- Protocol: JSON lines on stdin/stdout (see the docstring at the top of the file)
- `--mock` simulates everything. The Node tests in `src/hardware/real/bridge.test.ts` use it, so the bridge is exercised on every `npm test`.

The kiosk starts it automatically when `HARDWARE_MODE=real`. To try it on its own:
```bash
python3 hw_bridge.py --help
```
```bash
npm run hwcheck:pi
```
Wiring and Pi setup are in `docs/raspberry-pi.md`.
