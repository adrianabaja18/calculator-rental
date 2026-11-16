/**
 * Coin acceptor rules (Allan 1239 Pro Max, multi-coin pulse output).
 *
 * The selector is programmed so that PULSES = PESO VALUE
 * (₱1 = 1 pulse, ₱5 = 5, ₱10 = 10, ₱20 = 20). See docs/raspberry-pi.md §4.1.
 */

/** Default quiet time that ends one coin's pulse train (medium/slow pulse setting). */
export const COIN_PULSE_GAP_MS = 200;

/**
 * Splits raw pulse timestamps (ms) into coins: a gap longer than `gapMs`
 * starts a new coin. Returns the pulse count of each coin, in order.
 */
export function groupPulses(pulseTimesMs: readonly number[], gapMs = COIN_PULSE_GAP_MS): number[] {
  const coins: number[] = [];
  let previous = -Infinity;
  for (const t of pulseTimesMs) {
    if (t - previous > gapMs) coins.push(0);
    coins[coins.length - 1]! += 1;
    previous = t;
  }
  return coins;
}

/** Peso value of a pulse train, or null if it isn't an accepted coin (noise, wrong setting). */
export function coinValueFromPulses(pulseCount: number, acceptedDenominations: readonly number[]): number | null {
  return Number.isInteger(pulseCount) && acceptedDenominations.includes(pulseCount) ? pulseCount : null;
}

export interface PaymentProgress {
  requiredCentavos: number;
  receivedCentavos: number;
  remainingCentavos: number;
  /** Coin selectors can't give change: anything above the fee is recorded, not returned. */
  overpaidCentavos: number;
  complete: boolean;
}

export function paymentProgress(requiredCentavos: number, receivedCentavos: number): PaymentProgress {
  return {
    requiredCentavos,
    receivedCentavos,
    remainingCentavos: Math.max(0, requiredCentavos - receivedCentavos),
    overpaidCentavos: Math.max(0, receivedCentavos - requiredCentavos),
    complete: receivedCentavos >= requiredCentavos,
  };
}

/** LCD line, e.g. "Payment P5/P20". */
export function formatPaymentLine(progress: PaymentProgress): string {
  return `Payment P${progress.receivedCentavos / 100}/P${progress.requiredCentavos / 100}`;
}
