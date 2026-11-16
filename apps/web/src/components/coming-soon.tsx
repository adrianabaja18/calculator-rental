/**
 * Empty state for pages whose content is built in a later phase.
 * Lists what the page will contain so the team (and panel) can see the plan.
 */
export function ComingSoon({ phase, features }: { phase: number; features: string[] }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
      <p className="text-sm font-semibold text-slate-900">Built in Phase {phase}</p>
      <p className="mt-1 text-sm text-slate-500">This page will contain:</p>
      <ul className="mx-auto mt-3 inline-block space-y-1 text-left text-sm text-slate-600">
        {features.map((feature) => (
          <li key={feature} className="flex gap-2">
            <span aria-hidden="true" className="text-slate-400">
              •
            </span>
            {feature}
          </li>
        ))}
      </ul>
    </div>
  );
}
