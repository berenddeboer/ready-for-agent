# Keymaxxer Sidecar

Development-only loopback process that preserves the Keymaxxer MCP session
across TanStack application-server reloads. It is started automatically by
`harness:dev`; production runs Keymaxxer in the harness process instead.
