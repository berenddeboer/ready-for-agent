# Keymaxxer Sidecar

Loopback Streamable HTTP MCP facade over one `keymaxxer serve` keyholder. Harness
and every OpenCode process connect with the capability URL printed once on stdout:

```text
KEYMAXXER_SIDECAR_URL=http://127.0.0.1:<port>/<capability>/mcp
```

`harness:dev` / `harness:start` capture that line via
`scripts/run-with-keymaxxer-sidecar.ts`.
