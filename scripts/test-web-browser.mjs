import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

const exec = promisify(execFile);
const bin = path.resolve(import.meta.dirname, "../packages/cli/dist/bin.js");
const temp = await mkdtemp(path.join(os.tmpdir(), "aiongside-web-browser-"));
const root = path.join(temp, "workspace");
const env = { ...process.env, XDG_CACHE_HOME: path.join(temp, "cache") };
const cli = (args) =>
  exec(process.execPath, [bin, "--root", root, "view", "web", ...args], {
    env,
    timeout: 15_000,
  });
const put = async (file, source) => {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, source);
};
async function snapshot() {
  const files = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, item.name);
      if (item.isDirectory()) await walk(target);
      else
        files.push(
          `${target}:${createHash("sha256")
            .update(await readFile(target))
            .digest("hex")}`,
        );
    }
  }
  await walk(root);
  return files.sort().join("\n");
}
const record = (id, title, status, extra = "") =>
  `---\nschema: 1\nid: ${id}\ntitle: ${title}\nstatus: ${status}\ntype: delivery\ncreated: 2026-09-01\nupdated: 2026-09-0${id.split("-")[1]}\n${extra}---\n\n# Record\n\nPreserved work notes.\n`;

let browser;
try {
  await put(
    ".aiongside/config.yaml",
    "schema: 1\nname: September workshop\nidPrefix: WORK\n",
  );
  const titles = [
    "Workshop preparation",
    "Confirm venue capacity",
    "Participant invitation",
    "Catering requirements",
    "Photography cancellation",
    "Review online event checklist",
  ];
  const statuses = ["active", "done", "done", "waiting", "cancelled", "inbox"];
  for (const [index, title] of titles.entries()) {
    const id = `WORK-${index + 1}`;
    const extra =
      id === "WORK-1"
        ? "needs:\n  - WORK-2\nknowledge:\n  - venue-rules\n  - missing-topic\ntransitions:\n  - at: 2026-09-02T10:12:00.000Z\n    from: inbox\n    to: active\n  - at: 2026-09-04T15:30:00.000Z\n    from: active\n    to: waiting\n    waitingReason: Venue capacity pending\n    resumeWhen: Venue replies\n  - at: 2026-09-07T09:05:00.000Z\n    from: waiting\n    to: active\n    waitingResolution: Venue confirmed\n"
        : id === "WORK-6"
          ? "needs:\n  - WORK-1\n"
          : "";
    await put(
      `work/${id}/record.md`,
      record(id, title, statuses[index], extra),
    );
    await put(
      `work/${id}/overview.md`,
      `# ${title}\n\nPrepare the September workshop for **12 participants**.\n\n## Current outcome\n\n- Venue: C room\n- Date: September 10, 2 PM\n- Keep the final invitation in deliverables.\n\n[Invitation draft](deliverables/invitation.md)\n\n## Next steps\n\nConfirm attendance and review the participant checklist.\n`,
    );
    await put(
      `work/${id}/deliverables/invitation.md`,
      "# Invitation\n\nWelcome to the September workshop.\n\n| Item | Value |\n| --- | --- |\n| Venue | C room |\n| Participants | 12 |\n\n[Related work](../../WORK-2/overview.md)\n\n[Venue rules](../../../knowledge/venue-rules.md)\n\n[Legacy note](../../../.legacy/secret.md)\n\n[Script link](javascript:alert(1))\n\n<script>window.injected = true</script>\n\n![tracking](https://invalid.example/pixel)\n\n- [x] Sent\n- [ ] Confirmed\n",
    );
  }
  await put(
    "work/WORK-7/record.md",
    record("WORK-7", "Record only follow-up", "inbox"),
  );
  await put("work/WORK-8/record.md", "broken");
  await put(".gitignore", "node_modules/\n");
  await put("work/WORK-1/node_modules/README.md", "# Hidden dependency\n");
  await put(
    "knowledge/index.md",
    "# Knowledge index\n\n- [Venue rules](venue-rules.md)\n- [Events](events/index.md)\n",
  );
  await put(
    "knowledge/venue-rules.md",
    "---\naiongside:\n  schema: 1\n  key: venue-rules\n  title: Venue rules\n---\n\n# Venue rules\n\nNo open flames in room C.\n\n[Rooms](events/rooms.md)\n",
  );
  await put("knowledge/events/index.md", "# Events\n\n- [Rooms](rooms.md)\n");
  await put(
    "knowledge/events/rooms.md",
    "---\naiongside:\n  schema: 1\n  key: rooms\n  title: Rooms\n---\n\n# Rooms\n\nRoom C seats 12.\n",
  );
  const before = await snapshot();
  const { stdout } = await cli([
    "--background",
    "--host",
    process.env.AIONGSIDE_WEB_TEST_HOST ?? "localhost",
  ]);
  const url = /http:\/\/[^\s]+/.exec(stdout)?.[0];
  assert.ok(url);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
  });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  const rows = page.locator('[data-testid="work-row"]');
  const heading = (text) =>
    page.waitForFunction(
      (expected) =>
        document.querySelector('[data-testid="document"] h1')?.textContent ===
        expected,
      text,
    );

  // 1. List: rows, issues, no document reads.
  await page.goto(url);
  await page.waitForURL(/\/work$/);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="work-row"]').length === 7,
  );
  assert.equal(
    requests.some((request) => request.includes("/api/document")),
    false,
  );
  assert.ok(
    (await page.locator('[data-testid="issues"]').innerText()).includes(
      "work/WORK-8/record.md",
    ),
  );
  assert.ok((await rows.first().innerText()).includes("WORK-1"));

  // 2. Search, tabs, sort.
  await page.getByTestId("search").fill("invitation");
  assert.equal(await rows.count(), 1);
  await page.getByTestId("tab-waiting").click();
  await page.getByTestId("empty").waitFor();
  await page.getByTestId("search").fill("");
  assert.equal(await rows.count(), 1);
  await page.getByTestId("tab-all").click();
  assert.equal(await rows.count(), 7);
  await page.getByTestId("sort-menu").click();
  await page.getByTestId("sort-updated").click();
  assert.ok((await rows.first().innerText()).includes("WORK-7"));
  await page.getByTestId("sort-menu").click();
  await page.getByTestId("sort-status").click();
  assert.ok((await rows.first().innerText()).includes("WORK-1"));

  // 3. Board keeps search and survives reload.
  await page.getByTestId("search").fill("venue");
  await page.getByTestId("view-board").click();
  await page.getByTestId("board").waitFor();
  assert.equal(await page.locator('[data-testid="work-card"]').count(), 1);
  assert.equal(await page.getByTestId("tab-all").count(), 0);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="work-card"]').length === 7,
  );
  assert.equal(
    await page
      .locator('[data-testid="column-done"] [data-testid="work-card"]')
      .count(),
    2,
  );
  await page.getByTestId("view-list").click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="work-row"]').length === 7,
  );

  // 4. Detail: relations, knowledge links, tree with ignored toggle.
  await page.locator('[data-testid="work-row"][data-work-id="WORK-1"]').click();
  await page.waitForURL(/\/work\/WORK-1$/);
  await heading("Workshop preparation");
  assert.ok((await page.getByTestId("needs").innerText()).includes("WORK-2"));
  assert.ok(
    (await page.getByTestId("needed-by").innerText()).includes("WORK-6"),
  );
  const linked = await page.getByTestId("linked-knowledge").innerText();
  assert.ok(linked.includes("Venue rules") && linked.includes("missing-topic"));
  // History tab lists transitions newest first with reasons; detail tab restores the tree.
  assert.ok((await page.getByTestId("tab-history").innerText()).includes("3"));
  await page.getByTestId("tab-history").click();
  const history = page.getByTestId("history-table");
  await history.waitFor();
  const historyRows = history.locator("tbody tr");
  assert.equal(await historyRows.count(), 3);
  assert.ok((await historyRows.nth(0).innerText()).includes("Venue confirmed"));
  assert.ok(
    (await historyRows.nth(1).innerText()).includes("Venue capacity pending"),
  );
  assert.ok((await historyRows.nth(1).innerText()).includes("Venue replies"));
  assert.equal(await page.getByTestId("file-tree").count(), 0);
  await page.getByTestId("tab-detail").click();
  const tree = page.getByTestId("file-tree");
  await tree.waitFor();
  assert.equal(
    await tree.getByText("node_modules", { exact: true }).count(),
    0,
  );
  assert.ok((await tree.innerText()).includes("1 ignored"));
  await page.getByTestId("toggle-ignored").click();
  await tree.getByText("node_modules", { exact: true }).waitFor();
  await tree.locator('[data-tree-path="work/WORK-1/node_modules"]').click();
  await tree.getByText("README.md", { exact: true }).click();
  await heading("Hidden dependency");
  assert.ok(
    (await page.getByTestId("document-path").innerText()).includes(
      "node_modules",
    ),
  );
  await page.getByTestId("toggle-ignored").click();
  assert.equal(
    await tree.getByText("node_modules", { exact: true }).count(),
    0,
  );

  // 5. Keyboard: Right expands, Down moves, Enter opens; then Markdown policy.
  await tree.locator('[data-tree-path="work/WORK-1/deliverables"]').focus();
  await page.keyboard.press("ArrowRight");
  await tree.getByText("invitation.md", { exact: true }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await heading("Invitation");
  assert.equal(await tree.getByRole("treeitem", { selected: true }).count(), 1);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '[data-tree-path="work/WORK-1/deliverables/invitation.md"]',
      ),
  );
  await tree.locator('[data-tree-path="work/WORK-1/deliverables"]').click();
  await tree.getByText("invitation.md", { exact: true }).click();
  await heading("Invitation");
  const document = page.getByTestId("document");
  assert.equal(await document.locator("table").count(), 1);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(
    requests.some((request) => request.includes("invalid.example")),
    false,
  );
  assert.equal(await document.locator("span.unsupported").count(), 2);
  assert.equal(await document.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await document.locator('input[type="checkbox"]').count(), 2);
  await document.getByRole("link", { name: "Related work" }).click();
  await page.waitForURL(/\/work\/WORK-2$/);
  await heading("Confirm venue capacity");
  await page.goBack();
  await heading("Invitation");
  await document.getByRole("link", { name: "Venue rules" }).click();
  await page.waitForURL(/\/knowledge\/venue-rules\.md$/);
  await heading("Venue rules");
  assert.ok(
    (await page.getByTestId("knowledge-key").innerText()).includes(
      "venue-rules",
    ),
  );
  assert.ok(
    (await page.getByTestId("linked-work").innerText()).includes("WORK-1"),
  );
  await document.getByRole("link", { name: "Rooms" }).click();
  await page.waitForURL(/\/knowledge\/events\/rooms\.md$/);
  await heading("Rooms");

  // 6. Knowledge tree: folders navigate to their index.
  await page.goto(`${url}/knowledge`);
  await heading("Knowledge index");
  const ktree = page.getByTestId("knowledge-tree");
  await page
    .getByTestId("document")
    .getByRole("link", { name: "Events" })
    .click();
  await page.waitForURL(/\/knowledge\/events$/);
  await heading("Events");
  await page.goto(`${url}/knowledge/events/index.md`);
  await heading("Events");
  await page.goto(`${url}/knowledge`);
  await heading("Knowledge index");
  await ktree.getByRole("link", { name: "events" }).click();
  await page.waitForURL(/\/knowledge\/events$/);
  await heading("Events");
  // Visiting rooms.md earlier revealed its folder; the chevron collapses then expands.
  await ktree.getByText("Rooms", { exact: true }).waitFor();
  await ktree.getByRole("button", { name: "events" }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '[data-testid="knowledge-tree"] [data-tree-path="knowledge/events/rooms.md"]',
      ),
  );
  await ktree.getByRole("button", { name: "events" }).click();
  await ktree.getByText("Rooms", { exact: true }).waitFor();
  await page.getByTestId("knowledge-search").fill("venue");
  assert.equal(await ktree.getByText("Rooms", { exact: true }).count(), 0);
  await ktree.getByText("Venue rules", { exact: true }).click();
  await heading("Venue rules");
  await page.getByTestId("linked-work").getByText("WORK-1").click();
  await page.waitForURL(/\/work\/WORK-1$/);
  await heading("Workshop preparation");

  // 7. Language and theme persist; content stays untranslated.
  await page.getByTestId("lang-ko").click();
  await page
    .getByLabel("Main")
    .getByRole("link", { name: "\uc5c5\ubb34" })
    .waitFor();
  assert.ok(
    (await page.getByTestId("detail-heading").innerText()).includes(
      "\uc9c4\ud589 \uc911",
    ),
  );
  assert.ok(
    (await page.getByTestId("detail-heading").innerText()).includes(
      "Workshop preparation",
    ),
  );
  assert.equal(await page.locator("html").getAttribute("lang"), "ko");
  await page.getByTestId("toggle-theme").click();
  await page.reload();
  await page
    .getByLabel("Main")
    .getByRole("link", { name: "\uc5c5\ubb34" })
    .waitFor();
  assert.ok(
    await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    ),
  );
  await page.getByTestId("toggle-theme").click();
  await page.getByTestId("lang-en").click();
  await page
    .getByLabel("Main")
    .getByRole("link", { name: "Work", exact: true })
    .waitFor();

  // 8. Missing Overview, direct URLs.
  await page.goto(`${url}/work/WORK-7`);
  await page.getByTestId("no-overview").waitFor();
  await page.getByRole("link", { name: "Open Record" }).click();
  await heading("Record");
  assert.equal(await snapshot(), before);
  await page.goto(`${url}/work/WORK-1/file/deliverables/invitation.md`);
  await heading("Invitation");
  await page.goto(`${url}/work/WORK-99`);
  await page.getByTestId("detail-error").waitFor();

  // 9. Live: open document keeps its body until Reload; tree marks changes.
  await page.goto(`${url}/work/WORK-2`);
  await heading("Confirm venue capacity");
  await page.getByTestId("live").waitFor();
  await put("work/WORK-2/overview.md", "# Updated elsewhere\n");
  await page.getByTestId("document-changed").waitFor();
  await heading("Confirm venue capacity");
  await page.getByTestId("document-reload").click();
  await heading("Updated elsewhere");
  assert.equal(await page.getByTestId("document-changed").count(), 0);
  await put("work/WORK-2/plan.md", "# Plan\n\nDrafted elsewhere.\n");
  const planRow = page
    .getByTestId("file-tree")
    .locator('[data-tree-path="work/WORK-2/plan.md"]');
  await planRow.waitFor();
  await planRow.locator('[data-testid="changed-mark"]').waitFor();
  await planRow.click();
  await heading("Plan");
  assert.equal(
    await planRow.locator('[data-testid="changed-mark"]').count(),
    0,
  );

  // 10. Live: other Work transitions toast; the current Work updates in place.
  await put(
    "work/WORK-3/record.md",
    record("WORK-3", "Participant invitation", "active"),
  );
  const toast = page.getByTestId("toast");
  await toast.waitFor();
  assert.ok((await toast.innerText()).includes("WORK-3"));
  assert.ok((await toast.innerText()).includes("Active"));
  await toast.click();
  await page.waitForURL(/\/work\/WORK-3$/);
  await heading("Participant invitation");
  await put(
    "work/WORK-3/record.md",
    record("WORK-3", "Participant invitation", "waiting"),
  );
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="detail-heading"]')
      ?.textContent?.includes("Waiting"),
  );
  await page.waitForTimeout(700);
  assert.equal(await page.getByTestId("toast").count(), 0);

  // 11. Live: list updates in place; Pause queues, Resume applies.
  await page.goto(`${url}/work`);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="work-row"]').length === 7,
  );
  await put("work/WORK-9/record.md", record("WORK-9", "Arrived live", "inbox"));
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="work-row"]').length === 8,
  );
  await page.getByTestId("live").click();
  const recent = page.getByTestId("recent-changes");
  await recent.waitFor();
  assert.ok((await recent.innerText()).includes("WORK-9"));
  await page.getByTestId("live-pause").click();
  await page.keyboard.press("Escape");
  // A previously broken Record becomes valid while paused.
  await put(
    "work/WORK-8/record.md",
    record("WORK-8", "Queued while paused", "inbox"),
  );
  await page.waitForTimeout(800);
  assert.equal(await rows.count(), 8);
  assert.ok((await page.getByTestId("live").innerText()).includes("Paused"));
  await page.getByTestId("live").click();
  await page.getByTestId("live-pause").click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="work-row"]').length === 9,
  );

  // 12. Larger lists stay usable.
  for (let index = 9; index <= 88; index++) {
    await put(
      `work/WORK-${index}/record.md`,
      `---\nschema: 1\nid: WORK-${index}\ntitle: Backlog ${index}\nstatus: inbox\ntype: delivery\ncreated: 2026-09-08\nupdated: 2026-09-08\n---\n\nNotes.\n`,
    );
  }
  await page.goto(`${url}/work`);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="work-row"]').length === 88,
  );
  await page
    .locator('[data-testid="work-row"][data-work-id="WORK-88"]')
    .scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  if (process.env.AIONGSIDE_WEB_SCREENSHOT)
    await page.screenshot({
      path: process.env.AIONGSIDE_WEB_SCREENSHOT,
      fullPage: true,
    });
  assert.deepEqual(errors, []);
  console.log(
    "Web browser passed: list/search/tabs/sort, board, detail relations, tree + ignored toggle, Markdown policy, Knowledge, language/theme persistence, direct URLs, live updates (reload, tree marks, toasts, pause), unchanged workspace.",
  );
} finally {
  await browser?.close();
  await cli(["stop"]).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
