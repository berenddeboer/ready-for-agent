/**
 * Shared repository filter for sticky Jobs chrome (Pipeline board).
 * Hidden on Repos/Completed until those surfaces can honor the selection.
 */
import { useQuery } from "@tanstack/react-query"
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import { type Repository, repositoriesQuery } from "./repositories-query.js"
import { cx, ui } from "./ui.js"

type JobsRepositoryFilterValue = {
  readonly repositories: readonly Repository[]
  readonly selectedRepositoryId: string | null
  readonly setSelectedRepositoryId: (repositoryId: string | null) => void
}

const JobsRepositoryFilterContext =
  createContext<JobsRepositoryFilterValue | null>(null)

export function JobsRepositoryFilterProvider({
  children,
}: {
  readonly children: ReactNode
}) {
  const { data: repositories = [] } = useQuery(repositoriesQuery)
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<
    string | null
  >(null)

  // Drop selection if the repository disappears (delete / membership change).
  useEffect(() => {
    if (selectedRepositoryId === null) return
    if (repositories.some((repo) => repo.id === selectedRepositoryId)) return
    setSelectedRepositoryId(null)
  }, [repositories, selectedRepositoryId])

  const value = useMemo(
    () => ({
      repositories,
      selectedRepositoryId,
      setSelectedRepositoryId,
    }),
    [repositories, selectedRepositoryId],
  )

  return (
    <JobsRepositoryFilterContext.Provider value={value}>
      {children}
    </JobsRepositoryFilterContext.Provider>
  )
}

export function useJobsRepositoryFilter(): JobsRepositoryFilterValue {
  const value = useContext(JobsRepositoryFilterContext)
  if (value === null) {
    throw new Error(
      "useJobsRepositoryFilter must be used within JobsRepositoryFilterProvider",
    )
  }
  return value
}

/** Sticky filter strip: All sources + one button per repository. */
export function JobsRepositoryFilters({
  className,
}: {
  readonly className?: string
} = {}) {
  const { repositories, selectedRepositoryId, setSelectedRepositoryId } =
    useJobsRepositoryFilter()

  if (repositories.length === 0) return null

  return (
    <fieldset className={cx(ui.repositoryFilters, className)}>
      <legend className="sr-only">Filter jobs by repository</legend>
      <button
        type="button"
        className={ui.repositoryFilter}
        aria-pressed={selectedRepositoryId === null}
        onClick={() => setSelectedRepositoryId(null)}
      >
        All sources
      </button>
      {repositories.map((repository) => (
        <button
          type="button"
          className={ui.repositoryFilter}
          aria-pressed={selectedRepositoryId === repository.id}
          key={repository.id}
          onClick={() => setSelectedRepositoryId(repository.id)}
        >
          {repository.projectPath}
        </button>
      ))}
    </fieldset>
  )
}
