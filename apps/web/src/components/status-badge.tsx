/**
 * Small coloured status pill. Reused by every dashboard table later
 * (calculators, lockers, rentals, devices).
 */

export type BadgeTone = 'green' | 'blue' | 'red' | 'amber' | 'gray';

const toneClasses: Record<BadgeTone, string> = {
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-600/30',
  blue: 'bg-blue-50 text-blue-800 ring-blue-600/30',
  red: 'bg-red-50 text-red-800 ring-red-600/30',
  amber: 'bg-amber-50 text-amber-900 ring-amber-600/40',
  gray: 'bg-slate-100 text-slate-700 ring-slate-500/30',
};

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ring-1 ring-inset ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}
