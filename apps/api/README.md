# API

The GraphQL API requires Keymaxxer to initialize before it starts listening.

## Development

`bunx nx run api:serve` starts a continuous Keymaxxer Sidecar on
`http://127.0.0.1:5032` and the watched API connects to it. The sidecar owns the
MCP session across API reloads, avoiding repeated vault unlock and secret-use
approval prompts.

Set `KEYMAXXER_SIDECAR_PORT` to use a different loopback port. The serve target
derives `KEYMAXXER_SIDECAR_URL` from that port; an explicit URL must be an
origin of the form `http://127.0.0.1:<port>`. A port conflict fails immediately
and names the port override.

## Production

`bunx nx run api:start` does not run or select the sidecar. The API owns an
in-process Keymaxxer MCP client and closes it during graceful shutdown.
`NODE_ENV` does not select either topology.

Set `KEYMAXXER_ENTRYPOINT` to run an explicit Keymaxxer TypeScript entrypoint.
Without it, the MCP launcher prefers the local unreleased Keymaxxer source path
documented in the root README and then falls back to `keymaxxer serve`.
