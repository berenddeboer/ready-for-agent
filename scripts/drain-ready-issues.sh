#!/usr/bin/env bash
# Enroll every Relevant Issue in a Repository from the command line, then follow
# the Work Items until they settle.
#
# The harness does not pick Issues to work on by itself — "Working on issues" in
# README.md says you click "Implement now" per Issue. That is the right default
# for a supervised run. This script is for the unsupervised case: a batch of
# prepared tickets you want admitted in one go, on a headless box, or from cron.
# It drives the same GraphQL API the UI does, so it takes no shortcuts around
# the lifecycle.
#
# Blockers are respected. An Issue with open blockers is admitted with `queue`
# (Waiting for blockers) rather than `implementNow`, so the harness still owns
# the ordering.
#
# An Agent Backend and a build model are not assumed. The Repository keeps
# whichever it already has; otherwise the detected Agent Backends are listed and
# offered, then that backend's model catalog, then the model's Thinking Levels.
# Pass --backend, --build-model and --thinking-level to answer up front, which
# is what an unattended run must do — rather than choose a model, and a price,
# on your behalf, the script stops and tells you the options.
#
# Prerequisites:
#   - The harness is running (`ready-for-agent start`)
#   - curl and jq on PATH
#   - An Agent Backend that reports Ready
#
# Usage:
#   scripts/drain-ready-issues.sh --repo owner/name
#   scripts/drain-ready-issues.sh --repo owner/name --auto-merge
#   scripts/drain-ready-issues.sh --repo owner/name --dry-run
#   scripts/drain-ready-issues.sh --repo owner/name --status
#   scripts/drain-ready-issues.sh --repo owner/name --backend claude \
#     --build-model sonnet --thinking-level high
#
# Honours READY_FOR_AGENT_GRAPHQL_URL for non-default ports, same as
# `ready-for-agent add`.
set -euo pipefail

GRAPHQL_URL="${READY_FOR_AGENT_GRAPHQL_URL:-http://127.0.0.1:6056/graphql}"
PROJECT_PATH=""
BACKEND=""
BUILD_MODEL=""
THINKING_LEVEL=""
AUTO_MERGE=""
DRY_RUN=""
STATUS_ONLY=""
POLL_SECONDS="${POLL_SECONDS:-60}"

usage() {
  sed -n '2,36p' "$0" | sed 's|^# \{0,1\}||'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) PROJECT_PATH="${2:-}"; shift 2 ;;
    --backend) BACKEND="${2:-}"; shift 2 ;;
    --build-model) BUILD_MODEL="${2:-}"; shift 2 ;;
    --thinking-level) THINKING_LEVEL="${2:-}"; shift 2 ;;
    --poll) POLL_SECONDS="${2:-}"; shift 2 ;;
    --auto-merge) AUTO_MERGE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --status) STATUS_ONLY=1; shift ;;
    -h | --help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 1 >&2 ;;
  esac
done

for tool in curl jq; do
  command -v "${tool}" >/dev/null 2>&1 || {
    echo "error: ${tool} is required" >&2
    exit 1
  }
done

# POST a query, with optional variables JSON, and fail loudly. A GraphQL error
# arrives as HTTP 200 with an `errors` array, so checking the transport alone is
# not enough.
#
# Returns non-zero rather than calling exit: every caller reads it through a
# command substitution, and an exit there would only kill the subshell and let
# the script carry on with an empty result.
gql() {
  local response
  response="$(jq -nc --arg q "$1" --argjson v "${2:-null}" '{query: $q, variables: $v}' \
    | curl -sS -X POST "${GRAPHQL_URL}" \
        -H 'content-type: application/json' \
        --data-binary @- 2>/dev/null)" || {
    echo "error: cannot reach the harness at ${GRAPHQL_URL}" >&2
    echo "       start it with: ready-for-agent start" >&2
    return 1
  }
  if jq -e 'has("errors")' >/dev/null 2>&1 <<<"${response}"; then
    echo "error: GraphQL request failed" >&2
    jq -r '.errors[].message' <<<"${response}" >&2
    return 1
  fi
  printf '%s' "${response}"
}

# Resolve --repo to a Repository ID. With a single Repository configured, --repo
# is optional; with several it is required, because draining the wrong one is
# not a mistake you can take back.
resolve_repository_id() {
  local repositories count
  repositories="$(gql '{ repositories { id projectPath paused } }')" || return 1
  count="$(jq '.data.repositories | length' <<<"${repositories}")"

  if [[ "${count}" == "0" ]]; then
    echo "error: no repositories configured — add one with: ready-for-agent add <path>" >&2
    return 1
  fi

  if [[ -z "${PROJECT_PATH}" ]]; then
    if [[ "${count}" != "1" ]]; then
      echo "error: ${count} repositories configured; pass --repo <owner/name>" >&2
      jq -r '.data.repositories[] | "       " + .projectPath' <<<"${repositories}" >&2
      return 1
    fi
    jq -r '.data.repositories[0].id' <<<"${repositories}"
    return
  fi

  local id
  id="$(jq -r --arg p "${PROJECT_PATH}" \
    '.data.repositories[] | select(.projectPath == $p) | .id' <<<"${repositories}")"
  if [[ -z "${id}" ]]; then
    echo "error: no configured repository matches ${PROJECT_PATH}" >&2
    jq -r '.data.repositories[] | "       " + .projectPath' <<<"${repositories}" >&2
    return 1
  fi
  printf '%s' "${id}"
}

# The Repository's settings as a complete mutation input, ready for a caller to
# layer changes onto.
#
# updateRepositorySettings is not a patch, so naming only the settings we mean
# to change is not enough on either count:
#
#   - defaultModel, defaultThinkingLevel, reviewModel and reviewThinkingLevel
#     are persisted as `input.field ?? null`, so a field left out is cleared
#     rather than kept
#   - paused, autoMerge, includeAllIssueAuthors and waitForReadyForReviewChecks
#     are Boolean!, so a field left out fails the whole call
#
# Both hazards grow with the schema, and a hardcoded list here goes stale the
# next time a setting is added. So take the field list from the schema and read
# the values off the Repository, which exposes a same-named field for each one.
current_settings() {
  local repository_id="$1" shape settable unreadable current
  shape="$(gql '{
    settings: __type(name: "UpdateRepositorySettingsInput") { inputFields { name } }
    repository: __type(name: "Repository") { fields { name } }
  }')" || return 1

  # repositoryId is the one input field with no counterpart to read back; it is
  # Repository.id, which the query below asks for separately.
  settable="$(jq -r '[.data.repository.fields[].name] as $readable
    | [.data.settings.inputFields[].name | select(. != "repositoryId")]
    | map(select(. as $field | $readable | index($field)))
    | join(" ")' <<<"${shape}")"

  unreadable="$(jq -r '[.data.repository.fields[].name] as $readable
    | [.data.settings.inputFields[].name | select(. != "repositoryId")]
    | map(select(. as $field | $readable | index($field) | not))
    | join(", ")' <<<"${shape}")"
  if [[ -n "${unreadable}" ]]; then
    echo "warning: no Repository field to read these settings back from: ${unreadable}" >&2
    echo "         this run may reset them" >&2
  fi

  current="$(gql "{ repositories { id ${settable} } }")" || return 1
  if ! jq -e --arg id "${repository_id}" \
      '[.data.repositories[] | select(.id == $id)] | length == 1' >/dev/null <<<"${current}"; then
    echo "error: repository ${repository_id} went away while configuring it" >&2
    return 1
  fi

  jq -c --arg id "${repository_id}" \
    '[.data.repositories[] | select(.id == $id)][0] | del(.id) | .repositoryId = $id' <<<"${current}"
}

# Send a complete settings input.
apply_settings() {
  # $input is a GraphQL variable, not a shell one — the quoting is deliberate.
  # shellcheck disable=SC2016
  gql 'mutation ($input: UpdateRepositorySettingsInput!) {
    updateRepositorySettings(input: $input) {
      paused autoMerge selectedAgentBackend defaultModel defaultThinkingLevel
    }
  }' "$(jq -nc --argjson input "$1" '{input: $input}')" \
    | jq -r '.data.updateRepositorySettings
    | "unpaused, autoMerge=\(.autoMerge), backend=\(.selectedAgentBackend // "harness default")"
      + ", build model=\(.defaultModel // "harness default")"
      + (if .defaultThinkingLevel then " (\(.defaultThinkingLevel))" else "" end)'
}

# Unpause, and optionally set the Agent Backend and auto-merge. Every other
# setting is read back and resent unchanged, so this never silently clears a
# per-repo override.
configure_repository() {
  local repository_id="$1" input
  input="$(current_settings "${repository_id}")" || return 1
  apply_settings "$(jq -c --arg backend "${BACKEND}" --arg auto "${AUTO_MERGE}" '
    .paused = false
    | if $backend == "" then . else .selectedAgentBackend = $backend end
    | if $auto == "" then . else .autoMerge = true end
  ' <<<"${input}")"
}

# Which coders exist is the harness's business, not this script's, so ask it
# rather than hardcoding a list that goes stale as backends are added.
# previewAgentBackend inspects one without activating it, so a single aliased
# query reports what is installed and authenticated on this machine.
DETECTED=""
detect_backends() {
  if [[ -z "${DETECTED}" ]]; then
    local query
    query="$(gql '{ agentBackends { id } }' | jq -r '[.data.agentBackends[].id] | to_entries
      | map("b\(.key): previewAgentBackend(backendId: \"\(.value)\")"
            + " { backend { id label } kind reason models { id thinkingLevels } }")
      | "{ " + join(" ") + " }"')" || return 1
    DETECTED="$(gql "${query}" | jq -c '{backends: [.data | to_entries[] | .value]}')" || return 1
  fi
  printf '%s' "${DETECTED}"
}

# Which coder writes the code is not a choice to make on someone's behalf, so
# the menu is offered even when only one backend is Ready — seeing which one is
# about to be handed the Repository is the point. A Repository that already has
# an Agent Backend keeps it, and is never asked again.
choose_backend() {
  local repository_id="$1" detected current pick
  local -a ready
  detected="$(detect_backends)" || return 1

  echo "detected Agent Backends:"
  jq -r '.backends[] | "  \(.backend.label) (\(.backend.id))  \(.kind)"
    + (if .reason then "  \(.reason)" else "" end)' <<<"${detected}"

  mapfile -t ready < <(jq -r '.backends[] | select(.kind == "READY") | .backend.id' <<<"${detected}")
  if [[ ${#ready[@]} -eq 0 ]]; then
    echo "error: no Agent Backend is Ready — install or authenticate one, then re-run" >&2
    return 1
  fi

  if [[ -n "${BACKEND}" ]]; then
    if ! printf '%s\n' "${ready[@]}" | grep -qxF "${BACKEND}"; then
      echo "error: --backend ${BACKEND} is not Ready here; Ready: ${ready[*]}" >&2
      return 1
    fi
    return
  fi

  current="$(current_settings "${repository_id}" | jq -r '.selectedAgentBackend // ""')" || return 1
  if [[ -n "${current}" ]] && printf '%s\n' "${ready[@]}" | grep -qxF "${current}"; then
    BACKEND="${current}"
    echo "Agent Backend: ${BACKEND} (already set on this repository)"
    return
  fi

  if [[ -n "${DRY_RUN}" ]]; then
    BACKEND="${ready[0]}"
    echo "would ask which to use: ${ready[*]} (assuming ${BACKEND} for this dry run)"
    return
  fi
  if [[ ! -t 0 ]]; then
    echo "error: this repository has no Agent Backend and stdin is not a terminal" >&2
    printf '       re-run with --backend %s\n' "${ready[@]}" >&2
    return 1
  fi

  pick=""
  PS3="Agent Backend [1-${#ready[@]}]: "
  select pick in "${ready[@]}"; do
    [[ -n "${pick:-}" ]] && break
    echo "not one of the listed options" >&2
  done
  if [[ -z "${pick:-}" ]]; then
    echo "error: no Agent Backend chosen — re-run with --backend <id>" >&2
    return 1
  fi
  BACKEND="${pick}"
}

# Admitting an Issue resolves a build model: the Repository's own, else the
# harness default for its Agent Backend. With neither set every mutation fails
# on "Select a default build model first", which says nothing about the models
# the backend actually offers. So resolve it up front and, when nothing is set,
# offer the live catalog rather than picking a model — and a price — for someone.
ensure_build_model() {
  local repository_id="$1" settings repo_model backend_model detected choice level
  local -a catalog levels

  settings="$(current_settings "${repository_id}")" || return 1
  repo_model="$(jq -r '.defaultModel // ""' <<<"${settings}")"
  if [[ -n "${repo_model}" ]]; then
    echo "build model: ${repo_model} (repository setting)"
    return
  fi

  backend_model="$(gql "{ harnessModelPrefs(backendId: \"${BACKEND}\") { defaultModel } }" \
    | jq -r '.data.harnessModelPrefs.defaultModel // ""')" || return 1
  if [[ -n "${backend_model}" ]]; then
    echo "build model: ${backend_model} (harness default for ${BACKEND})"
    return
  fi

  detected="$(detect_backends)" || return 1
  mapfile -t catalog < <(jq -r --arg b "${BACKEND}" \
    '.backends[] | select(.backend.id == $b) | .models[].id' <<<"${detected}")
  if [[ ${#catalog[@]} -eq 0 ]]; then
    echo "error: ${BACKEND} is Ready but reported no models — nothing to choose from" >&2
    return 1
  fi

  echo "no build model set for this repository or for ${BACKEND}"

  if [[ -n "${BUILD_MODEL}" ]]; then
    if ! printf '%s\n' "${catalog[@]}" | grep -qxF "${BUILD_MODEL}"; then
      echo "error: --build-model ${BUILD_MODEL} is not offered by ${BACKEND}" >&2
      echo "       available: ${catalog[*]}" >&2
      return 1
    fi
    choice="${BUILD_MODEL}"
  elif [[ -n "${DRY_RUN}" ]]; then
    echo "would ask which of these to use: ${catalog[*]}"
    return
  elif [[ ! -t 0 ]]; then
    echo "error: no build model set and stdin is not a terminal; choosing one" >&2
    echo "       chooses a price, so pick explicitly:" >&2
    printf '       --build-model %s\n' "${catalog[@]}" >&2
    return 1
  else
    echo "${BACKEND} offers: ${catalog[*]}"
    choice=""
    PS3="build model [1-${#catalog[@]}]: "
    select choice in "${catalog[@]}"; do
      [[ -n "${choice:-}" ]] && break
      echo "not one of the listed options" >&2
    done
    if [[ -z "${choice:-}" ]]; then
      echo "error: no build model chosen — re-run with --build-model <id>" >&2
      return 1
    fi
  fi

  # Thinking Level is per model, and unset is a valid answer meaning "harness
  # default", so this never blocks an unattended run the way a missing model does.
  mapfile -t levels < <(jq -r --arg b "${BACKEND}" --arg m "${choice}" \
    '.backends[] | select(.backend.id == $b)
     | .models[] | select(.id == $m) | .thinkingLevels[]' <<<"${detected}")
  level=""

  if [[ -n "${THINKING_LEVEL}" ]]; then
    if [[ ${#levels[@]} -eq 0 ]]; then
      echo "error: --thinking-level given, but ${choice} offers no Thinking Levels" >&2
      return 1
    fi
    if ! printf '%s\n' "${levels[@]}" | grep -qxF "${THINKING_LEVEL}"; then
      echo "error: --thinking-level ${THINKING_LEVEL} is not offered by ${choice}" >&2
      echo "       available: ${levels[*]}" >&2
      return 1
    fi
    level="${THINKING_LEVEL}"
  elif [[ ${#levels[@]} -eq 0 ]]; then
    echo "${choice} offers no Thinking Levels"
  elif [[ ! -t 0 ]]; then
    echo "Thinking Level left at the harness default (--thinking-level pins one: ${levels[*]})"
  else
    echo "${choice} offers Thinking Levels: ${levels[*]}"
    PS3="Thinking Level [1-$((${#levels[@]} + 1))]: "
    select _ in "${levels[@]}" "harness default"; do
      [[ -n "${REPLY:-}" && "${REPLY}" -ge 1 && "${REPLY}" -le $((${#levels[@]} + 1)) ]] 2>/dev/null || {
        echo "not one of the listed options" >&2
        continue
      }
      [[ "${REPLY}" -le ${#levels[@]} ]] && level="${levels[$((REPLY - 1))]}"
      break
    done
  fi

  # The Agent Backend goes in too: the harness validates the model against
  # whichever backend the Repository has, so a model write that arrived before
  # the backend was stored would be judged against the wrong catalog.
  apply_settings "$(jq -c --arg m "${choice}" --arg l "${level}" --arg b "${BACKEND}" '
    .selectedAgentBackend = $b
    | .defaultModel = $m
    | .defaultThinkingLevel = (if $l == "" then null else $l end)
  ' <<<"${settings}")"
}

# Open Relevant Issues with no unfinished Work Item, tab-separated as
# `number<TAB>mutation<TAB>title`.
pending_issues() {
  local repository_id="$1" snapshot
  snapshot="$(gql "{
    issues(repositoryId: \"${repository_id}\") {
      issueNumber title state hasChildren blockedBy { issueNumber }
    }
    workItems(repositoryId: \"${repository_id}\") { issueNumber isTerminal }
  }")" || return 1

  # A parent Issue is never implemented directly. With --auto-merge it is worth
  # a call, because implementAllWithAutoMerge is the only way to set Merge Mode
  # ALWAYS on its children; without it the children are admitted on their own.
  jq -r --arg auto "${AUTO_MERGE}" '
    ([.data.workItems[] | select(.isTerminal | not) | .issueNumber]) as $live
    | .data.issues[]
    | select(.state == "OPEN")
    | select(.issueNumber as $n | $live | index($n) | not)
    | if .hasChildren then
        (if $auto == "" then empty
         else [.issueNumber, "implementAllWithAutoMerge", .title] end)
      elif (.blockedBy | length) > 0 then
        [.issueNumber, "queue", .title]
      else
        [.issueNumber, "implementNow", .title]
      end
    | @tsv
  ' <<<"${snapshot}"
}

enroll() {
  local repository_id="$1" pending issue_number mutation title
  pending="$(pending_issues "${repository_id}")" || return 1

  if [[ -z "${pending}" ]]; then
    echo "nothing to enroll — every Relevant Issue already has a Work Item"
    return
  fi

  while IFS=$'\t' read -r issue_number mutation title; do
    [[ -z "${issue_number}" ]] && continue
    printf '  #%-6s %-24s %s\n' "${issue_number}" "${mutation}" "${title:0:56}"
    [[ -n "${DRY_RUN}" ]] && continue
    # implementNow and queue return a WorkItem, implementAllWithAutoMerge a list
    # of them; stateLabel selects cleanly against either.
    gql "mutation {
      ${mutation}(repositoryId: \"${repository_id}\", issueNumber: ${issue_number}) {
        stateLabel
      }
    }" >/dev/null
  done <<<"${pending}"
}

# 0 = still working, 1 = everything terminal, 2 = no Work Items, 3 = query failed.
report_status() {
  local repository_id="$1" items
  items="$(gql "{
    workItems(repositoryId: \"${repository_id}\") {
      issueNumber stateLabel statusLabel statusMessage
      pullRequestNumber paused isTerminal
    }
  }")" || return 3

  jq -e '.data.workItems | length > 0' >/dev/null <<<"${items}" || return 2

  jq -r '.data.workItems | sort_by(.issueNumber)[]
    | "  #\(.issueNumber) \(.stateLabel) / \(.statusLabel)"
      + (if .pullRequestNumber then " PR#\(.pullRequestNumber)" else "" end)
      + (if .paused then " [paused]" else "" end)
      + (if .statusMessage then " — \(.statusMessage)" else "" end)' <<<"${items}"

  # Needs Human is terminal but unfinished. Auto-merge only clears low-risk PRs,
  # so an unattended run is expected to leave some Work Items parked here.
  local needs_human
  needs_human="$(jq '[.data.workItems[]
    | select(.stateLabel | ascii_downcase | test("needs human"))] | length' <<<"${items}")"
  if [[ "${needs_human}" != "0" ]]; then
    echo "  ${needs_human} Work Item(s) need a human"
  fi

  jq -e '[.data.workItems[] | select(.isTerminal | not)] | length > 0' >/dev/null <<<"${items}"
}

follow() {
  local repository_id="$1" result
  echo "following Work Items every ${POLL_SECONDS}s — Ctrl-C detaches, the harness keeps going"
  while true; do
    echo "--- $(date '+%Y-%m-%d %H:%M:%S') ---"
    set +e
    report_status "${repository_id}"
    result=$?
    set -e
    case "${result}" in
      0) sleep "${POLL_SECONDS}" ;;
      1) echo "every Work Item has reached a terminal state"; return 0 ;;
      2) echo "no Work Items for this repository"; return 0 ;;
      *) return 1 ;;
    esac
  done
}

main() {
  local repository_id
  repository_id="$(resolve_repository_id)" || exit 1

  if [[ -n "${STATUS_ONLY}" ]]; then
    follow "${repository_id}"
    return
  fi

  if [[ -n "${DRY_RUN}" ]]; then
    echo "dry run — no mutations will be sent"
    choose_backend "${repository_id}"
    ensure_build_model "${repository_id}"
    enroll "${repository_id}"
    return
  fi

  choose_backend "${repository_id}"
  configure_repository "${repository_id}"
  ensure_build_model "${repository_id}"
  enroll "${repository_id}"
  follow "${repository_id}"
}

main
