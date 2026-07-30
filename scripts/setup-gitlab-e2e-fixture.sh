#!/usr/bin/env bash
# Bootstrap the GitLab End-to-End Fixture Repository on git.drupalcode.org.
#
# Drupal.org blocks creating projects and toggling Issues via the GitLab API
# (mutations return a HTML git-error page). Create the throwaway project and
# enable Issues in the Drupal.org / GitLab UI first, then run this script with
# a PAT that can manage Issues and labels (local bootstrap only — CI uses
# read-only).
#
# Prerequisites:
#   - glab authenticated to git.drupalcode.org, OR GITLAB_TOKEN / PRIVATE-TOKEN
#   - Project exists at E2E_GITLAB_PROJECT_PATH (default:
#     sandbox/berend-test-ready-for-agent) with Issues enabled
#   - Label ready-for-agent will be created if missing
#   - Sentinel Issue with the fixed title will be created if missing
#
# Prints the sentinel iid to lock into apps/harness/e2e/support/constants.ts
# (or export E2E_GITLAB_SENTINEL_ISSUE_NUMBER for local runs).
set -euo pipefail

HOST="${E2E_GITLAB_FORGE_HOST:-git.drupalcode.org}"
PROJECT_PATH="${E2E_GITLAB_PROJECT_PATH:-sandbox/berend-test-ready-for-agent}"
SENTINEL_TITLE="E2E fixture: Ready-labeled Issue refresh"
READY_LABEL="ready-for-agent"
READY_COLOR="#0E8A16"
BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/rfa-gitlab-fixture-body.XXXXXX")"
trap 'rm -f "${BODY_FILE}"' EXIT

encoded_path() {
  python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"
}

resolve_token() {
  if [[ -n "${GITLAB_TOKEN:-}" ]]; then
    printf '%s' "${GITLAB_TOKEN}"
    return
  fi
  if [[ -n "${PRIVATE_TOKEN:-}" ]]; then
    printf '%s' "${PRIVATE_TOKEN}"
    return
  fi
  if command -v glab >/dev/null 2>&1; then
    local from_glab
    from_glab="$(glab config get token --host "${HOST}" 2>/dev/null || true)"
    if [[ -n "${from_glab}" && "${from_glab}" != "null" ]]; then
      printf '%s' "${from_glab}"
      return
    fi
  fi
  echo "error: set GITLAB_TOKEN or authenticate glab to ${HOST}" >&2
  exit 1
}

TOKEN="$(resolve_token)"
ENC="$(encoded_path "${PROJECT_PATH}")"
API="https://${HOST}/api/v4"

api_code() {
  local method="$1" path="$2"
  shift 2
  curl -sS -o "${BODY_FILE}" -w "%{http_code}" \
    -X "${method}" \
    -H "PRIVATE-TOKEN: ${TOKEN}" \
    -H "Content-Type: application/json" \
    "${API}${path}" \
    "$@"
}

echo "Checking project ${PROJECT_PATH} on ${HOST}..." >&2
code="$(api_code GET "/projects/${ENC}")"
if [[ "${code}" != "200" ]]; then
  cat <<EOF >&2
error: project not found or inaccessible (HTTP ${code}).

Create a throwaway project on ${HOST} under operator control, then re-run:

  1. On Drupal.org, create a sandbox (or other project you control).
  2. Open the GitLab project settings and enable Issues (and CI if you will
     exercise pipelines). Drupal.org often defaults Issues off for sandboxes
     and many project/* namespaces.
  3. Export the path and re-run:
       export E2E_GITLAB_PROJECT_PATH='sandbox/<your-path>'
       $0

Canonical path used by CI constants (override with E2E_GITLAB_PROJECT_PATH):
  sandbox/berend-test-ready-for-agent
EOF
  exit 1
fi

issues_enabled="$(python3 -c "import json; print(json.load(open('${BODY_FILE}')).get('issues_enabled'))")"
if [[ "${issues_enabled}" != "True" && "${issues_enabled}" != "true" ]]; then
  echo "error: Issues are disabled on ${PROJECT_PATH}. Enable Issues in GitLab project settings." >&2
  exit 1
fi
echo "✓ Project reachable with Issues enabled" >&2

empty_repo="$(python3 -c "import json; print(json.load(open('${BODY_FILE}')).get('empty_repo'))")"
default_branch="$(python3 -c "import json; print(json.load(open('${BODY_FILE}')).get('default_branch') or '')")"
if [[ "${empty_repo}" == "True" || "${empty_repo}" == "true" || -z "${default_branch}" ]]; then
  cat <<EOF >&2
error: project ${PROJECT_PATH} has no default branch / is empty.

Live e2e runs \`git clone --depth 1\` and fails on empty GitLab projects.
Push an initial commit on the default branch (e.g. README), then re-run.
EOF
  exit 1
fi
echo "✓ Project has default branch ${default_branch}" >&2

# Ensure ready-for-agent label
code="$(api_code GET "/projects/${ENC}/labels?per_page=100")"
if [[ "${code}" != "200" ]]; then
  echo "error: failed to list labels (HTTP ${code})" >&2
  cat "${BODY_FILE}" >&2
  exit 1
fi
if ! python3 -c "
import json
labels = json.load(open('${BODY_FILE}'))
raise SystemExit(0 if any(l.get('name') == '${READY_LABEL}' for l in labels) else 1)
"; then
  echo "Creating label ${READY_LABEL}..." >&2
  code="$(api_code POST "/projects/${ENC}/labels" \
    -d "{\"name\":\"${READY_LABEL}\",\"color\":\"${READY_COLOR}\",\"description\":\"Ready for Agent\"}")"
  if [[ "${code}" != "201" && "${code}" != "200" ]]; then
    echo "error: failed to create label (HTTP ${code})" >&2
    cat "${BODY_FILE}" >&2
    exit 1
  fi
  echo "✓ Created label ${READY_LABEL}" >&2
else
  echo "✓ Label ${READY_LABEL} already exists" >&2
fi

# Find open Issue with exact sentinel title (paginate lightly)
SENTINEL_IID=""
page=1
while [[ "${page}" -le 10 ]]; do
  code="$(api_code GET "/projects/${ENC}/issues?state=opened&per_page=100&page=${page}")"
  if [[ "${code}" != "200" ]]; then
    echo "error: failed to list issues (HTTP ${code})" >&2
    cat "${BODY_FILE}" >&2
    exit 1
  fi
  SENTINEL_IID="$(
    python3 -c "
import json
title = '''${SENTINEL_TITLE}'''
for issue in json.load(open('${BODY_FILE}')):
    if issue.get('title') == title:
        print(issue['iid'])
        break
"
  )"
  if [[ -n "${SENTINEL_IID}" ]]; then
    break
  fi
  count="$(python3 -c "import json; print(len(json.load(open('${BODY_FILE}'))))")"
  if [[ "${count}" -lt 100 ]]; then
    break
  fi
  page=$((page + 1))
done

if [[ -z "${SENTINEL_IID}" ]]; then
  echo "Creating sentinel Issue..." >&2
  payload="$(
    python3 -c "
import json
print(json.dumps({
  'title': '''${SENTINEL_TITLE}''',
  'description': '''Permanent sentinel Issue for Ready for Agent live e2e.

Keep this Issue open and labeled ready-for-agent.
No hierarchy, no blockers, no Issue-closing merge request.
Scenarios tolerate unrelated Issues on this project.
''',
  'labels': '${READY_LABEL}',
}))
"
  )"
  code="$(api_code POST "/projects/${ENC}/issues" -d "${payload}")"
  if [[ "${code}" != "201" ]]; then
    echo "error: failed to create sentinel Issue (HTTP ${code})" >&2
    cat "${BODY_FILE}" >&2
    exit 1
  fi
  SENTINEL_IID="$(python3 -c "import json; print(json.load(open('${BODY_FILE}'))['iid'])")"
  echo "✓ Created sentinel Issue #${SENTINEL_IID}" >&2
else
  echo "✓ Sentinel Issue already open as #${SENTINEL_IID}" >&2
  code="$(api_code PUT "/projects/${ENC}/issues/${SENTINEL_IID}" \
    -d "{\"add_labels\":\"${READY_LABEL}\"}")"
  if [[ "${code}" != "200" ]]; then
    echo "error: failed to ensure ${READY_LABEL} on Issue #${SENTINEL_IID} (HTTP ${code})" >&2
    cat "${BODY_FILE}" >&2
    exit 1
  fi
fi

# Assert the Ready label stuck (create path and re-label path).
code="$(api_code GET "/projects/${ENC}/issues/${SENTINEL_IID}")"
if [[ "${code}" != "200" ]]; then
  echo "error: failed to re-fetch sentinel Issue #${SENTINEL_IID} (HTTP ${code})" >&2
  cat "${BODY_FILE}" >&2
  exit 1
fi
if ! python3 -c "
import json
issue = json.load(open('${BODY_FILE}'))
labels = issue.get('labels') or []
names = [l.get('name') if isinstance(l, dict) else l for l in labels]
raise SystemExit(0 if '${READY_LABEL}' in names else 1)
"; then
  echo "error: sentinel Issue #${SENTINEL_IID} is missing label ${READY_LABEL}" >&2
  cat "${BODY_FILE}" >&2
  exit 1
fi
echo "✓ Sentinel Issue #${SENTINEL_IID} carries ${READY_LABEL}" >&2

cat <<EOF

Fixture ready:
  Forge Host:    ${HOST}
  Project Path:  ${PROJECT_PATH}
  Sentinel iid:  ${SENTINEL_IID}
  Title:         ${SENTINEL_TITLE}
  Label:         ${READY_LABEL}

Next steps:
  1. Lock the sentinel iid (env override or default in gitlabSentinelIssueNumber):
       export E2E_GITLAB_SENTINEL_ISSUE_NUMBER=${SENTINEL_IID}
       export E2E_GITLAB_PROJECT_PATH='${PROJECT_PATH}'
  2. Mint a read-only PAT (read_api, read_repository) for CI.
  3. Regenerate the dual-secret fixture vault (probes API + git ls-remote):
       export E2E_KEYMAXXER_MASTER_KEY   # existing Actions master key
       export E2E_GITLAB_PROJECT_PATH='${PROJECT_PATH}'
       ./scripts/regenerate-e2e-keymaxxer-vault.sh --with-gitlab
       # paste GitHub fine-grained token, then GitLab PAT
  4. Run the isolated GitLab clone smoke test (docs/e2e-fixture.md), then commit
     e2e/fixtures/keymaxxer/vault.db and vault.meta.json
  5. Run: E2E_REQUIRE_GITLAB=1 bunx nx run harness:e2e
EOF
