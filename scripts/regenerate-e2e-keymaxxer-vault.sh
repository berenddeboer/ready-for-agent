#!/usr/bin/env bash
# Regenerate the checked-in encrypted Keymaxxer vault for live e2e runs.
#
# Isolation: uses a temporary HOME so the developer's real ~/.keymaxxer is never
# read or overwritten.
#
# Secrets (never pass tokens as CLI arguments):
#   - Fine-grained GitHub token for berenddeboer/test-ready-for-agent (stdin)
#   - Optional GitLab PAT for the git.drupalcode.org fixture (second stdin line,
#     or --with-gitlab with a second prompt / piped line)
#   - Master key from E2E_KEYMAXXER_MASTER_KEY (64 hex). When unset, a new key
#     is generated only via --write-master-key-to.
#
# GitHub token (create in GitHub UI, 90-day expiry initially):
#   name: e2e-test-ready-for-agent-readonly
#   repository: berenddeboer/test-ready-for-agent only
#   permissions (read): Contents, Metadata, Issues, Pull requests
#
# GitLab token (create at https://git.drupalcode.org/-/user_settings/personal_access_tokens):
#   scopes: read_api, read_repository (write scopes only for lifecycle demos)
#   account metadata: provider=gitlab account=git.drupalcode.org/<project-path>
#
# After regeneration, set the Actions secret without echoing the key:
#   gh secret set E2E_KEYMAXXER_MASTER_KEY < /path/to/master.key
#
# Rotation: regenerate before fine-grained token expiry (GitHub ~90 days).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="${ROOT}/e2e/fixtures/keymaxxer"
GITHUB_SECRET_NAME="GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT"
GITHUB_REPO="berenddeboer/test-ready-for-agent"
GITLAB_FORGE_HOST="${E2E_GITLAB_FORGE_HOST:-git.drupalcode.org}"
GITLAB_PROJECT_PATH="${E2E_GITLAB_PROJECT_PATH:-sandbox/berend-test-ready-for-agent}"
GITLAB_VAULT_ACCOUNT="${GITLAB_FORGE_HOST}/${GITLAB_PROJECT_PATH}"
# Stable Keymaxxer name (does not change when E2E_GITLAB_PROJECT_PATH overrides
# the account path). Keep in sync with apps/harness/e2e/support/constants.ts.
GITLAB_SECRET_NAME="GITLAB_TOKEN_GIT_DRUPALCODE_ORG_SANDBOX_BEREND_TEST_READY_FOR_AGENT"
WRITE_MASTER_KEY_TO=""
WITH_GITLAB=0
# Explicit GitHub-only rebuild after dual-secret bootstrap (drops GitLab secret).
GITHUB_ONLY=0

usage() {
  cat <<'EOF'
Usage: regenerate-e2e-keymaxxer-vault.sh [options]

Reads the fine-grained GitHub token from stdin (hidden if a TTY).
With --with-gitlab, also reads a GitLab PAT (second line / second prompt).

Options:
  --with-gitlab                Include the GitLab e2e fixture credential.
  --github-only                Allow rewriting the vault without GitLab even
                               when the committed vault already has the GitLab
                               secret (drops that secret). Prefer --with-gitlab
                               for normal rotation after GitLab bootstrap.
  --write-master-key-to PATH   When generating a new master key, write it only
                               to PATH (mode 0600). Required if
                               E2E_KEYMAXXER_MASTER_KEY is unset.
  -h, --help                   Show this help.

Environment:
  E2E_KEYMAXXER_MASTER_KEY     Existing 64-hex master key (preferred for
                               rotation that keeps the Actions secret).
  E2E_GITLAB_FORGE_HOST        Default git.drupalcode.org
  E2E_GITLAB_PROJECT_PATH       Default sandbox/berend-test-ready-for-agent
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-gitlab)
      WITH_GITLAB=1
      shift
      ;;
    --github-only)
      GITHUB_ONLY=1
      shift
      ;;
    --write-master-key-to)
      WRITE_MASTER_KEY_TO="${2:?--write-master-key-to requires a path}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${WITH_GITLAB}" -eq 1 && "${GITHUB_ONLY}" -eq 1 ]]; then
  echo "error: --with-gitlab and --github-only are mutually exclusive" >&2
  exit 2
fi

keymaxxer_bin() {
  if [[ -x "${ROOT}/node_modules/.bin/keymaxxer" ]]; then
    echo "${ROOT}/node_modules/.bin/keymaxxer"
    return
  fi
  echo "error: keymaxxer 0.2.1 is not installed. Run: bun install" >&2
  exit 1
}

run_keymaxxer() {
  # Run outside the repo so `keymaxxer init` does not write .mcp.json into git.
  (cd "${TMP_HOME:-${TMPDIR:-/tmp}}" && "$(keymaxxer_bin)" "$@")
}

if [[ -n "${E2E_KEYMAXXER_MASTER_KEY:-}" ]]; then
  if [[ ! "${E2E_KEYMAXXER_MASTER_KEY}" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "error: E2E_KEYMAXXER_MASTER_KEY must be 64 hex characters" >&2
    exit 1
  fi
else
  if [[ -z "${WRITE_MASTER_KEY_TO}" ]]; then
    echo "error: set E2E_KEYMAXXER_MASTER_KEY or pass --write-master-key-to PATH" >&2
    exit 1
  fi
  umask 077
  openssl rand -hex 32 >"${WRITE_MASTER_KEY_TO}"
  chmod 600 "${WRITE_MASTER_KEY_TO}"
  E2E_KEYMAXXER_MASTER_KEY="$(tr -d '[:space:]' <"${WRITE_MASTER_KEY_TO}")"
  echo "Wrote new master key to ${WRITE_MASTER_KEY_TO} (not committed)." >&2
  echo "Set the Actions secret with:" >&2
  echo "  gh secret set E2E_KEYMAXXER_MASTER_KEY < ${WRITE_MASTER_KEY_TO}" >&2
fi

export KEYMAXXER_MASTER_KEY="${E2E_KEYMAXXER_MASTER_KEY}"
export KEYMAXXER_APPROVE=deny

# Refuse to silently drop an existing dual-secret fixture vault.
if [[ "${WITH_GITLAB}" -eq 0 && "${GITHUB_ONLY}" -eq 0 ]]; then
  if [[ -f "${FIXTURE_DIR}/vault.db" && -f "${FIXTURE_DIR}/vault.meta.json" ]]; then
    GUARD_HOME="$(mktemp -d "${TMPDIR:-/tmp}/rfa-e2e-keymaxxer-guard.XXXXXX")"
    mkdir -p "${GUARD_HOME}/.keymaxxer"
    cp -f "${FIXTURE_DIR}/vault.db" "${FIXTURE_DIR}/vault.meta.json" "${GUARD_HOME}/.keymaxxer/"
    set +e
    GUARD_LIST="$(
      HOME="${GUARD_HOME}" KEYMAXXER_MASTER_KEY="${KEYMAXXER_MASTER_KEY}" KEYMAXXER_APPROVE=deny \
        run_keymaxxer list 2>"${GUARD_HOME}/list.err"
    )"
    GUARD_STATUS=$?
    set -e
    GUARD_ERR="$(cat "${GUARD_HOME}/list.err" 2>/dev/null || true)"
    rm -rf "${GUARD_HOME}"
    if [[ "${GUARD_STATUS}" -ne 0 ]]; then
      cat <<EOF >&2
error: could not list the committed fixture vault to check for ${GITLAB_SECRET_NAME}
(keymaxxer exit ${GUARD_STATUS}). Refusing GitHub-only regeneration to avoid
silently dropping a dual-secret vault.

  - Prefer:  ./scripts/regenerate-e2e-keymaxxer-vault.sh --with-gitlab
  - Or pass: --github-only  (explicitly discard any GitLab secret)
  - Ensure E2E_KEYMAXXER_MASTER_KEY matches the committed vault

${GUARD_ERR}
EOF
      exit 1
    fi
    if grep -q "${GITLAB_SECRET_NAME}" <<<"${GUARD_LIST}"; then
      cat <<EOF >&2
error: committed fixture vault already contains ${GITLAB_SECRET_NAME}.

Regenerating without --with-gitlab would drop the GitLab e2e credential.
  - Prefer:  ./scripts/regenerate-e2e-keymaxxer-vault.sh --with-gitlab
  - Or pass: --github-only  (explicitly discard the GitLab secret)
EOF
      exit 1
    fi
  fi
fi

read_secret_line() {
  local prompt="$1"
  local value=""
  if [[ -t 0 ]]; then
    echo "${prompt}" >&2
    # shellcheck disable=SC2162
    IFS= read -r -s value
    echo >&2
  else
    IFS= read -r value || true
  fi
  printf '%s' "${value}" | tr -d '\r\n'
}

GITHUB_TOKEN="$(read_secret_line "Paste the fine-grained GitHub token for ${GITHUB_REPO} (input hidden), then Enter:")"
if [[ -z "${GITHUB_TOKEN}" ]]; then
  echo "error: empty GitHub token on stdin" >&2
  exit 1
fi

GITLAB_TOKEN=""
if [[ "${WITH_GITLAB}" -eq 1 ]]; then
  GITLAB_TOKEN="$(read_secret_line "Paste the GitLab PAT for ${GITLAB_VAULT_ACCOUNT} (input hidden), then Enter:")"
  if [[ -z "${GITLAB_TOKEN}" ]]; then
    echo "error: empty GitLab token (--with-gitlab requires a PAT)" >&2
    exit 1
  fi
fi

TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/rfa-e2e-keymaxxer.XXXXXX")"
cleanup() {
  rm -rf "${TMP_HOME}"
}
trap cleanup EXIT

export HOME="${TMP_HOME}"
mkdir -p "${HOME}/.keymaxxer"
chmod 700 "${HOME}/.keymaxxer"

run_keymaxxer init

printf '%s' "${GITHUB_TOKEN}" | run_keymaxxer set "${GITHUB_SECRET_NAME}" \
  --provider github \
  --account "${GITHUB_REPO}" \
  --env test \
  --access read-only \
  --description "Read-only e2e fixture token for ${GITHUB_REPO} (90-day rotation)"

if [[ "${WITH_GITLAB}" -eq 1 ]]; then
  printf '%s' "${GITLAB_TOKEN}" | run_keymaxxer set "${GITLAB_SECRET_NAME}" \
    --provider gitlab \
    --account "${GITLAB_VAULT_ACCOUNT}" \
    --env test \
    --access read-only \
    --description "Read-only e2e fixture token for ${GITLAB_VAULT_ACCOUNT}"
fi

LIST_OUT="$(run_keymaxxer list)"
if ! grep -q "${GITHUB_SECRET_NAME}" <<<"${LIST_OUT}"; then
  echo "error: vault does not contain ${GITHUB_SECRET_NAME}" >&2
  echo "${LIST_OUT}" >&2
  exit 1
fi
if [[ "${WITH_GITLAB}" -eq 1 ]] && ! grep -q "${GITLAB_SECRET_NAME}" <<<"${LIST_OUT}"; then
  echo "error: vault does not contain ${GITLAB_SECRET_NAME}" >&2
  echo "${LIST_OUT}" >&2
  exit 1
fi

EXPECTED_COUNT=1
[[ "${WITH_GITLAB}" -eq 1 ]] && EXPECTED_COUNT=2
SECRET_LINES="$(grep -E '^[A-Z][A-Z0-9_]*' <<<"${LIST_OUT}" || true)"
ACTUAL_COUNT="$(grep -c . <<<"${SECRET_LINES}" || true)"
if [[ "${ACTUAL_COUNT}" -ne "${EXPECTED_COUNT}" ]]; then
  echo "error: vault must contain exactly ${EXPECTED_COUNT} secret(s); list was:" >&2
  echo "${LIST_OUT}" >&2
  exit 1
fi
if [[ "${WITH_GITLAB}" -eq 0 ]]; then
  OTHER="$(grep -E '^[A-Z][A-Z0-9_]*' <<<"${LIST_OUT}" | grep -v "${GITHUB_SECRET_NAME}" || true)"
  if [[ -n "${OTHER}" ]]; then
    echo "error: vault must contain only ${GITHUB_SECRET_NAME}; also found:" >&2
    echo "${OTHER}" >&2
    exit 1
  fi
fi

# --- GitHub permission probe ---
# Body path under $HOME (the isolated TMP_HOME vault env) to avoid /tmp races.
PROBE_SCRIPT="${TMP_HOME}/probe-github-token-permissions.sh"
cat >"${PROBE_SCRIPT}" <<'PROBE'
#!/usr/bin/env bash
set -euo pipefail
tok="${GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT:?}"
repo="berenddeboer/test-ready-for-agent"
probe_body="${HOME}/rfa-e2e-github-probe-body.json"
api() {
  local method="$1" path="$2"
  shift 2
  curl -sS -o "${probe_body}" -w "%{http_code}" \
    -X "${method}" \
    -H "Authorization: Bearer ${tok}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com${path}" \
    "$@"
}

code="$(api GET "/repos/${repo}")"
if [[ "${code}" != "200" ]]; then
  echo "error: GET repository returned HTTP ${code}" >&2
  exit 1
fi
code="$(api GET "/repos/${repo}/issues?per_page=1")"
if [[ "${code}" != "200" ]]; then
  echo "error: GET issues returned HTTP ${code}" >&2
  exit 1
fi
code="$(api GET "/repos/${repo}/pulls?per_page=1")"
if [[ "${code}" != "200" ]]; then
  echo "error: GET pulls returned HTTP ${code}" >&2
  exit 1
fi
code="$(api POST "/repos/${repo}/issues" -d '{"title":"e2e-permission-probe","body":"must fail"}')"
if [[ "${code}" != "403" && "${code}" != "404" ]]; then
  echo "error: token must not create Issues (got HTTP ${code}); use Issues read-only" >&2
  exit 1
fi
code="$(api PUT "/repos/${repo}/contents/.e2e-permission-probe" -d '{"message":"e2e permission probe","content":"eA=="}')"
if [[ "${code}" == "201" || "${code}" == "200" ]]; then
  sha="$(sed -n 's/.*"sha": *"\([^"]*\)".*/\1/p' "${probe_body}" | head -1)"
  if [[ -n "${sha}" ]]; then
    api DELETE "/repos/${repo}/contents/.e2e-permission-probe" \
      -d "{\"message\":\"remove e2e permission probe\",\"sha\":\"${sha}\"}" >/dev/null || true
  fi
  if [[ "${E2E_ALLOW_CONTENTS_WRITE_TOKEN:-}" == "1" ]]; then
    echo "warning: token can write Contents; regenerate with Contents: Read only before relying on CI" >&2
  else
    echo "error: token must not write Contents (got HTTP ${code}); use Contents read-only" >&2
    echo "hint: create a fine-grained PAT with Contents/Issues/PRs read-only, or set E2E_ALLOW_CONTENTS_WRITE_TOKEN=1 only for local bootstrap" >&2
    exit 1
  fi
elif [[ "${code}" != "403" && "${code}" != "404" ]]; then
  echo "error: unexpected Contents write probe HTTP ${code}" >&2
  exit 1
fi
PROBE
chmod 700 "${PROBE_SCRIPT}"
run_keymaxxer run --secrets "${GITHUB_SECRET_NAME}" -- "${PROBE_SCRIPT}"

# --- GitLab permission probe (optional) ---
if [[ "${WITH_GITLAB}" -eq 1 ]]; then
  GITLAB_PROBE="${TMP_HOME}/probe-gitlab-token-permissions.sh"
  # Probe body stays under TMP_HOME so concurrent regenerations do not collide.
  GITLAB_PROBE_BODY="${TMP_HOME}/rfa-e2e-gitlab-probe-body.json"
  cat >"${GITLAB_PROBE}" <<PROBE
#!/usr/bin/env bash
set -euo pipefail
tok="\${${GITLAB_SECRET_NAME}:?}"
host="${GITLAB_FORGE_HOST}"
project_path="${GITLAB_PROJECT_PATH}"
probe_body="${GITLAB_PROBE_BODY}"
encoded="\$(python3 -c "import urllib.parse; print(urllib.parse.quote('\${project_path}', safe=''))")"
api() {
  local method="\$1" path="\$2"
  shift 2
  curl -sS -o "\${probe_body}" -w "%{http_code}" \\
    -X "\${method}" \\
    -H "PRIVATE-TOKEN: \${tok}" \\
    "https://\${host}/api/v4\${path}" \\
    "\$@"
}

code="\$(api GET "/user")"
if [[ "\${code}" != "200" ]]; then
  echo "error: GitLab GET /user returned HTTP \${code}" >&2
  exit 1
fi
code="\$(api GET "/projects/\${encoded}")"
if [[ "\${code}" != "200" ]]; then
  echo "error: GitLab GET project \${project_path} returned HTTP \${code}" >&2
  echo "hint: create the throwaway fixture project and ensure the PAT can read it" >&2
  exit 1
fi
code="\$(api GET "/projects/\${encoded}/issues?per_page=1")"
if [[ "\${code}" != "200" ]]; then
  echo "error: GitLab GET issues returned HTTP \${code} (Issues must be enabled on the fixture project)" >&2
  exit 1
fi
code="\$(api GET "/projects/\${encoded}/merge_requests?per_page=1")"
if [[ "\${code}" != "200" ]]; then
  echo "error: GitLab GET merge_requests returned HTTP \${code}" >&2
  exit 1
fi
# Prefer read-only: issue create should fail for CI tokens.
code="\$(api POST "/projects/\${encoded}/issues" -d "title=e2e-permission-probe&description=must fail")"
if [[ "\${code}" == "201" ]]; then
  iid="\$(sed -n 's/.*"iid": *\\([0-9]*\\).*/\\1/p' "\${probe_body}" | head -1)"
  if [[ -n "\${iid}" ]]; then
    api DELETE "/projects/\${encoded}/issues/\${iid}" >/dev/null || true
  fi
  if [[ "\${E2E_ALLOW_GITLAB_WRITE_TOKEN:-}" == "1" ]]; then
    echo "warning: GitLab token can create Issues; use read_api-only for CI when possible" >&2
  else
    echo "error: GitLab token must not create Issues (got HTTP \${code}); use read_api + read_repository" >&2
    echo "hint: set E2E_ALLOW_GITLAB_WRITE_TOKEN=1 only for local bootstrap of the sentinel Issue" >&2
    exit 1
  fi
elif [[ "\${code}" != "403" && "\${code}" != "401" && "\${code}" != "404" ]]; then
  echo "error: unexpected GitLab issue-create probe HTTP \${code}" >&2
  exit 1
fi

# Git HTTPS clone uses oauth2:<token> and requires read_repository (not just read_api).
# Fail regeneration if ls-remote cannot authenticate/read, or if the repo has no refs.
set +e
ls_out="\$(git ls-remote "https://oauth2:\${tok}@\${host}/\${project_path}.git" 2>"\${HOME}/ls-remote.err")"
ls_status=\$?
set -e
if [[ "\${ls_status}" -ne 0 ]]; then
  echo "error: git ls-remote failed for \${host}/\${project_path} (exit \${ls_status})" >&2
  echo "hint: PAT needs read_repository; project must be cloneable over HTTPS" >&2
  cat "\${HOME}/ls-remote.err" >&2 || true
  exit 1
fi
if [[ -z "\${ls_out}" ]]; then
  echo "error: git ls-remote returned no refs for \${host}/\${project_path}" >&2
  echo "hint: push an initial commit on the default branch before regenerating the vault" >&2
  exit 1
fi
echo "✓ git ls-remote succeeded for \${host}/\${project_path}" >&2
PROBE
  chmod 700 "${GITLAB_PROBE}"
  run_keymaxxer run --secrets "${GITLAB_SECRET_NAME}" -- "${GITLAB_PROBE}"
fi

# Flush multiprocess WAL into vault.db so only vault.db + vault.meta.json need committing.
# Quoted heredoc: expected count is passed only via process.argv (not shell expansion).
CHECKPOINT_SCRIPT="${TMP_HOME}/checkpoint-vault.mjs"
cat >"${CHECKPOINT_SCRIPT}" <<'JS'
import { connect } from "@tursodatabase/database"
import { unlinkSync } from "node:fs"

const path = process.argv[2]
const expected = Number(process.argv[3] ?? "1")
const hexkey = process.env.KEYMAXXER_MASTER_KEY
if (!hexkey || !/^[0-9a-fA-F]{64}$/.test(hexkey)) {
  console.error("error: KEYMAXXER_MASTER_KEY must be 64 hex characters")
  process.exit(1)
}
const db = await connect(path, {
  encryption: { cipher: "aes256gcm", hexkey: hexkey.toLowerCase() },
})
try {
  await db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()
  const row = await db.prepare("select count(*) as c from secrets").get()
  if (!row || Number(row.c) !== expected) {
    console.error(
      `error: expected exactly ${expected} secret(s) after checkpoint, got ${row?.c}`,
    )
    process.exit(1)
  }
} finally {
  await db.close?.()
}
for (const side of [`${path}-wal`, `${path}-shm`, `${path}-tshm`]) {
  try {
    unlinkSync(side)
  } catch {
    /* absent */
  }
}
JS
(
  cd "${ROOT}"
  bun "${CHECKPOINT_SCRIPT}" "${HOME}/.keymaxxer/vault.db" "${EXPECTED_COUNT}"
)

mkdir -p "${FIXTURE_DIR}"
cp -f "${HOME}/.keymaxxer/vault.db" "${FIXTURE_DIR}/vault.db"
cp -f "${HOME}/.keymaxxer/vault.meta.json" "${FIXTURE_DIR}/vault.meta.json"
chmod 644 "${FIXTURE_DIR}/vault.db" "${FIXTURE_DIR}/vault.meta.json"
rm -f "${FIXTURE_DIR}/vault.db-wal" "${FIXTURE_DIR}/vault.db-shm" \
  "${FIXTURE_DIR}/vault.db-tshm" 2>/dev/null || true

# Verify the committed files open in an isolated HOME without the developer's vault.
VERIFY_HOME="$(mktemp -d "${TMPDIR:-/tmp}/rfa-e2e-keymaxxer-verify.XXXXXX")"
mkdir -p "${VERIFY_HOME}/.keymaxxer"
cp -f "${FIXTURE_DIR}/vault.db" "${FIXTURE_DIR}/vault.meta.json" "${VERIFY_HOME}/.keymaxxer/"
VERIFY_LIST="$(
  HOME="${VERIFY_HOME}" KEYMAXXER_MASTER_KEY="${KEYMAXXER_MASTER_KEY}" KEYMAXXER_APPROVE=deny \
    run_keymaxxer list
)"
rm -rf "${VERIFY_HOME}"
if ! grep -q "${GITHUB_SECRET_NAME}" <<<"${VERIFY_LIST}"; then
  echo "error: verified fixture vault is missing ${GITHUB_SECRET_NAME}" >&2
  echo "${VERIFY_LIST}" >&2
  exit 1
fi
if [[ "${WITH_GITLAB}" -eq 1 ]] && ! grep -q "${GITLAB_SECRET_NAME}" <<<"${VERIFY_LIST}"; then
  echo "error: verified fixture vault is missing ${GITLAB_SECRET_NAME}" >&2
  echo "${VERIFY_LIST}" >&2
  exit 1
fi

echo "✓ Wrote ${FIXTURE_DIR}/vault.db and vault.meta.json" >&2
echo "  github secret: ${GITHUB_SECRET_NAME}" >&2
echo "  github metadata: provider=github account=${GITHUB_REPO} environment=test access=read-only" >&2
if [[ "${WITH_GITLAB}" -eq 1 ]]; then
  echo "  gitlab secret: ${GITLAB_SECRET_NAME}" >&2
  echo "  gitlab metadata: provider=gitlab account=${GITLAB_VAULT_ACCOUNT} environment=test access=read-only" >&2
else
  echo "  gitlab secret: (omitted — re-run with --with-gitlab after the fixture project exists)" >&2
fi
echo "  master key: not written to the repository (use E2E_KEYMAXXER_MASTER_KEY in CI)" >&2
echo "  rotate tokens on schedule and re-run this script" >&2
