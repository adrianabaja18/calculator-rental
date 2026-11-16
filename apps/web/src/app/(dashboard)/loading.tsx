/** Skeleton shown while a dashboard page loads its data. */
export default function DashboardLoading() {
  return (
    <div role="status" aria-label="Loading" className="animate-pulse space-y-6">
      <div className="h-8 w-56 rounded bg-slate-200" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-24 rounded-lg bg-slate-200" />
        ))}
      </div>
      <div className="h-64 rounded-lg bg-slate-200" />
    </div>
  );
}
