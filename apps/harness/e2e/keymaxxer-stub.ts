const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 59999,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/health") {
      return Response.json({ status: "ok", protocolVersion: 3 })
    }
    if (path === "/initialize") {
      return Response.json({ initialized: true })
    }
    return new Response("Not found", { status: 404 })
  },
})

console.log(`Keymaxxer test stub listening on ${server.url}`)
