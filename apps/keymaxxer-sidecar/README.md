# Keymaxxer Sidecar

Loopback Streamable HTTP MCP facade over one `keymaxxer serve` keyholder. Harness
and every OpenCode process connect with the capability URL printed once on stdout:

```text
KEYMAXXER_SIDECAR_URL=http://127.0.0.1:<port>/<capability>/mcp
```

`harness:dev` captures that line via `scripts/run-with-keymaxxer-sidecar.ts`.
Production `harness:start` captures it inside the production lifecycle.
