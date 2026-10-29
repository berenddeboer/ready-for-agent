import { describeTimes, formatTime } from "./statistics-model.js"

export const statisticsPanel = "min-w-0 border border-line-soft bg-panel p-5"
export const statisticsKicker =
  "font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-ink-dim"
export const statisticsControl =
  "border border-line-soft bg-panel px-3 py-2 text-sm hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"

export function StatisticsMetric({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return (
    <div className="border-l border-line-soft pl-4">
      <p className={statisticsKicker}>{label}</p>
      <p className="my-2 font-mono text-2xl font-bold tracking-tight xl:text-3xl">
        {value}
      </p>
      <p className="text-xs text-ink-dim">{note}</p>
    </div>
  )
}
export function StatisticsHeading({
  title,
  subtitle,
}: {
  title: string
  subtitle: string
}) {
  return (
    <>
      <h3 className="text-lg font-bold tracking-tight">{title}</h3>
      <p className="mt-1 text-xs text-ink-dim">{subtitle}</p>
    </>
  )
}
export function TimingHistogram({
  values,
  color,
  label,
}: {
  values: number[]
  color: string
  label: string
}) {
  if (values.length === 0)
    return (
      <p className="py-12 text-sm text-ink-dim">
        No complete timings for this selection.
      </p>
    )
  const stats = describeTimes(values)
  const width = Math.max(1, (stats.p90 ?? 1) / 5)
  const bins = Array.from({ length: 7 }, (_, i) => ({
    start: i * width,
    end: (i + 1) * width,
    count: values.filter(
      (value) => value >= i * width && (i === 6 || value < (i + 1) * width),
    ).length,
  }))
  const max = Math.max(1, ...bins.map((bin) => bin.count))
  return (
    <>
      <div
        role="img"
        aria-label={`${label}: ${bins.map((bin, i) => `${formatTime(bin.start)} to ${i === 6 ? "maximum" : formatTime(bin.end)}: ${bin.count}`).join("; ")}`}
        className="mt-6 flex h-48 items-end gap-2 border-b border-ink"
      >
        {bins.map((bin) => (
          <div
            key={bin.start}
            className="flex h-full min-w-0 flex-1 flex-col justify-end text-center"
          >
            <span className="mb-1 font-mono text-xs">{bin.count}</span>
            <div
              style={{
                height: `${(bin.count / max) * 82}%`,
                minHeight: bin.count ? 2 : 0,
                background: color,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2 text-center font-mono text-[10px] text-ink-dim">
        {bins.map((bin, i) => (
          <span key={bin.start} className="min-w-0 flex-1">
            {i === 6 ? `${formatTime(bin.start)}+` : `< ${formatTime(bin.end)}`}
          </span>
        ))}
      </div>
      <p className="mt-3 text-center text-xs text-ink-dim">
        {label} · equal-width bins, final bin includes the long tail
      </p>
    </>
  )
}
