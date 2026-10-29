import { useState } from "react"
import {
  StatisticsHeading as Heading,
  StatisticsMetric as Metric,
  TimingHistogram,
  statisticsControl as control,
  statisticsKicker as kicker,
  statisticsPanel as panel,
} from "./statistics-charts.js"
import {
  type TimingLane,
  type TimingTask,
  timingLaneColors as colors,
  describeTimes,
  formatTime,
  timingLaneLabels as labels,
  laneStatistics,
  measureAttempts,
  percentile,
  stepLabel,
  stepStatistics,
  sum,
  timingLanes,
} from "./statistics-model.js"

type Props = { tasks: TimingTask[]; onSelect: (task: TimingTask) => void }

export function TimingOverview({
  tasks,
  lane,
  setLane,
  onSelect,
  onStep,
}: Props & {
  lane: TimingLane
  setLane: (lane: TimingLane) => void
  onStep: (step: string) => void
}) {
  const stats = laneStatistics(tasks, lane)
  const values = tasks.flatMap((t) =>
    t.lanes[lane].executionMs === null ? [] : [t.lanes[lane].executionMs],
  )
  const steps = stepStatistics(tasks).filter((s) => s.lane === lane)
  const ordered = [...tasks]
    .filter((t) => t.lanes[lane].executionMs !== null)
    .sort(
      (a, b) =>
        (b.lanes[lane].executionMs ?? 0) - (a.lanes[lane].executionMs ?? 0),
    )
  const recorded = sum(tasks.map((t) => t.lanes[lane].recordedMs))
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <fieldset className="flex gap-2" aria-label="Lane">
          {timingLanes.map((name) => (
            <button
              key={name}
              type="button"
              className={control}
              aria-pressed={lane === name}
              style={
                lane === name
                  ? { background: colors[name], color: "white" }
                  : {}
              }
              onClick={() => setLane(name)}
            >
              {labels[name]}
            </button>
          ))}
        </fieldset>
        <span className={kicker}>
          Recorded execution · includes all attempts
        </span>
      </div>
      <div className="mb-7 grid grid-cols-2 gap-6 lg:grid-cols-4">
        <Metric
          label="Typical task · median"
          value={formatTime(stats.median)}
          note={`${stats.count} tasks with complete ${labels[lane]} timings`}
        />
        <Metric
          label="Average"
          value={formatTime(stats.average)}
          note="Sensitive to unusually long tasks"
        />
        <Metric
          label="90% finish within"
          value={formatTime(stats.p90)}
          note="P90 · within this completed cohort"
        />
        <Metric
          label="Time on repeats"
          value={
            recorded
              ? `${((stats.repeatMs / recorded) * 100).toFixed(1)}%`
              : "—"
          }
          note="Excludes polling and postponed attempts"
        />
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <section className={panel}>
          <Heading
            title="The average hides the long tail"
            subtitle={`${labels[lane]} execution per Work Item · ${formatTime(stats.total)} total across included tasks`}
          />
          <TimingHistogram
            values={values}
            color={colors[lane]}
            label="Execution per Work Item"
          />
        </section>
        <section className={panel}>
          <Heading
            title="Compare the lanes"
            subtitle="Each lane includes only tasks with complete recorded timings in that lane"
          />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  {["Lane", "n", "Median", "Average", "P90"].map((h) => (
                    <th key={h} className="p-2 text-xs">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {timingLanes.map((name) => {
                  const row = laneStatistics(tasks, name)
                  return (
                    <tr key={name} className="border-t border-line-ghost">
                      <th className="p-2">{labels[name]}</th>
                      <td className="p-2">{row.count}</td>
                      <td className="whitespace-nowrap p-2 font-mono text-xs">
                        {formatTime(row.median)}
                      </td>
                      <td className="whitespace-nowrap p-2 font-mono text-xs">
                        {formatTime(row.average)}
                      </td>
                      <td className="whitespace-nowrap p-2 font-mono text-xs">
                        {formatTime(row.p90)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-5 border-t border-line-soft pt-4">
            <p className={kicker}>Execution ≠ elapsed</p>
            <p className="mt-3 flex justify-between gap-3 text-sm">
              Median total execution
              <strong className="font-mono">
                {formatTime(
                  percentile(
                    tasks.flatMap((t) =>
                      t.executionMs === null ? [] : [t.executionMs],
                    ),
                    0.5,
                  ),
                )}
              </strong>
            </p>
            <p className="mt-2 flex justify-between gap-3 text-sm">
              Median elapsed
              <strong className="font-mono">
                {formatTime(
                  percentile(
                    tasks.flatMap((t) =>
                      t.elapsedMs === null ? [] : [t.elapsedMs],
                    ),
                    0.5,
                  ),
                )}
              </strong>
            </p>
            <p className="mt-3 text-xs text-ink-dim">
              Elapsed is creation to completion, including waiting and pauses.
              Lane medians do not add up to the total median.
            </p>
          </div>
        </section>
      </div>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section className={panel}>
          <Heading
            title={`Inside ${labels[lane]}`}
            subtitle="Step averages per task, including repeated attempts · select a step"
          />
          {steps.length === 0 && (
            <p className="mt-4 text-sm">No recorded steps in this lane.</p>
          )}
          {steps.map((row) => (
            <button
              key={row.step}
              type="button"
              onClick={() => onStep(row.step)}
              className="mt-3 flex w-full justify-between gap-4 border-t border-line-ghost pt-3 text-left text-sm hover:underline"
            >
              <span>
                {stepLabel(row.step)}{" "}
                <span className="text-ink-dim">· n={row.perTask.count}</span>
              </span>
              <strong className="whitespace-nowrap font-mono">
                {formatTime(row.perTask.average)} ↗
              </strong>
            </button>
          ))}
        </section>
        <section className={panel}>
          <Heading
            title="Start with these outliers"
            subtitle={`Three longest ${labels[lane]} executions · select a task`}
          />
          {ordered.slice(0, 3).map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              value={formatTime(task.lanes[lane].executionMs)}
              onSelect={onSelect}
            />
          ))}
          {ordered.length === 0 && (
            <p className="mt-4 text-sm">No complete timings in this lane.</p>
          )}
        </section>
      </div>
    </>
  )
}

function TaskRow({
  task,
  value,
  onSelect,
}: {
  task: TimingTask
  value: string
  onSelect: (task: TimingTask) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(task)}
      className="mt-3 flex w-full justify-between gap-4 border-t border-line-ghost pt-3 text-left text-sm hover:underline"
    >
      <span>
        <span className="font-mono text-xs text-ink-dim">
          {task.label} · {task.repository}
        </span>
        <span className="mt-1 block font-semibold">{task.title}</span>
      </span>
      <strong className="shrink-0 font-mono">{value} ↗</strong>
    </button>
  )
}

export function TimingExplorer({ tasks, onSelect }: Props) {
  const [mode, setMode] = useState("all")
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState("execution")
  const [page, setPage] = useState(0)
  const cutoff = percentile(
    tasks.flatMap((t) => (t.executionMs === null ? [] : [t.executionMs])),
    0.9,
  )
  const filtered = tasks
    .filter(
      (t) =>
        (mode !== "tail" ||
          (t.executionMs !== null &&
            cutoff !== null &&
            t.executionMs > cutoff)) &&
        (mode !== "repeats" || t.lanes.pr.repeats >= 3) &&
        `${t.label} ${t.title} ${t.repository}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "elapsed"
        ? (b.elapsedMs ?? -1) - (a.elapsedMs ?? -1)
        : sort === "repeats"
          ? b.lanes.pr.repeats - a.lanes.pr.repeats
          : (b.executionMs ?? -1) - (a.executionMs ?? -1),
    )
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / 20) - 1),
  )
  const plotted = filtered.filter(
    (t) => t.executionMs !== null && t.elapsedMs !== null,
  )
  const maxElapsed = Math.max(1, ...tasks.map((t) => t.elapsedMs ?? 0))
  const maxExecution = Math.max(1, ...tasks.map((t) => t.executionMs ?? 0))
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[220px_1fr]">
      <aside className="grid gap-5">
        <div>
          <p className={kicker}>Investigation desk</p>
          <h3 className="mt-2 text-2xl font-bold">Find the unusual.</h3>
          <p className="mt-2 text-sm text-ink-dim">
            Separate long execution from long elapsed time.
          </p>
        </div>
        <div className="grid gap-2">
          {[
            { id: "all", label: "All tasks" },
            { id: "tail", label: "Long tail · above P90" },
            { id: "repeats", label: "PR repeats · 3 or more" },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${control} text-left ${mode === item.id ? "border-ink font-bold" : ""}`}
              aria-pressed={mode === item.id}
              onClick={() => {
                setMode(item.id)
                setPage(0)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-ink-dim">
          Long-tail threshold: {formatTime(cutoff)} total execution, calculated
          before search and outlier filters.
        </p>
        <Metric
          label="Matching tasks"
          value={String(filtered.length)}
          note={`${tasks.length} in the selected cohort`}
        />
      </aside>
      <div className="min-w-0">
        <section className={panel}>
          <Heading
            title="Working or waiting?"
            subtitle="Each point is a Work Item · select a point or table row for its attempts"
          />
          {/* biome-ignore lint/a11y/useSemanticElements: SVG grouping cannot use a fieldset. */}
          <svg
            viewBox="0 0 820 275"
            className="mt-4 w-full"
            role="group"
            aria-label="Task execution versus elapsed time"
          >
            <title>
              Execution versus elapsed time. Table below contains all matching
              Work Items.
            </title>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line
                  x1="80"
                  x2="780"
                  y1={220 - f * 190}
                  y2={220 - f * 190}
                  stroke="var(--line-ghost)"
                />
                <text
                  x="70"
                  y={224 - f * 190}
                  textAnchor="end"
                  fill="var(--ink-dim)"
                  fontSize="11"
                >
                  {formatTime(maxExecution * f)}
                </text>
                <text
                  x={80 + f * 700}
                  y="243"
                  textAnchor="middle"
                  fill="var(--ink-dim)"
                  fontSize="11"
                >
                  {formatTime(maxElapsed * f)}
                </text>
              </g>
            ))}
            {cutoff !== null && (
              <>
                <line
                  x1="80"
                  x2="780"
                  y1={220 - (cutoff / maxExecution) * 190}
                  y2={220 - (cutoff / maxExecution) * 190}
                  stroke="var(--ink-dim)"
                  strokeDasharray="4 5"
                />
                <text
                  x="780"
                  y={214 - (cutoff / maxExecution) * 190}
                  textAnchor="end"
                  fill="var(--ink-dim)"
                  fontSize="11"
                >
                  P90 execution
                </text>
              </>
            )}
            {plotted.map((task) => (
              // biome-ignore lint/a11y/useSemanticElements: SVG points use keyboard-accessible button roles.
              <circle
                key={task.id}
                cx={80 + ((task.elapsedMs ?? 0) / maxElapsed) * 700}
                cy={220 - ((task.executionMs ?? 0) / maxExecution) * 190}
                r="4"
                opacity=".75"
                fill={task.lanes.pr.repeats >= 3 ? colors.pr : colors.build}
                role="button"
                tabIndex={0}
                aria-label={`Inspect ${task.label}: ${formatTime(task.executionMs)} execution, ${formatTime(task.elapsedMs)} elapsed`}
                className="cursor-pointer focus:stroke-ink focus:stroke-2"
                onClick={() => onSelect(task)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    onSelect(task)
                  }
                }}
              >
                <title>
                  {task.label} · {task.title}
                </title>
              </circle>
            ))}
            <text
              x="430"
              y="271"
              textAnchor="middle"
              fill="var(--ink-dim)"
              fontSize="12"
            >
              Elapsed →
            </text>
            <text
              x="15"
              y="135"
              transform="rotate(-90 15 135)"
              textAnchor="middle"
              fill="var(--ink-dim)"
              fontSize="12"
            >
              Execution →
            </text>
          </svg>
          <p className="mt-2 text-xs text-ink-dim">
            Blue: fewer than 3 PR repeats · Green: 3+ PR repeats.{" "}
            {filtered.length - plotted.length} tasks omitted from chart due to
            missing timings.
          </p>
        </section>
        <div className="my-4 flex flex-wrap justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            Find task
            <input
              className={`${control} min-w-0`}
              value={search}
              placeholder="ID, title, repository…"
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            Sort by
            <select
              className={control}
              value={sort}
              onChange={(e) => {
                setSort(e.target.value)
                setPage(0)
              }}
            >
              <option value="execution">Most execution</option>
              <option value="elapsed">Longest elapsed</option>
              <option value="repeats">Most PR repeats</option>
            </select>
          </label>
        </div>
        <div className="overflow-x-auto border border-line-soft">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {["Task", "Execution", "Elapsed", "PR repeats"].map((h) => (
                  <th key={h} className="border-b border-ink p-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered
                .slice(currentPage * 20, currentPage * 20 + 20)
                .map((task) => (
                  <tr key={task.id} className="border-b border-line-ghost">
                    <td className="p-3">
                      <button
                        type="button"
                        className="text-left hover:underline"
                        onClick={() => onSelect(task)}
                      >
                        <span className="font-mono text-xs text-ink-dim">
                          {task.label} · {task.repository}
                        </span>
                        <strong className="mt-1 block">{task.title} ↗</strong>
                      </button>
                    </td>
                    <td className="whitespace-nowrap p-3 font-mono">
                      {formatTime(task.executionMs)}
                      {task.executionMs === null && (
                        <span className="block font-display text-xs">
                          Incomplete timings
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap p-3 font-mono">
                      {formatTime(task.elapsedMs)}
                    </td>
                    <td className="p-3 font-mono">{task.lanes.pr.repeats}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <p className="p-5">No tasks match these filters.</p>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3 text-sm">
          <span>
            {filtered.length
              ? `${currentPage * 20 + 1}–${Math.min(filtered.length, currentPage * 20 + 20)}`
              : "0"}{" "}
            of {filtered.length}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className={control}
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className={control}
              disabled={(currentPage + 1) * 20 >= filtered.length}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function TimingRepeats({
  tasks,
  onSelect,
  onStep,
}: Props & { onStep: (step: string) => void }) {
  const [lane, setLane] = useState<TimingLane>("pr")
  const ranking = timingLanes
    .map((lane) => ({ lane, ...laneStatistics(tasks, lane) }))
    .sort((a, b) => b.repeatMs - a.repeatMs)
  const total = sum(ranking.map((row) => row.repeatMs))
  const top = ranking[0]
  const eligible = tasks.filter(
    (t) => t.lanes[lane].timed > 0 || t.lanes[lane].missing > 0,
  )
  const leaders = [...tasks]
    .filter((t) => t.lanes[lane].repeats > 0)
    .sort((a, b) => b.lanes[lane].repeatMs - a.lanes[lane].repeatMs)
  return (
    <>
      <section className="grid gap-7 border-y-2 border-ink py-6 md:grid-cols-[1.6fr_1fr]">
        <div>
          <p className={kicker}>Prioritise by time, not just retry count</p>
          <h3 className="mt-3 text-3xl font-extrabold">
            {total > 0 && top
              ? `${labels[top.lane]} accounts for ${((top.repeatMs / total) * 100).toFixed(0)}% of repeat execution.`
              : "No repeated execution recorded."}
          </h3>
          <p className="mt-3 text-sm text-ink-dim">
            Extra scheduled attempts of the same step. Watch polling, postponed
            attempts and cancelled runs are excluded from repeats. Internal fix
            rounds are not separately counted.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Metric
            label="Repeat execution"
            value={formatTime(total)}
            note="Recorded time, not estimated waste"
          />
          <Metric
            label="Tasks with repeats"
            value={`${tasks.filter((t) => t.repeats > 0).length}/${tasks.length}`}
            note="At least one extra execution attempt"
          />
        </div>
      </section>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <section>
          <Heading
            title="Where is repeated work concentrated?"
            subtitle="Select a lane to inspect its extra attempts"
          />
          <div className="mt-5 grid gap-4">
            {ranking.map((row, i) => (
              <button
                key={row.lane}
                type="button"
                className={`${panel} text-left ${lane === row.lane ? "border-ink" : ""}`}
                aria-pressed={lane === row.lane}
                onClick={() => setLane(row.lane)}
              >
                <div className="flex justify-between gap-4 font-bold">
                  <span>
                    0{i + 1} / {labels[row.lane]}
                  </span>
                  <span className="font-mono">{formatTime(row.repeatMs)}</span>
                </div>
                <div className="my-3 h-5 bg-line-ghost">
                  <div
                    className="h-full"
                    style={{
                      width: `${(row.repeatMs / Math.max(1, top?.repeatMs ?? 0)) * 100}%`,
                      background: colors[row.lane],
                    }}
                  />
                </div>
                <p className="text-xs text-ink-dim">
                  {row.affected} of {row.observed} tasks with recorded lane
                  attempts repeated ·{" "}
                  {row.observed
                    ? ((100 * row.affected) / row.observed).toFixed(0)
                    : 0}
                  %
                </p>
              </button>
            ))}
          </div>
        </section>
        <section className={panel}>
          <Heading
            title={`${labels[lane]}: how many extra attempts?`}
            subtitle={`${eligible.length} tasks with recorded attempts in this lane`}
          />
          <div className="my-6 grid gap-4">
            {[0, 1, 2, 3, 4].map((n) => {
              const count = eligible.filter((t) =>
                n === 4
                  ? t.lanes[lane].repeats >= 4
                  : t.lanes[lane].repeats === n,
              ).length
              return (
                <div
                  key={n}
                  className="grid grid-cols-[65px_1fr_40px] items-center gap-3 text-sm"
                >
                  <span>{n === 4 ? "4+" : n} extra</span>
                  <div className="h-6 bg-line-ghost">
                    <div
                      className="h-full"
                      style={{
                        width: `${(100 * count) / Math.max(1, eligible.length)}%`,
                        background: colors[lane],
                      }}
                    />
                  </div>
                  <span className="text-right font-mono">{count}</span>
                </div>
              )
            })}
          </div>
          <p className="border-t border-line-soft pt-4 text-sm">
            Repeated review or investigation can be legitimate work. Open a task
            to see failed, interrupted and successful attempts with their
            recorded reason codes.
          </p>
        </section>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className={panel}>
          <Heading
            title="Which steps repeat?"
            subtitle="Ranked by recorded time on extra attempts"
          />
          {stepStatistics(tasks)
            .filter((s) => s.lane === lane && s.repeats > 0)
            .sort((a, b) => b.repeatMs - a.repeatMs)
            .map((row) => (
              <button
                key={row.step}
                type="button"
                className="mt-3 flex w-full justify-between gap-3 border-t border-line-ghost pt-3 text-left text-sm hover:underline"
                onClick={() => onStep(row.step)}
              >
                <span>
                  {stepLabel(row.step)} · {row.repeats} extras
                </span>
                <strong>{formatTime(row.repeatMs)} ↗</strong>
              </button>
            ))}
        </section>
        <section className={panel}>
          <Heading
            title={`${labels[lane]} repeat-time leaders`}
            subtitle="Select a Work Item to inspect every attempt"
          />
          {leaders.slice(0, 3).map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              value={formatTime(task.lanes[lane].repeatMs)}
              onSelect={onSelect}
            />
          ))}
          {leaders.length === 0 && (
            <p className="mt-4 text-sm">No repeated attempts in this lane.</p>
          )}
        </section>
      </div>
    </>
  )
}

export function TimingSteps({
  tasks,
  step,
  onStep,
  onSelect,
}: Props & { step: string; onStep: (step: string) => void }) {
  const [unit, setUnit] = useState("task")
  const rows = stepStatistics(tasks)
  const selected = rows.find((row) => row.step === step)
  const observations = tasks.map((task) => ({
    task,
    timing: measureAttempts(task.attempts.filter((a) => a.step === step)),
  }))
  const values = observations.flatMap(({ timing }) =>
    unit === "attempt"
      ? timing.details.flatMap((a) => (a.duration === null ? [] : [a.duration]))
      : timing.executionMs === null
        ? []
        : [timing.executionMs],
  )
  const stats = describeTimes(values)
  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Heading
            title="Every lifecycle step, measured"
            subtitle="Totals and percentiles for the selected completed cohort"
          />
          <p className="mt-2 text-sm text-ink-dim">
            Per task sums all attempts of that step. Per attempt measures
            individual executions.
          </p>
        </div>
        <label className="grid gap-1 text-xs">
          Measurement
          <select
            className={control}
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          >
            <option value="task">Per task · includes repeats</option>
            <option value="attempt">Per attempt</option>
          </select>
        </label>
      </div>
      <div className="overflow-x-auto border border-line-soft">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {[
                "Step",
                "Samples",
                "Total",
                "Average",
                "Median",
                "P90",
                "Extra attempts",
                "Failed attempts",
              ].map((h) => (
                <th
                  key={h}
                  className="whitespace-nowrap border-b border-ink p-3"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const stats = unit === "task" ? row.perTask : row.perAttempt
              return (
                <tr
                  key={row.step}
                  className={`border-b border-line-ghost ${step === row.step ? "bg-line-ghost" : ""}`}
                >
                  <th className="p-3">
                    <button
                      type="button"
                      aria-pressed={step === row.step}
                      className="text-left hover:underline"
                      onClick={() => onStep(row.step)}
                    >
                      {stepLabel(row.step)} ↘
                    </button>
                  </th>
                  <td className="p-3 font-mono">{stats.count}</td>
                  {[stats.total, stats.average, stats.median, stats.p90].map(
                    (value, i) => (
                      <td
                        key={["total", "average", "median", "p90"][i]}
                        className="whitespace-nowrap p-3 font-mono"
                      >
                        {formatTime(stats.count ? value : null)}
                      </td>
                    ),
                  )}
                  <td className="p-3 font-mono">{row.repeats}</td>
                  <td className="p-3 font-mono">{row.failures}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <section className="mt-6 border-l-4 border-lane-build pl-4">
        <h3 className="text-xl font-bold">{stepLabel(step)}</h3>
        {step === "pre_commit" ? (
          <p className="mt-2 text-sm text-ink-dim">
            This is the standalone Pre-Commit step: the hook plus any agent fix
            loop. Hooks rerun inside Review are included in Review, and
            individual hook commands are not timed separately in historical
            data.
          </p>
        ) : step === "review" ? (
          <p className="mt-2 text-sm text-ink-dim">
            Review includes reviewing, applying findings, pre-commit reruns and
            reassessment inside its fix loop. Those internal phases are not
            separately timed in historical data.
          </p>
        ) : step === "watch_pr_status_checks" ? (
          <p className="mt-2 text-sm text-ink-dim">
            Watch observes external checks. Its execution includes any waiting
            inside the step; extra observations are not classified as retries.
          </p>
        ) : null}
      </section>
      {!selected ? (
        <p className="mt-4 text-sm">
          No {stepLabel(step)} attempts in this cohort. Select another step
          above.
        </p>
      ) : (
        <>
          <div className="my-6 grid grid-cols-2 gap-5 lg:grid-cols-4">
            <Metric
              label="Average"
              value={formatTime(stats.average)}
              note={`${stats.count} ${unit === "task" ? "tasks" : "attempts"}`}
            />
            <Metric
              label="Median"
              value={formatTime(stats.median)}
              note="Middle observation"
            />
            <Metric
              label="P90"
              value={formatTime(stats.p90)}
              note="90% at or below this duration"
            />
            <Metric
              label="Missing timings"
              value={String(selected.missing)}
              note="Excluded from full-duration statistics"
            />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <section className={panel}>
              <Heading
                title={`${stepLabel(step)} distribution`}
                subtitle={`Recorded execution per ${unit}`}
              />
              <TimingHistogram
                values={values}
                color={selected.lane ? colors[selected.lane] : "var(--ink)"}
                label={`Execution per ${unit}`}
              />
            </section>
            <section className={panel}>
              <Heading
                title="Longest tasks for this step"
                subtitle="All attempts summed per Work Item · select to inspect"
              />
              {observations
                .filter((row) => row.timing.executionMs !== null)
                .sort(
                  (a, b) =>
                    (b.timing.executionMs ?? 0) - (a.timing.executionMs ?? 0),
                )
                .slice(0, 5)
                .map(({ task, timing }) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    value={formatTime(timing.executionMs)}
                    onSelect={onSelect}
                  />
                ))}
            </section>
          </div>
        </>
      )}
    </>
  )
}
