# Shared Keymaxxer Sidecar broker

Ready for Agent uses a shared backend Keymaxxer Service that never exposes raw secret values. A long-lived **Keymaxxer Sidecar** owns one stdio `keymaxxer serve` keyholder and exposes the four Keymaxxer MCP tools over **Streamable HTTP** on loopback so Harness and every OpenCode process share one vault session and one Allow-session set.

## Topology

- Development and production use the same sidecar process model (not in-process Keymaxxer in the Harness).
- `scripts/run-with-keymaxxer-sidecar.ts` starts the sidecar, captures the stdout bootstrap line `KEYMAXXER_SIDECAR_URL=http://127.0.0.1:<port>/<capability>/mcp`, and runs Harness with that URL in memory only.
- There is no unauthenticated `/health` route. Readiness is TCP listen; auth is the unguessable path capability (#113).

## Security

- Bind `127.0.0.1` only. MCP lives only at `/<capability>/mcp`.
- Requests with an `Origin` header receive **403**. Wrong or missing capability path receives **404**.
- Capability is 32-byte CSPRNG base64url, generated once per sidecar listen. Logs may show host:port only after bootstrap.
- OpenCode receives the capability URL only via forced `OPENCODE_CONFIG_CONTENT` remote MCP config — no Bearer header, no capability files, no ambient `GH_TOKEN` / `GITHUB_TOKEN` in the OpenCode child.

## Credentials

Keymaxxer remains responsible for injecting named secrets into **non-OpenCode** child commands (`keymaxxer_run`). OpenCode is always parented by the Harness and uses Keymaxxer tools through the remote MCP broker for secret-bearing work. Create PR / investigate PR status checks / decide PR merge pre-flight the repository secret **name** and put that name in the prompt; they never inject token values into OpenCode's environment.

The GraphQL credential query and mutation use Keymaxxer metadata only; they never receive a raw secret value. New secrets use a `GITHUB_TOKEN_<OWNER>_<REPOSITORY>` suggestion. If that name is already occupied but its metadata does not match the Repository, setup fails instead of guessing.

## Keyholder

The MCP launcher preserves the known-good development precedence: `KEYMAXXER_ENTRYPOINT`, then `/home/berend/src/contrib/keymaxxer/packages/cli/src/index.ts` when present, then the installed `keymaxxer` command. The Keymaxxer child inherits the backend environment except repository-scoped `GITHUB_TOKEN_<OWNER>_<REPO>` values.

## Startup

Keymaxxer Sidecar TCP readiness gates application-server startup. An unreachable or failed configured sidecar stops the application server and never falls back to an in-process client. Initial connection refusal retries for at most five seconds to tolerate process-start ordering; protocol failures after the sidecar responds fail immediately.
