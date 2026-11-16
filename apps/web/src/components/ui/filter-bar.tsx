/**
 * Search + status filter. A plain GET form: filters live in the URL
 * (?q=juan&status=BLOCKED), so they survive refresh and can be shared,
 * and the page filters on the server. Works even without JavaScript.
 */
export function FilterBar({
  q,
  status,
  statusOptions,
  placeholder,
}: {
  q: string;
  status: string;
  statusOptions: { value: string; label: string }[];
  placeholder: string;
}) {
  const control =
    'rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/30';
  return (
    <form method="get" role="search" className="mb-4 flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="q">
        Search
      </label>
      <input id="q" name="q" type="search" defaultValue={q} placeholder={placeholder} className={`${control} w-full sm:w-72`} />
      <label className="sr-only" htmlFor="status">
        Status
      </label>
      <select id="status" name="status" defaultValue={status} className={control}>
        <option value="">All statuses</option>
        {statusOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
        Apply
      </button>
      {(q || status) && (
        <a href="?" className="text-sm font-medium text-blue-700 hover:underline">
          Clear
        </a>
      )}
    </form>
  );
}
