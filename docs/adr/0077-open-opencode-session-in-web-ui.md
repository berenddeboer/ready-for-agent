# Open an OpenCode Session in the web UI

OpenCode Sessions are opened in the installed OpenCode 2 web UI instead of the Agent Turn Tail viewer. The harness already captures the Session ID. The link is `<server-base>/server/<base64url(server-base)>/session/<encoded-session-id>`, matching the V2 route `/server/:serverKey/session/:id`. Trailing slashes are stripped before the server key is encoded as URL-safe base64 without padding. The link contains no credentials and no one-time pairing token; the browser uses its existing OpenCode cookie. A browser that has not paired authenticates with OpenCode normally.

The server address is resolved on the backend, never by a command from the browser, and is not hardcoded. An explicit server configured for the agent wins. Otherwise the address is whatever `opencode service status` prints for the shared local service. That address is used as-is, including localhost when the browser and service share a machine or an SSH port forward. The harness origin is not substituted for the OpenCode origin. Resolution does not start the service.

Session usage stays available from the existing Session control. Other Agent Backends keep Agent Turn Tail. OpenCode without a Session ID or a resolvable server address falls back to that tail when the backend can serve one. The link is offered for running and completed Sessions while OpenCode still has them.
