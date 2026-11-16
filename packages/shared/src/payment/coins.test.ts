import { describe, expect, it } from 'vitest';
import { coinValueFromPulses, formatPaymentLine, groupPulses, paymentProgress } from './coins';

describe('groupPulses', () => {
  it('splits pulse trains on gaps longer than 200 ms', () => {
    // ₱1, then ₱5 (5 pulses 50 ms apart), then ₱1
    const pulses = [0, 400, 450, 500, 550, 600, 1000];
    expect(groupPulses(pulses)).toEqual([1, 5, 1]);
  });

  it('handles no pulses', () => {
    expect(groupPulses([])).toEqual([]);
  });

  it('respects a custom gap', () => {
    expect(groupPulses([0, 150, 300], 100)).toEqual([1, 1, 1]);
  });
});

describe('coinValueFromPulses', () => {
  const accepted = [1, 5, 10, 20];
  it.each([1, 5, 10, 20])('%i pulses = ₱%i', (pulses) => {
    expect(coinValueFromPulses(pulses, accepted)).toBe(pulses);
  });
  it.each([0, 2, 7, 21, 1.5])('rejects %s pulses (noise or misprogrammed selector)', (pulses) => {
    expect(coinValueFromPulses(pulses, accepted)).toBeNull();
  });
  it('rejects a real coin the officers have disabled in Settings', () => {
    expect(coinValueFromPulses(20, [1, 5, 10])).toBeNull();
  });
});

describe('paymentProgress', () => {
  it('tracks partial payment', () => {
    const p = paymentProgress(2000, 500);
    expect(p).toEqual({ requiredCentavos: 2000, receivedCentavos: 500, remainingCentavos: 1500, overpaidCentavos: 0, complete: false });
    expect(formatPaymentLine(p)).toBe('Payment P5/P20');
  });

  it('completes exactly at the fee', () => {
    expect(paymentProgress(2000, 2000)).toMatchObject({ complete: true, remainingCentavos: 0, overpaidCentavos: 0 });
  });

  it('records overpayment (no change can be given)', () => {
    expect(paymentProgress(2000, 2500)).toMatchObject({ complete: true, overpaidCentavos: 500 });
  });
});
