'use client';

import { useEffect, useState } from 'react';
import { rentalCountdown, type OperatingCalendar } from '@calc-rental/shared';

/**
 * "Due in 01:42:15" / "Overdue by 00:32:16", ticking every second in the
 * browser from due_at (spec §25). With operating hours, only open time
 * counts and the clock shows "paused" while the kiosk is closed.
 * Renders nothing until mounted so the server's clock never mismatches the browser's.
 */
export function Countdown({ dueAt, calendar }: { dueAt: string; calendar: OperatingCalendar }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!now) return <span className="text-slate-400">—</span>;
  const { overdue, text, paused } = rentalCountdown(dueAt, now, calendar);
  return (
    <span className={`whitespace-nowrap ${overdue ? 'font-semibold text-red-700' : 'text-slate-700'}`}>
      <span className="text-xs font-medium uppercase tracking-wide">{overdue ? 'Overdue by' : 'Due in'}</span>{' '}
      <span className="font-mono tabular-nums">{text}</span>
      {paused && <span className="ml-1 text-xs font-normal text-slate-500">(paused, closed)</span>}
    </span>
  );
}
