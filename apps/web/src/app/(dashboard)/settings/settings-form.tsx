'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  PenaltyType,
  SUPPORTED_COIN_DENOMINATIONS,
  addOperatingMinutes,
  formatPhilippineDateTime,
  operatingCalendar,
  penaltyForMinutes,
  type SystemSettings,
} from '@calc-rental/shared';
import { useToast } from '@/components/ui/toast';
import { IDLE_RESULT } from '@/lib/action-result';
import { updateSettings } from './actions';

const input =
  'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/30 disabled:bg-slate-50 disabled:text-slate-500';

function Num({ label, name, value, hint, step = 1 }: { label: string; name: string; value: number | null; hint?: string; step?: number }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <input type="number" name={name} defaultValue={value ?? ''} step={step} min={0} className={input} />
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

function Check({ label, name, checked, hint }: { label: string; name: string; checked: boolean; hint?: string }) {
  return (
    <label className="flex gap-3">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
      <span>
        <span className="block text-sm font-medium text-slate-700">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-base font-semibold text-slate-900">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

const PREVIEW_MINUTES = [5, 15, 60, 120, 180, 240, 24 * 60];

/** Penalty preview recomputed from whatever is currently typed in the form. */
function preview(form: HTMLFormElement | null, fallback: SystemSettings) {
  if (!form) return fallback;
  const fd = new FormData(form);
  const n = (k: string, d: number) => (fd.get(k) === null || fd.get(k) === '' ? d : Number(fd.get(k)));
  return {
    ...fallback,
    penaltyEnabled: fd.get('penaltyEnabled') === 'on',
    penaltyType: (fd.get('penaltyType') as SystemSettings['penaltyType']) ?? fallback.penaltyType,
    penaltyAmount: n('penaltyAmount', fallback.penaltyAmount),
    penaltyIntervalMinutes: Math.max(1, n('penaltyIntervalMinutes', fallback.penaltyIntervalMinutes)),
    gracePeriodMinutes: n('gracePeriodMinutes', fallback.gracePeriodMinutes),
    maxPenalty: fd.get('maxPenalty') === '' ? null : n('maxPenalty', 0),
    penaltySteps: String(fd.get('penaltySteps') ?? '')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => {
        const [m, a] = l.split('=').map((p) => Number(p.trim()));
        return { upToMinutes: m ?? 0, amount: a ?? 0 };
      }),
    rentalDurationMinutes: Math.max(1, n('rentalDurationMinutes', fallback.rentalDurationMinutes)),
    operatingHoursStart: String(fd.get('operatingHoursStart') || fallback.operatingHoursStart),
    operatingHoursEnd: String(fd.get('operatingHoursEnd') || fallback.operatingHoursEnd),
    operatingDays: fd.getAll('operatingDays').map(Number),
    pauseClockOutsideHours: fd.get('pauseClockOutsideHours') === 'on',
  };
}

const WEEKDAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [7, 'Sun'],
] as const;

/** "A rental at Tue 3:00 PM is due …" with the hours currently typed in the form. */
function dueExample(s: SystemSettings): string {
  try {
    if (s.operatingDays.length === 0 || s.operatingHoursEnd <= s.operatingHoursStart) return 'Check the opening hours and days.';
    const start = new Date('2026-10-20T15:00:00+08:00'); // a Tuesday, 3:00 PM
    const due = addOperatingMinutes(start, s.rentalDurationMinutes, operatingCalendar(s));
    return `Example: borrowed Tuesday 3:00 PM → due ${formatPhilippineDateTime(due)}.`;
  } catch {
    return 'Check the opening hours and days.';
  }
}

export function SettingsForm({ settings, canEdit }: { settings: SystemSettings; canEdit: boolean }) {
  const [state, action, pending] = useActionState(updateSettings, IDLE_RESULT);
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(settings);
  const toast = useToast();

  useEffect(() => {
    if (state.at !== 0 && state.ok) toast('success', state.message);
  }, [state, toast]);

  const rows = PREVIEW_MINUTES.map((m) => ({
    minutes: m,
    pesos: penaltyForMinutes(m, draft).amountCentavos / 100,
  }));

  return (
    <form ref={formRef} action={action} onChange={() => setDraft(preview(formRef.current, settings))} className="space-y-6">
      {!canEdit && (
        <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          View only. Only a Super Admin can change settings.
        </p>
      )}
      {!state.ok && state.at !== 0 && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p>{state.message}</p>
          {state.fieldErrors && (
            <ul className="mt-1 list-disc pl-5">
              {Object.entries(state.fieldErrors).map(([field, message]) => (
                <li key={field}>
                  {field}: {message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <fieldset disabled={!canEdit} className="space-y-6">
        <Section title="Rental">
          <Num label="Rental fee (₱)" name="rentalFee" value={settings.rentalFee} hint="Whole pesos (coins only)" />
          <Num label="Rental duration (minutes)" name="rentalDurationMinutes" value={settings.rentalDurationMinutes} hint="180 = 3 hours" />
          <Check
            label="Unpaid penalty blocks new rentals"
            name="unpaidPenaltyBlocksRental"
            checked={settings.unpaidPenaltyBlocksRental}
          />
        </Section>

        <Section title="Operating hours (Philippine time)">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Opens</span>
            <input type="time" name="operatingHoursStart" defaultValue={settings.operatingHoursStart} className={input} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Closes</span>
            <input type="time" name="operatingHoursEnd" defaultValue={settings.operatingHoursEnd} className={input} />
          </label>
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-sm font-medium text-slate-700">Open on</legend>
            <div className="flex flex-wrap gap-4">
              {WEEKDAYS.map(([day, label]) => (
                <label key={day} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="operatingDays"
                    value={day}
                    defaultChecked={settings.operatingDays.includes(day)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="sm:col-span-2">
            <Check
              label="Rental time and late fees count only while open"
              name="pauseClockOutsideHours"
              checked={settings.pauseClockOutsideHours}
              hint="The clock pauses at closing time and continues when the kiosk opens again. Borrowing is only possible while open; returns are accepted any time the kiosk is on."
            />
            <p className="mt-2 text-sm text-slate-700">{dueExample(draft)}</p>
          </div>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-700">Closed dates (holidays, class suspensions)</span>
            <textarea
              name="closedDates"
              rows={3}
              defaultValue={settings.closedDates.join('\n')}
              placeholder={'2026-12-24\n2026-12-25'}
              className={`${input} font-mono`}
            />
            <span className="mt-1 block text-xs text-slate-500">One date per line (YYYY-MM-DD). The kiosk is closed and the clock pauses all day.</span>
          </label>
        </Section>

        <Section title="Overdue penalty">
          <Check label="Penalties enabled" name="penaltyEnabled" checked={settings.penaltyEnabled} />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Penalty type</span>
            <select name="penaltyType" defaultValue={settings.penaltyType} className={input}>
              <option value={PenaltyType.PER_INTERVAL}>Per started interval</option>
              <option value={PenaltyType.FLAT}>Flat (once)</option>
              <option value={PenaltyType.STEPPED}>Stepped tiers</option>
            </select>
          </label>
          <Num label="Penalty amount (₱)" name="penaltyAmount" value={settings.penaltyAmount} step={0.01} hint="Per interval, or the flat amount" />
          <Num label="Interval (minutes)" name="penaltyIntervalMinutes" value={settings.penaltyIntervalMinutes} hint="90 = every started 1.5 hours" />
          <Num label="Grace period (minutes)" name="gracePeriodMinutes" value={settings.gracePeriodMinutes} hint="Late by this much or less = free" />
          <Num label="Maximum penalty (₱)" name="maxPenalty" value={settings.maxPenalty} step={0.01} hint="Leave empty for no cap" />
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-700">Stepped tiers (only for Stepped)</span>
            <textarea
              name="penaltySteps"
              rows={3}
              defaultValue={settings.penaltySteps.map((s) => `${s.upToMinutes}=${s.amount}`).join('\n')}
              placeholder={'60=10\n180=20'}
              className={`${input} font-mono`}
            />
            <span className="mt-1 block text-xs text-slate-500">One tier per line: minutes late = pesos</span>
          </label>

          <div className="sm:col-span-2">
            <p className="mb-2 text-sm font-medium text-slate-700">
              Preview: what a late return costs{draft.pauseClockOutsideHours ? ' (hours counted while open)' : ''}
            </p>
            <div className="overflow-x-auto rounded-md border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600 uppercase">
                  <tr>
                    {rows.map((r) => (
                      <th key={r.minutes} className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                        {r.minutes < 60 ? `${r.minutes} min` : `${r.minutes / 60} h`} late
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {rows.map((r) => (
                      <td key={r.minutes} className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900">
                        ₱{r.pesos}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-xs text-slate-500">The penalty must be paid in coins before the return locker opens.</p>
          </div>
        </Section>

        <Section title="Coins and timeouts">
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-sm font-medium text-slate-700">Accepted coins</legend>
            <div className="flex flex-wrap gap-4">
              {SUPPORTED_COIN_DENOMINATIONS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="acceptedCoinDenominations"
                    value={c}
                    defaultChecked={settings.acceptedCoinDenominations.includes(c)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  ₱{c}
                </label>
              ))}
            </div>
          </fieldset>
          <Num label="Payment timeout (seconds)" name="paymentTimeoutSeconds" value={settings.paymentTimeoutSeconds} />
          <Num label="Take-calculator timeout (seconds)" name="removalTimeoutSeconds" value={settings.removalTimeoutSeconds} />
          <Num label="Return timeout (seconds)" name="returnTimeoutSeconds" value={settings.returnTimeoutSeconds} />
        </Section>

        <Section title="Offline behaviour">
          <Check
            label="Allow returns while offline"
            name="allowOfflineReturns"
            checked={settings.allowOfflineReturns}
            hint="Recommended: recovering calculators comes first"
          />
          <Check label="Allow rentals while offline" name="allowOfflineRentals" checked={settings.allowOfflineRentals} />
        </Section>
      </fieldset>

      {canEdit && (
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-800 disabled:opacity-60"
          >
            {pending ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
    </form>
  );
}
