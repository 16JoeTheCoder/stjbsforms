import { expect, test } from "@playwright/test";

// On localhost in development the Worker accepts x-dev-user as the identity.
const as = (email: string) => ({ extraHTTPHeaders: { "x-dev-user": email } });

test.describe("admin", () => {
  test.use(as("owner@example.com"));
  test("overview, notes board, moderation and distribution", async ({ page, request }, info) => {
    test.skip(info.project.name === "mobile", "admin dashboard flows are exercised at desktop width");
    // make sure there is at least one submission
    const form = await (await request.get("/api/public/form")).json();
    const t = form.teachers.map((x: { id: string }) => x.id);
    await request.post("/api/public/submissions", {
      headers: { origin: "http://localhost:8788", cookie: `stjb_bid=e2eadminbrowser${Date.now()}` },
      data: {
        idempotencyKey: `e2e_admin_${Date.now()}`,
        classCode: "W5NB6",
        votes: form.awards.map((a: { id: string }, i: number) => ({ awardId: a.id, teacherId: t[i] })),
        notes: [0, 1, 2].map((i) => ({ teacherId: t[20 + i], body: `Staff test note ${i}: thank you for the encouragement and the endless patience during exam season this year.` })),
      },
    });

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await page.getByRole("link", { name: "Notes", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
    await page.locator("article").first().getByRole("button").first().click();
    await expect(page.getByRole("dialog", { name: "Note" })).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "Note" });
    await dialog.getByRole("button", { name: "Approve" }).click();
    await expect(dialog.getByText("Approved", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("link", { name: "Review workload" }).click();
    await page.getByRole("button", { name: "Select all active" }).click();
    await page.getByRole("button", { name: "Distribute evenly" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(/notes assigned/)).toBeVisible();

    await page.getByRole("link", { name: "Awards" }).click();
    await expect(page.getByText(/votes/).first()).toBeVisible();
    await page.getByRole("link", { name: "Classes" }).click();
    await page.getByRole("button", { name: "Show code for Secondary 1A" }).click();
    await expect(page.getByText("K7M4P")).toBeVisible();
  });
});

test.describe("reviewer", () => {
  test.use(as("reviewer1@example.com"));
  test("reviewer queue: keyboard approve; admin pages are forbidden", async ({ page, request }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/review$/);
    const progress = await (await request.get("/api/review/progress")).json();
    test.skip(progress.pending === 0, "nothing assigned to reviewer1");
    await expect(page.locator("article").first()).toBeVisible();
    await page.locator("article").first().focus();
    await page.keyboard.press("a");
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
    const res = await request.get("/api/admin/overview");
    expect(res.status()).toBe(403);
  });
});

test.describe("AI review", () => {
  test.use(as("owner@example.com"));
  test("export prompt, paste AI reply, preview, apply", async ({ page, request }, info) => {
    test.skip(info.project.name === "mobile", "admin flow exercised at desktop width");
    const form = await (await request.get("/api/public/form")).json();
    const t = form.teachers.map((x: { id: string }) => x.id);
    const res = await request.post("/api/public/submissions", {
      headers: { origin: new URL(info.project.use.baseURL!).origin, cookie: `stjb_bid=e2eaibrowser${Date.now()}x` },
      data: {
        idempotencyKey: `e2e_ai_${Date.now()}_abcdef`,
        classCode: "D4JC7",
        votes: form.awards.map((a: { id: string }, i: number) => ({ awardId: a.id, teacherId: t[(i + 5) % t.length] })),
        notes: [0, 1, 2].map((i) => ({ teacherId: t[25 + i], body: `AI review e2e note ${i}: thank you for your patience and the extra help after class every single week this year.` })),
      },
    });
    expect(res.ok()).toBeTruthy();

    await page.goto("/admin/ai-review");
    await expect(page.getByRole("heading", { name: "AI review" })).toBeVisible();
    await page.getByRole("button", { name: "Create export" }).click();
    await expect(page.getByText(/pending notes in/)).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download prompt/ }).click();
    const file = await (await download).path();
    const md = (await import("node:fs")).readFileSync(file!, "utf8");
    expect(md).toContain('"format": "stjb-ai-review-v1"');

    // Act as the AI: approve everything in the exported data block.
    const data = JSON.parse(md.split("## Data")[1]!.split("```json")[1]!.split("```")[0]!);
    const reply = { format: "stjb-ai-review-v1", exportId: data.exportId, decisions: data.notes.map((n: { id: string }) => ({ id: n.id, decision: "approve", reason: "" })) };
    await page.getByLabel("AI reply").fill("```json\n" + JSON.stringify(reply) + "\n```");
    await page.getByRole("button", { name: /Check/ }).click();
    await expect(page.getByRole("heading", { name: /Preview/ })).toBeVisible();
    await page.getByRole("button", { name: /^Apply \d+ decisions/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("heading", { name: "Import applied" })).toBeVisible();
    const ov = await (await request.get("/api/admin/overview")).json();
    expect(ov.notes.pending).toBe(0);
  });
});
