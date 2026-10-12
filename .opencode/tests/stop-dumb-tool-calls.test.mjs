import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../plugin/stop-dumb-tool-calls.js"

test("loads as a V2 plugin and registers the execution guard", async () => {
  assert.equal(plugin.id, "stop-dumb-tool-calls")
  let hook
  await plugin.setup({
    tool: {
      async hook(name, callback) {
        assert.equal(name, "execute.before")
        hook = callback
      },
    },
  })
  assert.equal(typeof hook, "function")

  for (const tool of ["bash", "shell"]) {
    for (const command of [
      "bunx nx affected --skipNxCache",
      "bunx nx affected --skip-nx-cache",
      "bunx nx run-many -t test",
      "NX_DAEMON=false bunx nx affected",
      "git commit --amend",
      "git rebase -i HEAD~2",
      "git commit --fixup HEAD",
      "git commit --squash HEAD",
      "git commit --no-verify",
      "git commit -n",
    ]) {
      for (const input of [command, { command }, { args: { command } }]) {
        assert.throws(() => hook({ tool, input }), (error) => {
          assert.equal(error._tag, "Tool.Error")
          assert.match(error.message, /^BLOCKED:/)
          return true
        })
      }
    }
    assert.doesNotThrow(() => hook({ tool, input: { command: "bunx nx affected -t test" } }))
    assert.doesNotThrow(() => hook({ tool, input: {} }))
    assert.doesNotThrow(() => hook({ tool, input: { command: 123 } }))
    assert.doesNotThrow(() => hook({ tool, input: { args: { command: 123 } } }))
  }
  assert.doesNotThrow(() => hook({ tool: "read", input: { command: "git commit --amend" } }))
})
