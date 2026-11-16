'use client';

import { useEffect, useState } from 'react';
import { rentalCountdown } from '@calc-rental/shared';

/**
 * "Due in 01:42:15" / "Overdue by 00:32:16", ticking every second in the
 * browser from due_at (spec §25). Renders nothing until mounted so the
 * server's clock never mismatches the browser's.
 */
export function Countdown({ dueAt }: { dueAt: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!now) return <span className="text-slate-400">—</span>;
  const { overdue, text } = rentalCountdown(dueAt, now);
  return (
    <span className={`whitespace-nowrap ${overdue ? 'font-semibold text-red-700' : 'text-slate-700'}`}>
      <span className="text-xs font-medium uppercase tracking-wide">{overdue ? 'Overdue by' : 'Due in'}</span>{' '}
      <span className="font-mono tabular-nums">{text}</span>
    </span>
  );
}
