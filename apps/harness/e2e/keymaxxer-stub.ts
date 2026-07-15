const capability = "e2e-test-capability"
const port = 59999

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    if (request.headers.get("origin")) {
      return new Response("browser requests are forbidden", { status: 403 })
    }
    const path = new URL(request.url).pathname
    if (path === `/${capability}/mcp`) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "e2e stub does not serve MCP tools" },
          id: null,
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )
    }
    return new Response("not found", { status: 404 })
  },
})

console.log(
  `KEYMAXXER_SIDECAR_URL=http://127.0.0.1:${server.port}/${capability}/mcp`,
)
console.log(`Keymaxxer e2e stub listening on 127.0.0.1:${server.port}`)
