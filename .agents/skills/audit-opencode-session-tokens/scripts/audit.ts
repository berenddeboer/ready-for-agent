import { existsSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { Database } from "bun:sqlite"

type Options = {
  harnessDb: string
  opencodeDb?: string
  repository?: string
  limit: number
  json: boolean
}

type Row = Record<string, string | number | bigint | null>

const usage = `Usage:
  bun audit.ts --repository owner/name [options]

Options:
  --harness-db <path>   Harness SQLite database (default: tmp/ready-for-agent.db)
  --opencode-db <path>  OpenCode SQLite database (default: opencode db path)
  --repository <o/r>    Repository identity (required)
  --limit <count>       Number of root Sessions (default: 30)
  --json                Emit stable JSON instead of Markdown
  --help                Show this help`

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

const parseArgs = (args: readonly string[]): Options => {
  const options: Options = {
    harnessDb: "tmp/ready-for-agent.db",
    limit: 30,
    json: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--help") {
      console.log(usage)
      process.exit(0)
    }
    if (arg === "--json") {
      options.json = true
      continue
    }
    const value = args[index + 1]
    if (value === undefined) fail(`Missing value for ${arg}\n\n${usage}`)
    if (arg === "--harness-db") options.harnessDb = value
    else if (arg === "--opencode-db") options.opencodeDb = value
    else if (arg === "--repository") options.repository = value
    else if (arg === "--limit") {
      const parsed = Number.parseInt(value, 10)
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
        fail("--limit must be an integer between 1 and 1000")
      }
      options.limit = parsed
    } else fail(`Unknown argument: ${arg}\n\n${usage}`)
    index += 1
  }

  if (options.repository === undefined) {
    fail(`--repository is required\n\n${usage}`)
  }
  return options
}

const absolute = (path: string): string =>
  isAbsolute(path) ? path : resolve(process.cwd(), path)

const resolveOpencodeDb = (configured: string | undefined): string => {
  if (configured !== undefined) return absolute(configured)
  const result = spawnSync("opencode", ["db", "path"], {
    encoding: "utf8",
    timeout: 5_000,
  })
  if (result.status !== 0) {
    fail(
      `Could not resolve the OpenCode database with \`opencode db path\`: ${result.stderr.trim()}`,
    )
  }
  const path = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "")
  return absolute(path ?? fail("`opencode db path` returned no path"))
}

const number = (value: Row[string]): number => {
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string") return Number(value)
  return 0
}

const format = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })

const formatNumber = (value: Row[string]): string => format.format(number(value))

const markdownTable = (
  headers: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string => {
  const heading = `| ${headers.join(" | ")} |`
  const divider = `|${headers.map(() => "---").join("|")}|`
  return [
    heading,
    divider,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n")
}

const options = parseArgs(process.argv.slice(2))
const repository = options.repository as string
const separator = repository.indexOf("/")
if (separator < 1 || separator === repository.length - 1) {
  fail("--repository must have the form owner/name")
}
const owner = repository.slice(0, separator)
const repo = repository.slice(separator + 1)
const harnessDb = absolute(options.harnessDb)
const opencodeDb = resolveOpencodeDb(options.opencodeDb)

if (!existsSync(harnessDb)) fail(`Harness database does not exist: ${harnessDb}`)
if (!existsSync(opencodeDb)) fail(`OpenCode database does not exist: ${opencodeDb}`)

const db = new Database(opencodeDb, { readonly: true, create: false })
db.exec("PRAGMA busy_timeout = 5000")
db.query("ATTACH DATABASE ? AS rfa").run(harnessDb)
db.exec("PRAGMA query_only = ON")

const params = [owner, repo, options.limit] as const
const all = <T extends Row>(sql: string): readonly T[] =>
  db.query(sql).all(...params) as readonly T[]
const one = <T extends Row>(sql: string): T => {
  const row = db.query(sql).get(...params) as T | null
  return row ?? fail("Audit query returned no result")
}

const cohort = `
  rfa_roots AS (
    SELECT wi.session_id AS root_id,
           wi.id AS work_item_id,
           wi.github_issue_number,
           wi.issue_title,
           wi.state,
           wi.created_at AS work_item_created_at
    FROM rfa.work_item wi
    JOIN rfa.repository r ON r.id = wi.repository_id
    WHERE lower(r.github_owner) = lower(?1)
      AND lower(r.github_repo) = lower(?2)
      AND wi.agent_backend = 'opencode'
      AND wi.session_id IS NOT NULL
    ORDER BY wi.created_at DESC
    LIMIT ?3
  ),
  cohort AS (
    SELECT rfa_roots.*,
           s.time_created AS session_created_at
    FROM rfa_roots
    JOIN session s ON s.id = rfa_roots.root_id
  )`

const repositoryRow = db
  .query(
    `SELECT id, github_owner, github_repo, local_path, selected_agent_backend
     FROM rfa.repository
     WHERE lower(github_owner) = lower(?) AND lower(github_repo) = lower(?)
     LIMIT 1`,
  )
  .get(owner, repo) as Row | null
if (repositoryRow === null) fail(`Repository not found in Harness database: ${repository}`)

const eligible = db
  .query(
    `SELECT COUNT(*) AS count
     FROM rfa.work_item wi
     JOIN rfa.repository r ON r.id = wi.repository_id
     WHERE lower(r.github_owner) = lower(?)
       AND lower(r.github_repo) = lower(?)
       AND wi.agent_backend = 'opencode'
       AND wi.session_id IS NOT NULL`,
  )
  .get(owner, repo) as Row

const scope = one<Row>(`
  WITH ${cohort}
  SELECT (SELECT COUNT(*) FROM rfa_roots) AS selected_work_items,
         COUNT(*) AS roots,
         (SELECT COUNT(*) FROM rfa_roots) - COUNT(*) AS missing_sessions,
         MIN(datetime(session_created_at / 1000, 'unixepoch')) AS first_session,
         MAX(datetime(session_created_at / 1000, 'unixepoch')) AS last_session,
         SUM(CASE WHEN state = 'complete' THEN 1 ELSE 0 END) AS complete,
         SUM(CASE WHEN state != 'complete' THEN 1 ELSE 0 END) AS not_complete
  FROM cohort`)

const rootTokens = one<Row>(`
  WITH ${cohort},
  ranked AS (
    SELECT s.tokens_input AS input,
           s.tokens_output AS output,
           s.tokens_reasoning AS reasoning,
           s.tokens_cache_read AS cache_read,
           s.tokens_cache_write AS cache_write,
           s.tokens_input + s.tokens_output + s.tokens_reasoning +
             s.tokens_cache_read + s.tokens_cache_write AS total,
           ROW_NUMBER() OVER (ORDER BY s.tokens_input + s.tokens_output +
             s.tokens_reasoning + s.tokens_cache_read + s.tokens_cache_write) AS rn,
           COUNT(*) OVER () AS n
    FROM cohort c
    JOIN session s ON s.id = c.root_id
  ),
  totals AS (
    SELECT COUNT(*) AS sessions,
           SUM(input) AS input,
           SUM(output) AS output,
           SUM(reasoning) AS reasoning,
           SUM(cache_read) AS cache_read,
           SUM(cache_write) AS cache_write,
           SUM(total) AS total,
           ROUND(AVG(total), 0) AS average,
           MIN(total) AS minimum,
           MAX(total) AS maximum
    FROM ranked
  ),
  quantiles AS (
    SELECT MAX(CASE WHEN rn = CAST((n + 1) / 2 AS INTEGER) THEN total END) AS median,
           MAX(CASE WHEN rn = CAST((9 * n + 9) / 10 AS INTEGER) THEN total END) AS p90
    FROM ranked
  )
  SELECT totals.*, quantiles.median, quantiles.p90,
         ROUND(100.0 * totals.cache_read / NULLIF(totals.total, 0), 1) AS cache_read_pct
  FROM totals, quantiles`)

const inclusiveTokens = one<Row>(`
  WITH RECURSIVE ${cohort},
  tree(root_id, session_id, depth) AS (
    SELECT root_id, root_id, 0 FROM cohort
    UNION ALL
    SELECT tree.root_id, s.id, tree.depth + 1
    FROM tree
    JOIN session s ON s.parent_id = tree.session_id
  ),
  per_root AS (
    SELECT tree.root_id,
           SUM(s.tokens_input) AS input,
           SUM(s.tokens_output) AS output,
           SUM(s.tokens_reasoning) AS reasoning,
           SUM(s.tokens_cache_read) AS cache_read,
           SUM(s.tokens_cache_write) AS cache_write,
           SUM(s.tokens_input + s.tokens_output + s.tokens_reasoning +
             s.tokens_cache_read + s.tokens_cache_write) AS total,
           SUM(CASE WHEN tree.depth > 0 THEN 1 ELSE 0 END) AS child_sessions,
           SUM(CASE WHEN tree.depth > 0 THEN s.tokens_input + s.tokens_output +
             s.tokens_reasoning + s.tokens_cache_read + s.tokens_cache_write ELSE 0 END) AS child_tokens
    FROM tree
    JOIN session s ON s.id = tree.session_id
    GROUP BY tree.root_id
  ),
  ranked AS (
    SELECT *, ROW_NUMBER() OVER (ORDER BY total) AS rn, COUNT(*) OVER () AS n
    FROM per_root
  ),
  totals AS (
    SELECT COUNT(*) AS roots,
           SUM(input) AS input,
           SUM(output) AS output,
           SUM(reasoning) AS reasoning,
           SUM(cache_read) AS cache_read,
           SUM(cache_write) AS cache_write,
           SUM(total) AS total,
           ROUND(AVG(total), 0) AS average,
           MIN(total) AS minimum,
           MAX(total) AS maximum,
           SUM(child_sessions) AS child_sessions,
           SUM(child_tokens) AS child_tokens
    FROM ranked
  ),
  quantiles AS (
    SELECT MAX(CASE WHEN rn = CAST((n + 1) / 2 AS INTEGER) THEN total END) AS median,
           MAX(CASE WHEN rn = CAST((9 * n + 9) / 10 AS INTEGER) THEN total END) AS p90
    FROM ranked
  )
  SELECT totals.*, quantiles.median, quantiles.p90,
         ROUND(100.0 * totals.cache_read / NULLIF(totals.total, 0), 1) AS cache_read_pct,
         ROUND(100.0 * totals.child_tokens / NULLIF(totals.total, 0), 1) AS child_pct
  FROM totals, quantiles`)

const modelCalls = all<Row>(`
  WITH RECURSIVE ${cohort},
  tree(root_id, session_id, depth) AS (
    SELECT root_id, root_id, 0 FROM cohort
    UNION ALL
    SELECT tree.root_id, s.id, tree.depth + 1
    FROM tree
    JOIN session s ON s.parent_id = tree.session_id
  ),
  calls AS (
    SELECT tree.depth,
           COALESCE(json_extract(m.data, '$.tokens.input'), 0) AS input,
           COALESCE(json_extract(m.data, '$.tokens.output'), 0) AS output,
           COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) AS reasoning,
           COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) AS cache_read
    FROM tree
    JOIN message m ON m.session_id = tree.session_id
    WHERE json_extract(m.data, '$.role') = 'assistant'
  )
  SELECT CASE WHEN depth = 0 THEN 'root' ELSE 'child' END AS scope,
         COUNT(*) AS calls,
         ROUND(AVG(input + cache_read), 0) AS average_context,
         ROUND(AVG(output + reasoning), 0) AS average_generated,
         SUM(input + output + reasoning + cache_read) AS tokens
  FROM calls
  GROUP BY scope
  ORDER BY scope`)

const contextGrowth = one<Row>(`
  WITH ${cohort},
  calls AS (
    SELECT m.session_id,
           COALESCE(json_extract(m.data, '$.tokens.input'), 0) +
             COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) AS context_tokens,
           ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created, m.id) AS first_rn,
           ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC, m.id DESC) AS last_rn
    FROM message m
    JOIN cohort c ON c.root_id = m.session_id
    WHERE json_extract(m.data, '$.role') = 'assistant'
  )
  SELECT ROUND(AVG(CASE WHEN first_rn = 1 THEN context_tokens END), 0) AS average_first_context,
         MIN(CASE WHEN first_rn = 1 THEN context_tokens END) AS minimum_first_context,
         MAX(CASE WHEN first_rn = 1 THEN context_tokens END) AS maximum_first_context,
         ROUND(AVG(CASE WHEN last_rn = 1 THEN context_tokens END), 0) AS average_last_context,
         MIN(CASE WHEN last_rn = 1 THEN context_tokens END) AS minimum_last_context,
         MAX(CASE WHEN last_rn = 1 THEN context_tokens END) AS maximum_last_context
  FROM calls`)

const lifecycle = all<Row>(`
  WITH ${cohort},
  prompt_text AS (
    SELECT m.session_id,
           m.id AS user_message_id,
           ltrim(json_extract(p.data, '$.text'), char(34)) AS text
    FROM cohort c
    JOIN message m ON m.session_id = c.root_id
    JOIN part p ON p.message_id = m.id
    WHERE json_extract(m.data, '$.role') = 'user'
      AND json_extract(p.data, '$.type') = 'text'
  ),
  classified AS (
    SELECT session_id, user_message_id,
      CASE
        WHEN text LIKE 'Process the following PR Status Check results%' THEN 'status_check_work'
        WHEN text LIKE 'Based only on the PR status-check work%' THEN 'status_check_outcome_only'
        WHEN text LIKE 'Make one focused recovery attempt to process the PR Status Check Handoff%' THEN 'status_check_recovery'
        WHEN text LIKE 'Resolve the merge conflict%' THEN 'merge_conflict_work'
        WHEN text LIKE 'Based only on the PR merge-conflict resolution work%' THEN 'merge_conflict_outcome_only'
        WHEN text LIKE '/review%' THEN 'review'
        WHEN text LIKE 'The previous reviewing pass reported Review Findings%' THEN 'review_apply'
        WHEN text LIKE 'A prior build-model pass applied low-severity Review Findings%' THEN 'review_rerun_assessment'
        WHEN text LIKE 'The repository pre-commit hook failed%' THEN 'pre_commit_fix'
        WHEN text LIKE 'Create a git commit%' THEN 'commit'
        WHEN text LIKE 'Create a pull request%' THEN 'create_pr'
        WHEN text LIKE 'Implement GitHub issue%' THEN 'implement'
        WHEN text LIKE 'Continue implementing GitHub issue%' THEN 'implement_retry'
        WHEN text LIKE 'The worktree and branch appear unchanged%' THEN 'assess_changes'
        ELSE 'other'
      END AS category
    FROM prompt_text
  ),
  assistant_usage AS (
    SELECT m.session_id,
           json_extract(m.data, '$.parentID') AS user_message_id,
           SUM(COALESCE(json_extract(m.data, '$.tokens.input'), 0)) AS input,
           SUM(COALESCE(json_extract(m.data, '$.tokens.output'), 0)) AS output,
           SUM(COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0)) AS reasoning,
           SUM(COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0)) AS cache_read,
           COUNT(*) AS model_calls
    FROM message m
    JOIN cohort c ON c.root_id = m.session_id
    WHERE json_extract(m.data, '$.role') = 'assistant'
    GROUP BY m.session_id, json_extract(m.data, '$.parentID')
  )
  SELECT category,
         COUNT(*) AS user_turns,
         COUNT(DISTINCT classified.session_id) AS sessions,
         SUM(COALESCE(model_calls, 0)) AS model_calls,
         SUM(COALESCE(input, 0)) AS input,
         SUM(COALESCE(output, 0)) AS output,
         SUM(COALESCE(reasoning, 0)) AS reasoning,
         SUM(COALESCE(cache_read, 0)) AS cache_read,
         SUM(COALESCE(input, 0) + COALESCE(output, 0) + COALESCE(reasoning, 0) + COALESCE(cache_read, 0)) AS total
  FROM classified
  LEFT JOIN assistant_usage USING (session_id, user_message_id)
  GROUP BY category
  ORDER BY total DESC`)

const statusKinds = all<Row>(`
  WITH ${cohort},
  prompts AS (
    SELECT m.session_id,
           m.id AS user_id,
           ltrim(json_extract(p.data, '$.text'), char(34)) AS text
    FROM message m
    JOIN cohort c ON c.root_id = m.session_id
    JOIN part p ON p.message_id = m.id
    WHERE json_extract(m.data, '$.role') = 'user'
      AND json_extract(p.data, '$.type') = 'text'
      AND ltrim(json_extract(p.data, '$.text'), char(34)) LIKE 'Process the following PR Status Check results%'
  ),
  usage AS (
    SELECT m.session_id,
           json_extract(m.data, '$.parentID') AS user_id,
           SUM(COALESCE(json_extract(m.data, '$.tokens.input'), 0) +
             COALESCE(json_extract(m.data, '$.tokens.output'), 0) +
             COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) +
             COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0)) AS tokens
    FROM message m
    JOIN cohort c ON c.root_id = m.session_id
    WHERE json_extract(m.data, '$.role') = 'assistant'
    GROUP BY m.session_id, json_extract(m.data, '$.parentID')
  )
  SELECT CASE
           WHEN text LIKE '%Diagnose and fix these failing checks%'
             AND text LIKE '%One or more automated reviews may have completed%' THEN 'red_and_green'
           WHEN text LIKE '%Diagnose and fix these failing checks%' THEN 'red_only'
           WHEN text LIKE '%One or more automated reviews may have completed%' THEN 'green_only'
           ELSE 'neither'
         END AS handoff_kind,
         COUNT(*) AS turns,
         COUNT(DISTINCT prompts.session_id) AS sessions,
         ROUND(AVG(length(text)), 0) AS average_prompt_chars,
         SUM(COALESCE(usage.tokens, 0)) AS tokens
  FROM prompts
  LEFT JOIN usage USING (session_id, user_id)
  GROUP BY handoff_kind
  ORDER BY tokens DESC`)

const statusOutcomes = all<Row>(`
  WITH ${cohort},
  user_prompts AS (
    SELECT m.session_id,
           m.id AS user_id,
           ltrim(COALESCE(json_extract(p.data, '$.text'), ''), char(34)) AS text,
           ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created, m.id) AS seq
    FROM message m
    JOIN cohort c ON c.root_id = m.session_id
    LEFT JOIN part p ON p.message_id = m.id AND json_extract(p.data, '$.type') = 'text'
    WHERE json_extract(m.data, '$.role') = 'user'
  ),
  assistant_results AS (
    SELECT m.session_id,
           json_extract(m.data, '$.parentID') AS user_id,
           MAX(CASE WHEN json_extract(p.data, '$.type') = 'text'
             AND json_extract(p.data, '$.text') LIKE '%READY_FOR_AGENT_RESULT:%'
             THEN json_extract(p.data, '$.text') END) AS result_text
    FROM message m
    JOIN cohort c ON c.root_id = m.session_id
    LEFT JOIN part p ON p.message_id = m.id
    WHERE json_extract(m.data, '$.role') = 'assistant'
    GROUP BY m.session_id, json_extract(m.data, '$.parentID')
  ),
  assistant_usage AS (
    SELECT m.session_id,
           json_extract(m.data, '$.parentID') AS user_id,
           SUM(COALESCE(json_extract(m.data, '$.tokens.input'), 0) +
             COALESCE(json_extract(m.data, '$.tokens.output'), 0) +
             COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0) +
             COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0)) AS tokens
    FROM message m
    JOIN cohort c ON c.root_id = m.session_id
    WHERE json_extract(m.data, '$.role') = 'assistant'
    GROUP BY m.session_id, json_extract(m.data, '$.parentID')
  ),
  work AS (
    SELECT u.session_id, u.user_id,
           CASE
             WHEN u.text LIKE '%Diagnose and fix these failing checks%'
               AND u.text LIKE '%One or more automated reviews may have completed%' THEN 'red_and_green'
             WHEN u.text LIKE '%Diagnose and fix these failing checks%' THEN 'red_only'
             WHEN u.text LIKE '%One or more automated reviews may have completed%' THEN 'green_only'
             ELSE 'neither'
           END AS kind,
           results.result_text AS work_result,
           COALESCE(usage.tokens, 0) AS work_tokens,
           next.user_id AS next_user_id,
           next.text AS next_text
    FROM user_prompts u
    LEFT JOIN assistant_results results ON results.session_id = u.session_id AND results.user_id = u.user_id
    LEFT JOIN assistant_usage usage ON usage.session_id = u.session_id AND usage.user_id = u.user_id
    LEFT JOIN user_prompts next ON next.session_id = u.session_id AND next.seq = u.seq + 1
    WHERE u.text LIKE 'Process the following PR Status Check results%'
  ),
  effective AS (
    SELECT work.kind,
           CASE
             WHEN work.work_result IS NOT NULL THEN work.work_result
             WHEN work.next_text LIKE 'Based only on the PR status-check work%' THEN next_results.result_text
           END AS result_text,
           work.work_tokens + CASE
             WHEN work.work_result IS NULL AND work.next_text LIKE 'Based only on the PR status-check work%'
             THEN COALESCE(next_usage.tokens, 0) ELSE 0 END AS tokens
    FROM work
    LEFT JOIN assistant_results next_results
      ON next_results.session_id = work.session_id AND next_results.user_id = work.next_user_id
    LEFT JOIN assistant_usage next_usage
      ON next_usage.session_id = work.session_id AND next_usage.user_id = work.next_user_id
  )
  SELECT kind,
         CASE
           WHEN result_text LIKE '%READY_FOR_AGENT_RESULT: CHECKS_TRIGGERED%' THEN 'CHECKS_TRIGGERED'
           WHEN result_text LIKE '%READY_FOR_AGENT_RESULT: RERUN_REVIEW%' THEN 'RERUN_REVIEW'
           WHEN result_text LIKE '%READY_FOR_AGENT_RESULT: PROCESSED%' THEN 'PROCESSED'
           WHEN result_text LIKE '%READY_FOR_AGENT_RESULT: NEEDS_HUMAN%' THEN 'NEEDS_HUMAN'
           WHEN result_text LIKE '%READY_FOR_AGENT_RESULT: FAILED%' THEN 'FAILED'
           WHEN result_text LIKE '%READY_FOR_AGENT_RESULT: WAITING%' THEN 'WAITING'
           WHEN result_text IS NULL THEN 'MISSING'
           ELSE 'OTHER'
         END AS outcome,
         COUNT(*) AS handoffs,
         SUM(tokens) AS tokens
  FROM effective
  GROUP BY kind, outcome
  ORDER BY kind, handoffs DESC`)

const childKinds = all<Row>(`
  WITH RECURSIVE ${cohort},
  tree(root_id, session_id, depth) AS (
    SELECT root_id, root_id, 0 FROM cohort
    UNION ALL
    SELECT tree.root_id, s.id, tree.depth + 1
    FROM tree
    JOIN session s ON s.parent_id = tree.session_id
  ),
  children AS (
    SELECT s.*
    FROM tree
    JOIN session s ON s.id = tree.session_id
    WHERE tree.depth > 0
  )
  SELECT CASE
           WHEN lower(title) LIKE '%precommit%' OR lower(title) LIKE '%pre-commit%'
             OR lower(title) LIKE '%hook%' THEN 'pre_commit_diagnosis'
           WHEN lower(title) LIKE 'review changes%' THEN 'review_command'
           WHEN agent = 'explore' THEN 'exploration'
           WHEN agent = 'general' THEN 'general_task'
           ELSE 'other'
         END AS child_kind,
         COUNT(*) AS sessions,
         SUM(tokens_input) AS input,
         SUM(tokens_output) AS output,
         SUM(tokens_reasoning) AS reasoning,
         SUM(tokens_cache_read) AS cache_read,
         SUM(tokens_input + tokens_output + tokens_reasoning + tokens_cache_read + tokens_cache_write) AS tokens
  FROM children
  GROUP BY child_kind
  ORDER BY tokens DESC`)

const tools = all<Row>(`
  WITH ${cohort},
  calls AS (
    SELECT p.session_id,
           json_extract(p.data, '$.tool') AS tool,
           json_extract(p.data, '$.state.status') AS status,
           length(COALESCE(json_extract(p.data, '$.state.output'), '')) AS output_chars,
           COALESCE(json_extract(p.data, '$.state.metadata.truncated'), 0) AS truncated
    FROM part p
    JOIN cohort c ON c.root_id = p.session_id
    WHERE json_extract(p.data, '$.type') = 'tool'
  )
  SELECT tool,
         COUNT(*) AS calls,
         COUNT(DISTINCT session_id) AS sessions,
         SUM(output_chars) AS output_chars,
         ROUND(AVG(output_chars), 0) AS average_output_chars,
         MAX(output_chars) AS maximum_output_chars,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
         SUM(CASE WHEN truncated THEN 1 ELSE 0 END) AS truncated
  FROM calls
  GROUP BY tool
  ORDER BY output_chars DESC`)

const topSessions = all<Row>(`
  WITH RECURSIVE ${cohort},
  tree(root_id, session_id, depth) AS (
    SELECT root_id, root_id, 0 FROM cohort
    UNION ALL
    SELECT tree.root_id, s.id, tree.depth + 1
    FROM tree
    JOIN session s ON s.parent_id = tree.session_id
  ),
  usage AS (
    SELECT c.github_issue_number,
           c.issue_title,
           tree.root_id,
           SUM(CASE WHEN tree.depth = 0 THEN s.tokens_input + s.tokens_output +
             s.tokens_reasoning + s.tokens_cache_read + s.tokens_cache_write ELSE 0 END) AS root_tokens,
           SUM(CASE WHEN tree.depth > 0 THEN s.tokens_input + s.tokens_output +
             s.tokens_reasoning + s.tokens_cache_read + s.tokens_cache_write ELSE 0 END) AS child_tokens,
           SUM(CASE WHEN tree.depth > 0 THEN 1 ELSE 0 END) AS child_sessions,
           SUM(s.tokens_input + s.tokens_output + s.tokens_reasoning +
             s.tokens_cache_read + s.tokens_cache_write) AS inclusive_tokens
    FROM tree
    JOIN cohort c ON c.root_id = tree.root_id
    JOIN session s ON s.id = tree.session_id
    GROUP BY c.github_issue_number, c.issue_title, tree.root_id
  )
  SELECT * FROM usage ORDER BY inclusive_tokens DESC LIMIT 10`)

db.close()

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  cohort: {
    repository,
    harnessDatabase: harnessDb,
    opencodeDatabase: opencodeDb,
    backend: "opencode",
    requestedLimit: options.limit,
    eligibleWorkItems: number(eligible.count),
    ...scope,
  },
  repository: repositoryRow,
  tokens: {
    root: rootTokens,
    inclusive: inclusiveTokens,
  },
  modelCalls,
  contextGrowth,
  lifecycle,
  statusChecks: {
    kinds: statusKinds,
    outcomes: statusOutcomes,
  },
  childKinds,
  tools,
  topSessions,
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const rootCalls = modelCalls.find((row) => row.scope === "root")
const childCalls = modelCalls.find((row) => row.scope === "child")

console.log(`# OpenCode Session Token Audit: ${repository}\n`)
console.log(`Generated: ${report.generatedAt}`)
console.log(
  `Cohort: ${formatNumber(scope.roots)} of ${formatNumber(eligible.count)} eligible root Sessions, ${scope.first_session ?? "unknown"} to ${scope.last_session ?? "unknown"}`,
)
if (number(scope.missing_sessions) > 0) {
  console.log(
    `Missing OpenCode telemetry: ${formatNumber(scope.missing_sessions)} of ${formatNumber(scope.selected_work_items)} selected Work Items`,
  )
}
console.log(
  `Outcomes: ${formatNumber(scope.complete)} complete, ${formatNumber(scope.not_complete)} not complete\n`,
)

console.log("## Tokens\n")
console.log(
  markdownTable(
    ["Metric", "Root", "Inclusive"],
    [
      ["Session rows", formatNumber(rootTokens.sessions), formatNumber(number(inclusiveTokens.roots) + number(inclusiveTokens.child_sessions))],
      ["Tokens", formatNumber(rootTokens.total), formatNumber(inclusiveTokens.total)],
      ["Average", formatNumber(rootTokens.average), formatNumber(inclusiveTokens.average)],
      ["Median", formatNumber(rootTokens.median), formatNumber(inclusiveTokens.median)],
      ["P90", formatNumber(rootTokens.p90), formatNumber(inclusiveTokens.p90)],
      ["Cache read %", formatNumber(rootTokens.cache_read_pct), formatNumber(inclusiveTokens.cache_read_pct)],
    ],
  ),
)

console.log("\n## Model Calls\n")
console.log(
  markdownTable(
    ["Scope", "Calls", "Avg context", "Avg generated", "Tokens"],
    [rootCalls, childCalls]
      .filter((row): row is Row => row !== undefined)
      .map((row) => [
        String(row.scope),
        formatNumber(row.calls),
        formatNumber(row.average_context),
        formatNumber(row.average_generated),
        formatNumber(row.tokens),
      ]),
  ),
)
console.log(
  `\nRoot context: first call average ${formatNumber(contextGrowth.average_first_context)}, final call average ${formatNumber(contextGrowth.average_last_context)}.`,
)

console.log("\n## Lifecycle\n")
console.log(
  markdownTable(
    ["Category", "Turns", "Sessions", "Model calls", "Tokens"],
    lifecycle.map((row) => [
      String(row.category),
      formatNumber(row.user_turns),
      formatNumber(row.sessions),
      formatNumber(row.model_calls),
      formatNumber(row.total),
    ]),
  ),
)

console.log("\n## Status Checks\n")
console.log(
  markdownTable(
    ["Kind", "Turns", "Sessions", "Tokens"],
    statusKinds.map((row) => [
      String(row.handoff_kind),
      formatNumber(row.turns),
      formatNumber(row.sessions),
      formatNumber(row.tokens),
    ]),
  ),
)
console.log("")
console.log(
  markdownTable(
    ["Kind", "Outcome", "Handoffs", "Work + paired outcome tokens"],
    statusOutcomes.map((row) => [
      String(row.kind),
      String(row.outcome),
      formatNumber(row.handoffs),
      formatNumber(row.tokens),
    ]),
  ),
)

console.log("\n## Child Sessions\n")
console.log(
  markdownTable(
    ["Kind", "Sessions", "Tokens"],
    childKinds.map((row) => [
      String(row.child_kind),
      formatNumber(row.sessions),
      formatNumber(row.tokens),
    ]),
  ),
)

console.log("\n## Tool Output\n")
console.log(
  markdownTable(
    ["Tool", "Calls", "Output chars", "Errors", "Truncated"],
    tools.map((row) => [
      String(row.tool),
      formatNumber(row.calls),
      formatNumber(row.output_chars),
      formatNumber(row.errors),
      formatNumber(row.truncated),
    ]),
  ),
)

console.log("\n## Highest Inclusive Usage\n")
console.log(
  markdownTable(
    ["Issue", "Title", "Root", "Child", "Inclusive"],
    topSessions.map((row) => [
      `#${String(row.github_issue_number)}`,
      String(row.issue_title).replaceAll("|", "\\|"),
      formatNumber(row.root_tokens),
      formatNumber(row.child_tokens),
      formatNumber(row.inclusive_tokens),
    ]),
  ),
)
