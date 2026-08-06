# Claude Code on Amazon Bedrock with the Harness

Operator note for running the **Claude Code** Agent Backend through
[Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock) under Ready for
Agent. Covers readiness, process environment, provider visibility (**Amazon
Bedrock** vs first-party), profile discovery, and hybrid model selection
(discovered profiles, Settings free-text, optional env pins for first-party
aliases — see [Model selection](#model-selection)).

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
5. Does **not** require the **AWS CLI** (`aws`) on `PATH`. Bedrock inference
   profile discovery uses the **AWS SDK** bundled in the packaged harness
   binary on every supported build target.

Supported harness path: export Bedrock/AWS (and optional pins) **on the shell
that starts** `ready-for-agent` / the harness process. Claude may also load
`CLAUDE_CODE_USE_BEDROCK` and related values from its own
`~/.claude/settings.json` `env` block when spawned. That Claude-only settings
path can make Agent Turns work while **profile discovery stays unavailable**
to the harness process: discovery and region/credential resolution use the
harness process environment (and the ambient AWS default provider chain), not
a full reimplementation of Claude’s settings layers. If inspect only sees
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

## Optional model pins (first-party / complementary)

Env pins map Claude **floating aliases** to concrete model identifiers
process-wide. In **Bedrock mode** the Settings catalog no longer lists
`haiku` / `sonnet` / `opus` / `fable`; prefer a **discovered profile** or
**Settings free-text** (profile ID or application ARN) as the build/review
Agent Model. Pins remain useful when you still run first-party Claude Code
aliases, or when other Claude tooling outside Settings still resolves aliases.

```bash
export ANTHROPIC_DEFAULT_OPUS_MODEL='us.anthropic.claude-opus-4-8'
export ANTHROPIC_DEFAULT_SONNET_MODEL='us.anthropic.claude-sonnet-4-6'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='us.anthropic.claude-haiku-4-5-20251001-v1:0'
# When you use the fable alias outside Bedrock catalog mode:
# export ANTHROPIC_DEFAULT_FABLE_MODEL='…your Bedrock inference profile ID or ARN…'
```

Use IDs available in your account and region (cross-region `us.` profiles,
application inference profile ARNs, GovCloud prefixes, and so on). See
[pin model versions](https://code.claude.com/docs/en/amazon-bedrock#4-pin-model-versions)
and [model configuration](https://code.claude.com/docs/en/model-config#pin-models-for-third-party-deployments)
for the full pin variable list (including Fable).

## Ready vs Unavailable

Inspect classifies readiness from non-interactive `claude auth status` JSON
(`loggedIn` + `apiProvider`), not from “missing claude.ai login implies
Bedrock”.

| Path | Typical cause | What you see | What to do |
| --- | --- | --- | --- |
| **First-party** (claude.ai / API key) not authenticated | No OAuth session and no usable `ANTHROPIC_API_KEY` (`loggedIn: false` on first-party) | Unavailable pointing at **`claude auth login` or `ANTHROPIC_API_KEY`** | Log in or set the API key, then Recheck |
| **Bedrock** not ready | Claude reports `apiProvider: "bedrock"` with `loggedIn: false` (unusable Bedrock/AWS readiness) | Unavailable pointing at **AWS credentials/region and `CLAUDE_CODE_USE_BEDROCK=1`**—not first-party login | Fix harness process env / AWS access, then Recheck |
| **Ready** (first-party) | Claude reports authenticated with `apiProvider: "firstParty"` | **Claude Code · First-party · Ready**; static alias catalog (`haiku` / `sonnet` / `opus` / `fable`) | Work Items can run Agent Turns |
| **Ready** (Bedrock) | Claude reports authenticated with `apiProvider: "bedrock"` | **Claude Code · Amazon Bedrock · Ready**; catalog is active Anthropic **system-defined** and **application** inference profiles from AWS (`ListInferenceProfiles` via the AWS SDK, ambient credentials/region). Floating aliases are **not** catalog choices in Bedrock mode. | Work Items can run Agent Turns |
| **Ready with catalog warning** | Claude is Ready on Bedrock but profile listing failed (IAM, region, throttle, credentials for control plane, etc.) | Ready status with a non-fatal warning; empty/partial catalog; free-text Agent Model still available | Fix IAM/`bedrock:ListInferenceProfiles`, region, or credentials, then **Recheck Agent Backend** |

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
| **Catalog (first-party)** | Pick `haiku`, `sonnet`, `opus`, or `fable` | Static alias catalog when Claude reports first-party |
| **Catalog (Bedrock)** | Pick a discovered system-defined or application inference profile | From AWS `ListInferenceProfiles` for the harness process account/region; ACTIVE Anthropic-backed system and application profiles. Settings show the friendly AWS profile name and **System** / **Application** kind; the stored value is the system profile ID or application ARN. Floating aliases are not listed while Bedrock is active. |
| **Free-text** | Enter a non-empty Claude-accepted model string (Bedrock inference profile ID, application inference profile ARN, dated model id, etc.) as build and/or review Agent Model | Always available for Claude Code, including when discovery fails or the profile is outside the listed set; no ARN shape check at Save. A previously saved value missing from a later catalog remains as a custom value and is never silently cleared. |
| **Env pins** | Optionally pin first-party aliases via `ANTHROPIC_DEFAULT_*_MODEL` | Maps aliases process-wide; complementary to free-text / Bedrock profile selection |

Resolved model strings are passed through as Claude `--model` on Agent Turns.
Thinking Level / effort uses the same Claude effort set (`low` … `max`) for
catalog and free-text entries; unsupported model×effort combinations fail at
turn time. Free-text is **not** gated on Bedrock readiness or `apiProvider`.

Empty / whitespace-only model values remain invalid. Invalid ids fail at turn
time as ordinary Step Run / CLI failures (no Save-time provider validation).

### Bedrock profile discovery

When inspect reports Bedrock Ready, the harness lists inference profiles with
the **AWS SDK** Bedrock control plane bundled in the packaged binary (**not**
the AWS CLI executable, and not a host preflight requirement). Discovery uses
the same ambient credential chain as the harness process and resolves region
in this order:

1. `AWS_REGION`
2. `AWS_DEFAULT_REGION`
3. `region` on the active named profile (`AWS_PROFILE`) or `default` in the
   shared AWS config file (`AWS_CONFIG_FILE` or `~/.aws/config`)
4. Remaining AWS SDK default region sources when the client is constructed
   without an explicit region

Pagination is fully exhausted. Listing is scoped to the **resolved region**
(profiles are not aggregated across regions).

**IAM**

- `bedrock:ListInferenceProfiles` is an **optional catalog-discovery**
  permission on the harness IAM principal. Without it, Claude Code can still
  be **Ready** for Agent Turns when Claude’s readiness probe succeeds.
- Listing profiles does **not** prove `bedrock:InvokeModel` or
  `bedrock:InvokeModelWithResponseStream` access. Actual invocation failures
  remain ordinary Step Run / Claude CLI failures at turn time.

**Warnings and refresh**

Discovery failure is **non-fatal** after a successful Claude readiness probe:
Claude Code stays Ready, the catalog may be empty or partial, free-text remains
usable, and Settings shows an actionable warning (access denial, expired or
missing credentials, unresolved profile/region, throttling, timeout, or generic
control-plane failure). Warnings never include access keys, session tokens,
bearer tokens, or raw credential payloads.

**Recheck Agent Backend** retries discovery and replaces the cached provider
metadata, warnings, and Agent Model catalog **atomically**. Repeated Preview
and Recheck operations do not leave mixed stale catalog/warning state. Agent
Backend Preview discovers profiles without activating Claude Code. First-party
Claude Code and every other Agent Backend make **no** AWS discovery calls.

**Catalog presentation**

- System-defined profiles: executable Agent Model = inference profile ID;
  kind `SYSTEM_DEFINED` (Settings: **System**).
- Application profiles: executable Agent Model = profile ARN; kind
  `APPLICATION` (Settings: **Application**).
- Friendly `inferenceProfileName` is display-only; Claude Code always receives
  the stored id/ARN via `--model` unchanged.
- Free-text remains for identifiers AWS does not return. Catalog-absent saved
  values stay available as custom.

**Out of scope (this path)**

- Free-text expansion for non-Claude Agent Backends (those stay
  catalog-constrained unless already free-form by design).
- Invoking listed profiles to prove model entitlement (no billable probe).
- Multi-region catalog aggregation or an AWS setup wizard in the harness.

## Quick checklist

1. `claude` on `PATH` (the AWS CLI is **not** required).
2. `CLAUDE_CODE_USE_BEDROCK=1` (and region) available to the **harness process**,
   not only inside Claude Code settings.
3. Valid AWS credentials for Bedrock in that same process environment.
4. Settings → Claude Code → Recheck Agent Backend → status shows
   **Claude Code · Amazon Bedrock · Ready** (or Ready with a catalog warning).
5. Build/review prefs: select a discovered system-defined profile ID or
   application profile ARN from the catalog (friendly name + kind shown in
   Settings), **or** free-text any Claude-accepted Bedrock profile ID/ARN
   (stored in Harness Config / Repository model prefs).
6. Optional: `ANTHROPIC_DEFAULT_*_MODEL` pins when using first-party aliases
   outside Bedrock catalog mode.
7. Optional: grant `bedrock:ListInferenceProfiles` for catalog population.
   Agent Turns do not depend on it when free-text or a saved model is set.
8. If Settings shows a discovery warning, fix IAM/region/credentials/profile
   and Recheck (Agent Turns can still run with free-text models meanwhile).

## Related

- Main operator install and Agent Backend requirements: [README.md](../README.md)
- Claude Code Agent Backend decision: [ADR 0047](adr/0047-claude-code-agent-backend.md)
- Provider + discovery epic: [issue #818](https://github.com/berenddeboer/ready-for-agent/issues/818)
- Bedrock readiness MVP epic: [issue #799](https://github.com/berenddeboer/ready-for-agent/issues/799)
- Model selection (hybrid aliases + free-text): [issue #800](https://github.com/berenddeboer/ready-for-agent/issues/800) / [issue #806](https://github.com/berenddeboer/ready-for-agent/issues/806)
