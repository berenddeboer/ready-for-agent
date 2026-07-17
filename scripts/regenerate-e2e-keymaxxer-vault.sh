#!/usr/bin/env bash
# Regenerate the checked-in encrypted Keymaxxer vault for live e2e runs.
#
# Isolation: uses a temporary HOME so the developer's real ~/.keymaxxer is never
# read or overwritten.
#
# Secrets:
#   - Fine-grained GitHub token for berenddeboer/test-ready-for-agent is read
#     from stdin (hidden when interactive). Never pass it as a CLI argument.
#   - Master key comes from E2E_KEYMAXXER_MASTER_KEY (64 hex chars). When unset,
#     a new key is generated and written only via --write-master-key-to.
#
# Required token (create in GitHub UI, 90-day expiry initially):
#   name: e2e-test-ready-for-agent-readonly
#   repository: berenddeboer/test-ready-for-agent only
#   permissions (read): Contents, Metadata, Issues, Pull requests
#
# After regeneration, set the Actions secret without echoing the key:
#   gh secret set E2E_KEYMAXXER_MASTER_KEY < /path/to/master.key
#
# Rotation expectation: fine-grained tokens expire after 90 days; regenerate the
# vault (and rotate the Actions secret if the master key changed) before expiry.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="${ROOT}/e2e/fixtures/keymaxxer"
SECRET_NAME="GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT"
REPO="berenddeboer/test-ready-for-agent"
WRITE_MASTER_KEY_TO=""

usage() {
  cat <<'EOF'
Usage: regenerate-e2e-keymaxxer-vault.sh [options]

Reads the fine-grained GitHub token from stdin (hidden if a TTY).

Options:
  --write-master-key-to PATH   When generating a new master key, write it only
                               to PATH (mode 0600). Required if
                               E2E_KEYMAXXER_MASTER_KEY is unset.
  -h, --help                   Show this help.

Environment:
  E2E_KEYMAXXER_MASTER_KEY     Existing 64-hex master key (preferred for
                               rotation that keeps the Actions secret).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

if [[ -t 0 ]]; then
  echo "Paste the fine-grained GitHub token for ${REPO} (input hidden), then Enter:" >&2
  # shellcheck disable=SC2162
  IFS= read -r -s TOKEN
  echo >&2
else
  TOKEN="$(cat)"
fi

TOKEN="$(printf '%s' "${TOKEN}" | tr -d '\r\n')"
if [[ -z "${TOKEN}" ]]; then
  echo "error: empty token on stdin" >&2
  exit 1
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

printf '%s' "${TOKEN}" | run_keymaxxer set "${SECRET_NAME}" \
  --provider github \
  --account "${REPO}" \
  --env test \
  --access read-only \
  --description "Read-only e2e fixture token for ${REPO} (90-day rotation)"

LIST_OUT="$(run_keymaxxer list)"
if ! grep -q "${SECRET_NAME}" <<<"${LIST_OUT}"; then
  echo "error: vault does not contain ${SECRET_NAME}" >&2
  echo "${LIST_OUT}" >&2
  exit 1
fi
OTHER="$(grep -E '^[A-Z][A-Z0-9_]*' <<<"${LIST_OUT}" | grep -v "${SECRET_NAME}" || true)"
if [[ -n "${OTHER}" ]]; then
  echo "error: vault must contain only ${SECRET_NAME}; also found:" >&2
  echo "${OTHER}" >&2
  exit 1
fi

PROBE_SCRIPT="${TMP_HOME}/probe-token-permissions.sh"
cat >"${PROBE_SCRIPT}" <<'PROBE'
#!/usr/bin/env bash
set -euo pipefail
tok="${GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT:?}"
repo="berenddeboer/test-ready-for-agent"
api() {
  local method="$1" path="$2"
  shift 2
  curl -sS -o /tmp/rfa-e2e-probe-body.json -w "%{http_code}" \
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
  sha="$(sed -n 's/.*"sha": *"\([^"]*\)".*/\1/p' /tmp/rfa-e2e-probe-body.json | head -1)"
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

run_keymaxxer run --secrets "${SECRET_NAME}" -- "${PROBE_SCRIPT}"

# Flush multiprocess WAL into vault.db so only vault.db + vault.meta.json need committing.
CHECKPOINT_SCRIPT="${TMP_HOME}/checkpoint-vault.mjs"
cat >"${CHECKPOINT_SCRIPT}" <<'JS'
import { connect } from "@tursodatabase/database"
import { unlinkSync } from "node:fs"

const path = process.argv[2]
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
  if (!row || Number(row.c) !== 1) {
    console.error(`error: expected exactly 1 secret after checkpoint, got ${row?.c}`)
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
  bun "${CHECKPOINT_SCRIPT}" "${HOME}/.keymaxxer/vault.db"
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
if ! grep -q "${SECRET_NAME}" <<<"${VERIFY_LIST}"; then
  echo "error: verified fixture vault is missing ${SECRET_NAME}" >&2
  echo "${VERIFY_LIST}" >&2
  exit 1
fi

echo "✓ Wrote ${FIXTURE_DIR}/vault.db and vault.meta.json" >&2
echo "  secret: ${SECRET_NAME}" >&2
echo "  metadata: provider=github account=${REPO} environment=test access=read-only" >&2
echo "  master key: not written to the repository (use E2E_KEYMAXXER_MASTER_KEY in CI)" >&2
echo "  rotate the fine-grained token within 90 days and re-run this script" >&2
