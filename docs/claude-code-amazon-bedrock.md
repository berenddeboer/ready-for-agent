# Claude Code on Amazon Bedrock with the Harness

Operator note for running the **Claude Code** Agent Backend through
[Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock) under Ready for
Agent. Covers readiness, process environment, and hybrid model selection
(catalog aliases, Settings free-text, optional env pins — see
[Model selection](#model-selection)).

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

## Optional model pins (complementary)

Env pins map **catalog aliases** to Bedrock inference profiles process-wide.
They are complementary to Settings free-text (below), not the only selection
path.

When you select aliases (`haiku` / `sonnet` / `opus` / `fable`) in Settings, pin
them with Claude’s env vars if Bedrock defaults are not what you want:

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

Prefer **Settings free-text** when you need a specific Bedrock profile ID or
ARN stored as the build/review Agent Model (multi-repo, visible prefs, no
re-export). Prefer **pins** when operators stay on aliases and share one
process-wide mapping.

## Ready vs Unavailable

Inspect classifies readiness from non-interactive `claude auth status` JSON
(`loggedIn` + `apiProvider`), not from “missing claude.ai login implies
Bedrock”.

| Path | Typical cause | What you see | What to do |
| --- | --- | --- | --- |
| **First-party** (claude.ai / API key) not authenticated | No OAuth session and no usable `ANTHROPIC_API_KEY` (`loggedIn: false` on first-party) | Unavailable pointing at **`claude auth login` or `ANTHROPIC_API_KEY`** | Log in or set the API key, then Recheck |
| **Bedrock** not ready | Claude reports `apiProvider: "bedrock"` with `loggedIn: false` (unusable Bedrock/AWS readiness) | Unavailable pointing at **AWS credentials/region and `CLAUDE_CODE_USE_BEDROCK=1`**—not first-party login | Fix harness process env / AWS access, then Recheck |
| **Ready** (first-party) | Claude reports authenticated with `apiProvider: "firstParty"` | **Claude Code · First-party · Ready**; static alias catalog available | Work Items can run Agent Turns |
| **Ready** (Bedrock) | Claude reports authenticated with `apiProvider: "bedrock"` | **Claude Code · Amazon Bedrock · Ready**; static alias catalog available | Work Items can run Agent Turns |

CLI crashes or unparseable `claude auth status` output are **not** the Bedrock
row above: they surface as a generic readiness-probe failure (exit code /
probe text). Still fix env/AWS if that is the underlying cause, then Recheck.

After fixing env or credentials, use **Recheck Agent Backend**—you do not need
a harness restart solely to refresh Bedrock readiness when the process env is
already correct on the next inspect (export env before start if you changed
the parent shell).

First-party failures and Bedrock/AWS failures use **distinct** Unavailable
copy so you know which stack to fix.

## Model selection

Hybrid selection for the **Claude Code** Agent Backend (Harness Config and
per-Repository prefs; same backend-scoped model fields as other backends):

| Path | What you do | Notes |
| --- | --- | --- |
| **Catalog alias** | Pick `haiku`, `sonnet`, `opus`, or `fable` | Default UX; first-party and typical Bedrock |
| **Free-text** | Enter a non-empty Claude-accepted model string (Bedrock inference profile ID, application inference profile ARN, dated model id, etc.) as build and/or review Agent Model | Allowed even when absent from the static catalog; no ARN shape check at Save |
| **Env pins** | Optionally pin aliases via `ANTHROPIC_DEFAULT_*_MODEL` | Maps aliases process-wide; complementary, not required for free-text |

Resolved model strings are passed through as Claude `--model` on Agent Turns.
Thinking Level / effort for free-text uses the same Claude effort set as
aliases (`low` … `max`); unsupported model×effort combinations fail at turn
time. Free-text is **not** gated on Bedrock readiness or `apiProvider` — the
same Claude prefs may hold an alias or custom id on first-party or Bedrock.

Empty / whitespace-only model values remain invalid. Invalid ids fail at turn
time as ordinary Step Run / CLI failures (no Save-time provider validation).

**Out of scope**

- Dynamic listing of Bedrock models from AWS or Claude.
- Free-text expansion for non-Claude Agent Backends (those stay
  catalog-constrained unless already free-form by design).

## Quick checklist

1. `claude` on `PATH`.
2. `CLAUDE_CODE_USE_BEDROCK=1` (and region) available to the harness process.
3. Valid AWS credentials for Bedrock in that same process environment.
4. Settings → Claude Code → Recheck Agent Backend → Ready.
5. Build/review prefs: catalog alias **or** free-text Bedrock profile ID/ARN
   (stored in Harness Config / Repository model prefs).
6. Optional: `ANTHROPIC_DEFAULT_*_MODEL` pins when you keep using aliases.

## Related

- Main operator install and Agent Backend requirements: [README.md](../README.md)
- Claude Code Agent Backend decision: [ADR 0047](adr/0047-claude-code-agent-backend.md)
- Bedrock readiness MVP epic: [issue #799](https://github.com/berenddeboer/ready-for-agent/issues/799)
- Model selection (hybrid aliases + free-text): [issue #800](https://github.com/berenddeboer/ready-for-agent/issues/800) / [issue #806](https://github.com/berenddeboer/ready-for-agent/issues/806)
