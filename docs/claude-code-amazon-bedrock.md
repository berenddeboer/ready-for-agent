# Claude Code on Amazon Bedrock with the Harness

Operator note for running the **Claude Code** Agent Backend through
[Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock) under Ready for
Agent. This is about readiness and process environment—not a redesign of
Settings model pickers (see [Model selection (MVP)](#model-selection-mvp)).

Upstream Claude Code setup (IAM, wizard, inference profiles, troubleshooting)
lives in Anthropic’s docs:

- [Claude Code on Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock)
- [Pin models for third-party deployments](https://code.claude.com/docs/en/model-config#pin-models-for-third-party-deployments)
- [Environment variables](https://code.claude.com/docs/en/env-vars)

## What the harness expects

When Settings selects Claude Code (`claude` on `PATH`), the harness:

1. Spawns `claude` for **Recheck / inspect** (`claude auth status`) and for
   Agent Turns.
2. **Inherits the harness process environment** for those spawns (Forge tokens,
   Anthropic vars, AWS credential-chain vars, Bedrock enablement flags, and
   model pin vars). The Claude adapter does not strip AWS or Bedrock-related
   variables.
3. Forces `DISABLE_AUTOUPDATER=1` on every Claude spawn so Harness operation
   cannot replace the CLI mid-work.
4. Does **not** integrate Keymaxxer for Anthropic or AWS secrets in this path.
   Supply credentials the same way you would for a hand-run `claude`.

Supported harness path: export Bedrock/AWS (and optional pins) **on the shell
that starts** `ready-for-agent` / the harness process. Claude may also load
`CLAUDE_CODE_USE_BEDROCK` and related values from its own
`~/.claude/settings.json` `env` block when spawned; if inspect only sees
Bedrock when the harness process itself exports the flag, treat process env as
the supported harness configuration.

## Enable Bedrock

Minimum enablement for Amazon Bedrock:

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-east-1   # or rely on profile / AWS_DEFAULT_REGION
```

Then start the harness from that environment:

```bash
npx ready-for-agent@latest
# or: ready-for-agent / bun run ready-for-agent start
```

In Settings, select **Claude Code** as the default or per-Repository Agent
Backend, then **Recheck Agent Backend**.

For full AWS-side prerequisites (model access, IAM, optional `/setup-bedrock`
wizard), follow [Claude Code on Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock).

## AWS credentials and region

Claude Code uses the **default AWS credential provider chain**. Common
operator patterns that must reach the harness process:

| Mechanism | Typical env / setup |
| --- | --- |
| Access key | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN` |
| Named profile / SSO | `AWS_PROFILE` (and a prior `aws sso login` when required) |
| Bedrock API key | `AWS_BEARER_TOKEN_BEDROCK` |
| Region | `AWS_REGION` and/or `AWS_DEFAULT_REGION` (or the active profile’s region) |

Optional Claude/Bedrock-related vars (passed through when set) include pins
below, `ANTHROPIC_BEDROCK_BASE_URL`, and others documented upstream. The
harness does not invent a separate AWS secret store for this MVP.

## Optional model pins

Settings still offers only Claude Code’s **floating aliases** (`haiku`,
`sonnet`, `opus`, `fable`). On Bedrock, those aliases resolve via Claude
Code’s defaults unless you pin them.

Pin aliases to inference profile IDs (or ARNs) with Claude’s env vars, for
example:

```bash
export ANTHROPIC_DEFAULT_OPUS_MODEL='us.anthropic.claude-opus-4-8'
export ANTHROPIC_DEFAULT_SONNET_MODEL='us.anthropic.claude-sonnet-4-6'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='us.anthropic.claude-haiku-4-5-20251001-v1:0'
# When you use the fable alias in Settings:
# export ANTHROPIC_DEFAULT_FABLE_MODEL='…your Bedrock inference profile ID or ARN…'
```

Use IDs available in your account and region (cross-region `us.` profiles,
application inference profile ARNs, GovCloud prefixes, and so on). See
[pin model versions](https://code.claude.com/docs/en/amazon-bedrock#4-pin-model-versions)
and [model configuration](https://code.claude.com/docs/en/model-config#pin-models-for-third-party-deployments)
for the full pin variable list (including Fable).

Keep using **aliases** in Harness Settings for build/review models; pins map
those aliases when Claude Code runs under Bedrock.

## Ready vs Unavailable

Inspect classifies readiness from non-interactive `claude auth status` JSON
(`loggedIn` + `apiProvider`), not from “missing claude.ai login implies
Bedrock”.

| Path | Typical cause | What you see | What to do |
| --- | --- | --- | --- |
| **First-party** (claude.ai / API key) not authenticated | No OAuth session and no usable `ANTHROPIC_API_KEY` (`loggedIn: false` on first-party) | Unavailable pointing at **`claude auth login` or `ANTHROPIC_API_KEY`** | Log in or set the API key, then Recheck |
| **Bedrock** not ready | Claude reports `apiProvider: "bedrock"` with `loggedIn: false` (unusable Bedrock/AWS readiness) | Unavailable pointing at **AWS credentials/region and `CLAUDE_CODE_USE_BEDROCK=1`**—not first-party login | Fix harness process env / AWS access, then Recheck |
| **Ready** (first-party or Bedrock) | Claude reports authenticated (including Bedrock third-party) | Agent Backend Ready; static alias catalog available | Work Items can run Agent Turns |

CLI crashes or unparseable `claude auth status` output are **not** the Bedrock
row above: they surface as a generic readiness-probe failure (exit code /
probe text). Still fix env/AWS if that is the underlying cause, then Recheck.

After fixing env or credentials, use **Recheck Agent Backend**—you do not need
a harness restart solely to refresh Bedrock readiness when the process env is
already correct on the next inspect (export env before start if you changed
the parent shell).

First-party failures and Bedrock/AWS failures use **distinct** Unavailable
copy so you know which stack to fix.

## Model selection (MVP)

**In scope today**

- Ready/Unavailable for Bedrock vs first-party as above.
- Static Settings catalog: `haiku`, `sonnet`, `opus`, `fable` only.
- Alias resolution and Bedrock inference profile / ARN pins via Claude env
  (or Claude’s own settings), not via free-text fields in the harness UI.

**Not in Settings yet**

- Free-text Bedrock inference profile IDs or application inference profile
  ARNs as the selected Agent Model.
- Dynamic listing of Bedrock models from AWS or Claude.

If you need operator-chosen Bedrock model IDs stored in harness Config /
Repository prefs, that is the follow-up: GitHub issue
[#800](https://github.com/berenddeboer/ready-for-agent/issues/800) (*Claude
Code: Bedrock model selection in Settings*). Until then, pin aliases with
env (or Claude settings) and keep selecting aliases in Settings.

## Quick checklist

1. `claude` on `PATH`.
2. `CLAUDE_CODE_USE_BEDROCK=1` (and region) available to the harness process.
3. Valid AWS credentials for Bedrock in that same process environment.
4. Optional: `ANTHROPIC_DEFAULT_*_MODEL` pins for aliases you use in Settings.
5. Settings → Claude Code → Recheck Agent Backend → Ready.
6. Build/review prefs use catalog aliases; pins handle Bedrock resolution.

## Related

- Main operator install and Agent Backend requirements: [README.md](../README.md)
- Claude Code Agent Backend decision: [ADR 0047](adr/0047-claude-code-agent-backend.md)
- Bedrock readiness MVP epic: [issue #799](https://github.com/berenddeboer/ready-for-agent/issues/799)
- Model selection follow-up: [issue #800](https://github.com/berenddeboer/ready-for-agent/issues/800)
