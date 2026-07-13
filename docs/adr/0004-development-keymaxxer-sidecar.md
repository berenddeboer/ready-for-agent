# Development Keymaxxer Sidecar

Ready for Agent uses a shared backend Keymaxxer Service that never exposes raw secret values. During `api:serve`, a workspace-local sidecar owns the long-lived Keymaxxer MCP session so API reloads do not repeat vault-unlock or secret-use approval prompts; production creates the MCP client in-process and does not run a sidecar.

The sidecar is a development tool attached specifically to `api:serve` and is restricted to loopback communication. Remote sidecar URLs and remote authentication are deliberately unsupported because the service can execute commands with injected secrets and there is no remote-use requirement.

Because loopback alone does not prevent requests from malicious webpages, operation endpoints reject requests with an `Origin` header and require `application/json`. This causes browser JSON requests to require a CORS preflight, which the sidecar does not permit.

Development uses fixed loopback port `5032`, overridable with `KEYMAXXER_SIDECAR_PORT`; `api:serve` selects it through `KEYMAXXER_SIDECAR_URL`. A port conflict fails fast and names the override instead of choosing a dynamic port that Nx cannot communicate to the API process.

The MCP launcher preserves the known-good development precedence: `KEYMAXXER_ENTRYPOINT`, then `/home/berend/src/contrib/keymaxxer/packages/cli/src/index.ts` when present, then the installed `keymaxxer` command. The machine-specific fallback is deliberate while Ready for Agent depends on unreleased local Keymaxxer features.

The Keymaxxer child inherits the backend environment except repository-scoped `GITHUB_TOKEN_<OWNER>_<REPO>` values. Those tokens must not cross into the credential broker process.

Keymaxxer initialization gates API startup in development and production. The sidecar listens before lazily and idempotently initializing its MCP session on request; an unreachable or failed configured sidecar stops the API and never falls back to an in-process client, because fallback would silently restore repeated approval prompts.

The API retries initial sidecar connection refusal for at most five seconds to tolerate Nx process-start ordering. Once the sidecar responds, initialization or protocol failures fail immediately rather than being hidden by retries.
