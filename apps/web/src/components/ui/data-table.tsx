/**
 * Table building blocks. On small screens the table scrolls sideways
 * inside its card instead of breaking the page layout.
 */

export function TableCard({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-sm">{children}</table>
      </div>
      {footer && <div className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">{footer}</div>}
    </div>
  );
}

export function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`bg-slate-50 px-4 py-2.5 text-left text-xs font-semibold tracking-wide whitespace-nowrap text-slate-600 uppercase ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-slate-700 ${className}`}>{children}</td>;
}

export function EmptyRow({ colSpan, title, hint }: { colSpan: number; title: string; hint?: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12 text-center">
        <p className="text-sm font-medium text-slate-900">{title}</p>
        {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
      </td>
    </tr>
  );
}

/** Small secondary line under a table cell's main value. */
export function Sub({ children }: { children: React.ReactNode }) {
  return <div className="mt-0.5 text-xs text-slate-500">{children}</div>;
}
