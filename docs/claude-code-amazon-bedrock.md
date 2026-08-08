# Claude Code on Amazon Bedrock

The harness follows Claude Code's own convention: when the harness
process has `CLAUDE_CODE_USE_BEDROCK=1`, Claude Code runs against
Amazon Bedrock. That's all there is to it. For everything AWS-side —
model access, IAM, credentials, region, model pins — follow
[Anthropic's Bedrock
documentation](https://code.claude.com/docs/en/amazon-bedrock).

## Setup

Export the flag and your AWS credentials/region on the shell that
starts the harness:

```bash
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=us-east-1
npx ready-for-agent@latest
```

One harness-specific caveat: the env must be on the **harness
process**. Claude Code can also read `CLAUDE_CODE_USE_BEDROCK` from
its own `~/.claude/settings.json`, but the harness does not — with
only that, Settings keeps saying **Claude Code** and inference
profile discovery stays unavailable.

In Settings, select **Claude Code Bedrock** as the Agent Backend and
Recheck. Status shows **Claude Code · Amazon Bedrock** when ready.
After fixing credentials or IAM, Recheck is enough — no harness
restart needed, as long as the env was correct on the harness process.

## Model selection

In Bedrock mode the model catalog is the active Anthropic inference
profiles discovered from your AWS account and region (no AWS CLI
needed — the harness bundles the AWS SDK). You pick a profile by
friendly name; the stored value is the system profile ID or
application profile ARN, passed to Claude Code as `--model`
unchanged. The first-party aliases (`haiku`, `sonnet`, `opus`,
`fable`) are not offered in Bedrock mode.

- Discovery needs `bedrock:ListInferenceProfiles`. If listing fails,
  Claude Code stays Ready with a warning, but Save is blocked until a
  profile is discovered after Recheck.
- Listing a profile does not prove `bedrock:InvokeModel` access;
  invocation failures surface at turn time as ordinary step failures.
- A model saved in one provider mode (Bedrock or first-party) is kept
  when running in the other: it shows as unavailable until you pick a
  current one, and is never rewritten or translated.

## Related

- [Claude Code on Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock) (Anthropic)
- Claude Code Agent Backend decision: [ADR 0047](adr/0047-claude-code-agent-backend.md)
