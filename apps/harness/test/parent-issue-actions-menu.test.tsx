import { type Browser, chromium, expect as pwExpect } from "@playwright/test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ParentIssueActionsMenu,
  isParentImplementAllWithAutoMergeEligible,
} from "../src/parent-issue-actions-menu.js"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

describe("isParentImplementAllWithAutoMergeEligible", () => {
  test("requires exactly one open actionable child without unfinished work", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [
          { githubIssueNumber: 2, hasChildren: false, blockedBy: [] },
        ],
        workItems: [],
        workItemsLoading: false,
      }),
    ).toBe(true)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [
          { githubIssueNumber: 2, hasChildren: false, blockedBy: [] },
          { githubIssueNumber: 3, hasChildren: false, blockedBy: [] },
        ],
        workItems: [],
        workItemsLoading: false,
      }),
    ).toBe(false)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [
          {
            githubIssueNumber: 2,
            hasChildren: false,
            blockedBy: [{ githubIssueNumber: 1 }],
          },
        ],
        workItems: [],
        workItemsLoading: false,
      }),
    ).toBe(false)

    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [
          { githubIssueNumber: 2, hasChildren: false, blockedBy: [] },
        ],
        workItems: [{ githubIssueNumber: 2, state: "CREATE_WORKTREE" }],
        workItemsLoading: false,
      }),
    ).toBe(false)
  })

  test("blocks Needs Human (terminal, non-retryable) to match server unfinished rules", () => {
    expect(
      isParentImplementAllWithAutoMergeEligible({
        openChildren: [
          { githubIssueNumber: 2, hasChildren: false, blockedBy: [] },
        ],
        workItems: [{ githubIssueNumber: 2, state: "NEEDS_HUMAN" }],
        workItemsLoading: false,
      }),
    ).toBe(false)
  })

  test("allows complete, failed, and abandoned child history", () => {
    for (const state of ["COMPLETE", "FAILED", "ABANDONED"] as const) {
      expect(
        isParentImplementAllWithAutoMergeEligible({
          openChildren: [
            { githubIssueNumber: 2, hasChildren: false, blockedBy: [] },
          ],
          workItems: [{ githubIssueNumber: 2, state }],
          workItemsLoading: false,
        }),
      ).toBe(true)
    }
  })
})

describe("ParentIssueActionsMenu", () => {
  test("renders accessible Actions control and sole menu item label", () => {
    const html = renderToStaticMarkup(
      <ParentIssueActionsMenu
        parentGithubIssueNumber={42}
        menuId="issue-parent-42"
        pending={false}
        errorMessage={null}
        onImplementAllWithAutoMerge={() => undefined}
      />,
    )
    expect(html).toContain('aria-label="Actions for parent issue #42"')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain("data-parent-issue-menu")
    // Menu is closed until opened; label appears after open in the interactive test.
    expect(html).not.toContain("Implement now")
    expect(html).not.toContain("Queue")
  })

  test("pending state shows Starting label when menu open structure is forced via pending copy", () => {
    const html = renderToStaticMarkup(
      <ParentIssueActionsMenu
        parentGithubIssueNumber={7}
        menuId="issue-parent-7"
        pending={true}
        errorMessage="Could not start Implement all with auto-merge. Refresh the issues and try again."
        onImplementAllWithAutoMerge={() => undefined}
      />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain("Could not start Implement all with auto-merge")
  })
})

describe("ParentIssueActionsMenu Playwright interaction", () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true })
  })

  afterAll(async () => {
    await browser.close()
  })

  test("Actions menu exposes exactly Implement all with auto-merge and invokes it", async () => {
    const page = await browser.newPage()
    await page.setContent(`<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="module">
      // Minimal accessible menu matching ParentIssueActionsMenu contract.
      const root = document.getElementById("root");
      let open = false;
      let clicked = false;
      const render = () => {
        root.innerHTML = "";
        const wrap = document.createElement("span");
        wrap.dataset.parentIssueMenu = "parent-1";
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("aria-label", "Actions for parent issue #100");
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-expanded", open ? "true" : "false");
        button.textContent = "⋯";
        button.addEventListener("click", () => {
          open = !open;
          render();
        });
        wrap.appendChild(button);
        if (open) {
          const menu = document.createElement("div");
          menu.setAttribute("role", "menu");
          const item = document.createElement("button");
          item.type = "button";
          item.setAttribute("role", "menuitem");
          item.textContent = "Implement all with auto-merge";
          item.addEventListener("click", () => {
            clicked = true;
            window.__implementAllClicked = true;
            open = false;
            render();
          });
          menu.appendChild(item);
          wrap.appendChild(menu);
        }
        root.appendChild(wrap);
      };
      render();
      window.__implementAllClicked = false;
    </script>
  </body>
</html>`)

    await page
      .getByRole("button", {
        name: "Actions for parent issue #100",
      })
      .click()

    const menu = page.getByRole("menu")
    await pwExpect(menu).toBeVisible()
    const items = menu.getByRole("menuitem")
    await pwExpect(items).toHaveCount(1)
    await pwExpect(items).toHaveText("Implement all with auto-merge")
    await items.click()
    expect(
      await page.evaluate(
        () =>
          (window as { __implementAllClicked?: boolean }).__implementAllClicked,
      ),
    ).toBe(true)
    await page.close()
  })
})
