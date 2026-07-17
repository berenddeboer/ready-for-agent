# End-to-End Fixture Repository and Keymaxxer vault

Live Harness end-to-end validation uses a controlled private Repository and a
checked-in encrypted Keymaxxer vault that never holds the master key.

## End-to-End Fixture Repository

- Repository: `berenddeboer/test-ready-for-agent` (private)
- Sentinel Issue: `#22`
- Exact title: `E2E fixture: Ready-labeled Issue refresh`
- Must stay open and labeled `ready-for-agent`
- No hierarchy, no blockers, no Issue-closing pull request
- Non-sentinel Issues such as `#11` and `#18` must not carry `ready-for-agent`

## Checked-in vault

Path: `e2e/fixtures/keymaxxer/`

| File | Purpose |
| --- | --- |
| `vault.db` | Encrypted Keymaxxer database |
| `vault.meta.json` | Non-secret cipher metadata (`kdf: "none"` for external master key) |

The vault contains only:

- Name: `GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT`
- `provider=github`
- `account=berenddeboer/test-ready-for-agent`
- `environment=test`
- `access=read-only`

The master key is **not** committed. CI supplies it as the repository Actions
secret `E2E_KEYMAXXER_MASTER_KEY` (exposed to the e2e step as
`KEYMAXXER_MASTER_KEY`).

## Fine-grained GitHub token

Create a fine-grained personal access token in the GitHub UI (not via the API):

1. Resource owner: your user
2. Repository access: only `berenddeboer/test-ready-for-agent`
3. Permissions (read-only — nothing writeable):
   - Contents: **Read**
   - Metadata: **Read**
   - Issues: **Read**
   - Pull requests: **Read**
4. Expiration: **90 days** initially

`scripts/regenerate-e2e-keymaxxer-vault.sh` probes the token: repository /
Issues / pull-request reads must succeed, and Issue/Contents writes must fail.
Do not set `E2E_ALLOW_CONTENTS_WRITE_TOKEN=1` except for a temporary local
bootstrap; CI must use a Contents-read-only token.

When the token approaches expiry, create a replacement, regenerate the vault,
and commit the new encrypted files. Keep the same master key when possible so
`E2E_KEYMAXXER_MASTER_KEY` does not need to change.

## Regenerate the vault

Requires workspace `keymaxxer@0.2.1` (`bun install` pins it in the lockfile).

```bash
# Prefer reusing the existing Actions master key (load from your secret store
# into the environment — never put the value on the shell command line):
export E2E_KEYMAXXER_MASTER_KEY
# paste/export the 64-hex value into the env only

./scripts/regenerate-e2e-keymaxxer-vault.sh
# paste the fine-grained token at the hidden prompt (or pipe it on stdin)

# Or generate a new master key file (mode 0600), then set the Actions secret:
./scripts/regenerate-e2e-keymaxxer-vault.sh --write-master-key-to /tmp/e2e-keymaxxer-master.key
gh secret set E2E_KEYMAXXER_MASTER_KEY < /tmp/e2e-keymaxxer-master.key
shred -u /tmp/e2e-keymaxxer-master.key 2>/dev/null || rm -f /tmp/e2e-keymaxxer-master.key
```

Rules enforced by the script:

- Temporary `HOME` only — never copies over or reads `~/.keymaxxer`
- Token value enters through stdin (hidden on a TTY), never as a CLI argument
- Master key only via `E2E_KEYMAXXER_MASTER_KEY` or `--write-master-key-to`
- Probes that Issues/Contents writes are denied
- Commits only the encrypted `vault.db` and `vault.meta.json`

## Isolated clone smoke test

```bash
TMP_HOME=$(mktemp -d)
mkdir -p "$TMP_HOME/.keymaxxer"
cp e2e/fixtures/keymaxxer/vault.db e2e/fixtures/keymaxxer/vault.meta.json "$TMP_HOME/.keymaxxer/"
export HOME="$TMP_HOME"
export KEYMAXXER_MASTER_KEY  # from E2E_KEYMAXXER_MASTER_KEY / secret store
export KEYMAXXER_APPROVE=deny
bunx keymaxxer@0.2.1 run --secrets GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT -- \
  bash -c 'git clone "https://x-access-token:${GITHUB_TOKEN_BERENDDEBOER_TEST_READY_FOR_AGENT}@github.com/berenddeboer/test-ready-for-agent.git" /tmp/test-ready-for-agent-e2e-clone'
```

This leaves the developer's real Keymaxxer vault untouched.
