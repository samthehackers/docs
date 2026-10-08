export default function Loading() {
  return <div role="status" aria-label="Loading" className="space-y-4"><div className="h-8 w-64 animate-pulse rounded bg-muted" /><div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-lg bg-muted" />)}</div></div>;
}
