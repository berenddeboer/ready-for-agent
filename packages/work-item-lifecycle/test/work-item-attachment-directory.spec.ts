import { tmpdir } from "node:os"
import { workItemAttachmentDirectory } from "../src/lib/work-item-attachment-directory.js"
import { describe, expect, it } from "bun:test"

describe("workItemAttachmentDirectory", () => {
  it("places attachments under the temporary ready-for-agent tree, namespaced by Work Item id", () => {
    expect(
      workItemAttachmentDirectory({
        workItemId: "wi-01HZZZZZZZZZZZZZZZZZZZZZZZ",
        tmpDir: "/var/tmp",
      }),
    ).toBe(
      "/var/tmp/ready-for-agent/pr-attachments/wi-01HZZZZZZZZZZZZZZZZZZZZZZZ",
    )
  })

  it("defaults to os.tmpdir() when tmpDir is omitted", () => {
    const temporaryDirectory = tmpdir().replace(/[/\\]+$/, "")

    expect(
      workItemAttachmentDirectory({
        workItemId: "wi-01HABCDEFGHJKMNPQRSTVWXYZ",
      }),
    ).toBe(
      `${temporaryDirectory}/ready-for-agent/pr-attachments/wi-01HABCDEFGHJKMNPQRSTVWXYZ`,
    )
  })

  it("strips a trailing slash from the temp root override", () => {
    expect(
      workItemAttachmentDirectory({
        workItemId: "wi-01HABCDEFGHJKMNPQRSTVWXYZ",
        tmpDir: "/tmp/",
      }),
    ).toBe("/tmp/ready-for-agent/pr-attachments/wi-01HABCDEFGHJKMNPQRSTVWXYZ")
  })
})
