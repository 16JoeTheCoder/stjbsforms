import { expect, test, type Page } from "@playwright/test";

const CODE = "K7M4P";
const LETTER = (i: number) =>
  `Thank you for every lesson this year (${i}), especially the way you explained the hard parts twice without ever sighing. It mattered.`;

async function enterClass(page: Page, code = CODE) {
  await page.goto("/");
  await page.getByLabel("Class code").fill(code.toLowerCase());
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Is this your class?" })).toBeVisible();
  await page.getByRole("button", { name: /^Yes/ }).click();
  await expect(page.getByRole("heading", { name: "The awards" })).toBeVisible();
}

async function pick(page: Page, index: number, query: string) {
  const box = page.getByRole("combobox").nth(index);
  await box.click();
  await box.fill(query);
  await page.keyboard.press("Enter");
}

async function fillAwards(page: Page) {
  const q = ["cath", "budi", "dewi", "andreas", "maria", "hendra"];
  for (let i = 0; i < 6; i++) await pick(page, i, q[i]!);
  await expect(page.getByText("6 of 6 chosen")).toBeVisible();
}

async function fillLetters(page: Page) {
  await page.getByRole("button", { name: /Next: letters/ }).click();
  const q = ["grace", "kevin", "monica"];
  for (let i = 0; i < 3; i++) {
    await pick(page, i, q[i]!);
    await page.locator(`#letter-${i}-body`).fill(LETTER(i));
  }
}

test("complete submission, receipt survives reload, browser can't resubmit", async ({ page, request }) => {
  await enterClass(page);
  await fillAwards(page);
  await expect(page.getByRole("combobox").nth(0)).toHaveValue("Ms. Catherine Tan");
  await fillLetters(page);
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Check and send" })).toBeVisible();
  await expect(page.getByText("Ms. Grace Halim").first()).toBeVisible();
  await page.getByRole("button", { name: "Submit my response" }).click();
  await expect(page.getByRole("dialog")).toContainText("You won't be able to edit this response afterward.");
  await page.getByRole("button", { name: "Yes, submit" }).click();
  await expect(page.getByRole("heading", { name: "Thank you." })).toBeVisible();
  const receipt = await page.locator("p.tabular").first().textContent();
  expect(receipt).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Thank you." })).toBeVisible();
  await expect(page.getByText(receipt!)).toBeVisible();

  // persisted server-side
  const ov = await (await request.get("/api/admin/overview", { headers: { "x-dev-user": "owner@example.com" } })).json();
  expect(ov.submissions.active).toBeGreaterThan(0);

  // clearing local data doesn't allow a second submission from this browser
  await page.getByRole("button", { name: "Remove saved copy from this device" }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  await enterClass(page);
  await fillAwards(page);
  await fillLetters(page);
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Submit my response" }).click();
  await page.getByRole("button", { name: "Yes, submit" }).click();
  await expect(page.getByRole("heading", { name: "Already sent from this browser." })).toBeVisible();
});

test("teacher picker: keyboard, typos, honorifics, duplicates, no free text", async ({ page }) => {
  await enterClass(page);
  const first = page.getByRole("combobox").nth(0);
  await first.click();
  await first.fill("ms cahterine"); // honorific + transposition typo
  await expect(page.getByRole("option").first()).toContainText("Catherine Tan");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(first).toHaveValue("Ms. Catherine Tan");

  // Escape closes without changing the value
  await first.click();
  await first.fill("budi");
  await page.keyboard.press("Escape");
  await page.locator("h1").click();
  await expect(first).toHaveValue("Ms. Catherine Tan");

  // Arbitrary text never becomes a selection
  const second = page.getByRole("combobox").nth(1);
  await second.click();
  await second.fill("Someone Not Real");
  await expect(page.getByText(/No teacher matches/)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(second).toHaveValue("");

  // A teacher used for another award is marked and can't be selected
  await second.click();
  await second.fill("catherine");
  const opt = page.getByRole("option", { name: /Catherine Tan/ });
  await expect(opt).toContainText("Already chosen");
  await expect(opt).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await page.locator("h1").click();
  await expect(second).toHaveValue("");

  // Next is blocked until all six are chosen
  await page.getByRole("button", { name: /Next: letters/ }).click();
  await expect(page.getByText("Choose a teacher for this award.").first()).toBeVisible();
});

test("draft survives reload and validation blocks short or identical letters", async ({ page }) => {
  await enterClass(page);
  await fillAwards(page);
  await page.getByRole("button", { name: /Next: letters/ }).click();
  await pick(page, 0, "grace");
  await page.locator("#letter-0-body").fill("x".repeat(99));
  await expect(page.getByText("99 / 400 characters")).toBeVisible();
  await page.waitForTimeout(600); // debounce
  await page.reload();
  await expect(page.getByRole("heading", { name: "Three letters" })).toBeVisible();
  await expect(page.locator("#letter-0-body")).toHaveValue("x".repeat(99));
  await expect(page.getByRole("combobox").nth(0)).toHaveValue("Ms. Grace Halim");

  await pick(page, 1, "kevin");
  await pick(page, 2, "monica");
  await page.locator("#letter-1-body").fill(LETTER(1));
  await page.locator("#letter-2-body").fill(LETTER(1).toUpperCase());
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText("Letter 1: needs at least 100 characters.")).toBeVisible();
  await expect(page.getByText(/identical/).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Three letters" })).toBeVisible();
});

test("lost response: server commits, browser sees error, outcome is recovered without a duplicate", async ({ page, request }) => {
  const count = async () =>
    (await (await request.get("/api/admin/overview", { headers: { "x-dev-user": "owner@example.com" } })).json()).submissions.total as number;
  const before = await count();
  await enterClass(page, "H3QX9");
  await fillAwards(page);
  await fillLetters(page);
  await page.getByRole("button", { name: "Review" }).click();
  let calls = 0;
  await page.route("**/api/public/submissions", async (route) => {
    calls++;
    await route.fetch(); // reaches the server and commits
    await route.abort("connectionreset"); // ...but the browser never sees the response
  });
  await page.getByRole("button", { name: "Submit my response" }).click();
  await page.getByRole("button", { name: "Yes, submit" }).click();
  await expect(page.getByRole("heading", { name: "Thank you." })).toBeVisible();
  expect(calls).toBe(1);
  expect(await count()).toBe(before + 1);
});

test("offline submit keeps every answer and says nothing was sent", async ({ page }) => {
  await enterClass(page, "R8TZ2");
  await fillAwards(page);
  await fillLetters(page);
  await page.getByRole("button", { name: "Review" }).click();
  await page.route("**/api/public/submissions**", (route) => route.abort("internetdisconnected"));
  await page.getByRole("button", { name: "Submit my response" }).click();
  await page.getByRole("button", { name: "Yes, submit" }).click();
  await expect(page.getByText(/couldn't confirm|wasn't sent/i)).toBeVisible();
  await page.unroute("**/api/public/submissions**");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Check and send" })).toBeVisible();
  await expect(page.getByText(LETTER(2))).toBeVisible();
});

test("wrong code shows a clear error", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Class code").fill("ZZZZZ");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("couldn't find that class code");
  await page.getByLabel("Class code").fill("O0I1L");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("O, 0, I or 1");
});
