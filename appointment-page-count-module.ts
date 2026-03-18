// appointment-page-count-module.ts
// Logs into Sera, goes directly to filtered appointments URL,
// and returns the total page count.

import { Stagehand } from "@browserbasehq/stagehand";

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

export async function getAppointmentPageCount(input: { dateFilter: string }): Promise<{
  status: string;
  result: string;
  sessionUrl: string;
}> {
  const EMAIL = process.env.STRATABLUE_EMAIL || "mcc@stratablue.com";
  const PASSWORD = process.env.STRATABLUE_PASSWORD || "";
  const dateFilter = input.dateFilter; // e.g. "03/17/2026-03/17/2026"

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: "google/gemini-2.5-flash",
    verbose: DEBUG ? 2 : 1,
    disablePino: !DEBUG,
  });

  let sessionUrl = "";

  try {
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    console.log(`✅ Session: ${sessionUrl}`);

    const page = stagehand.context.pages()[0];

    // ==================== STEP 1: LOGIN ====================
    console.log("  → Login");
    await page.goto("https://misterquik.sera.tech/admins/login", { waitUntil: "load", timeoutMs: 60000 });
    await page.waitForTimeout(2000);
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.waitForTimeout(1000);

    const loginSelectors = ['input[type="submit"]', 'button[type="submit"]', 'button.btn-primary'];
    for (const sel of loginSelectors) {
      try {
        const vis = await page.locator(sel).first().isVisible();
        if (vis) { await page.locator(sel).first().click(); break; }
      } catch {}
    }

    await page.waitForTimeout(5000);
    const loginUrl = page.url();
    if (loginUrl.includes("/login")) {
      throw new Error("Login failed — still on login page. Check credentials.");
    }
    console.log(`    ✅ Logged in → ${loginUrl}`);

    // ==================== STEP 2: GO DIRECTLY TO FILTERED APPOINTMENTS ====================
    const targetUrl = `https://misterquik.sera.tech/reports/appointments?jobs-table_scheduled_time=${encodeURIComponent(dateFilter)}&jobs-table_status=completed`;
    console.log(`  → Navigating directly to: ${targetUrl}`);

    await page.goto(targetUrl, { waitUntil: "load", timeoutMs: 60000 });
    await page.waitForTimeout(8000);
    console.log(`    ✅ On: ${page.url()}`);

    // ==================== STEP 3: GET TOTAL PAGE COUNT ====================
    console.log("  → Reading page count");

    const pageCount = await page.evaluate(() => {
      const allText = document.body.innerText;

      // Method 1: "Page X of Y"
      const pageOfMatch = allText.match(/Page\s+\d+\s+of\s+(\d+)/i);
      if (pageOfMatch) return parseInt(pageOfMatch[1], 10);

      // Method 2: Highest numbered pagination button
      const paginationBtns = document.querySelectorAll('.pagination a, .pagination button, .paginate_button, [class*="page"] a, [class*="page"] button');
      let maxPage = 0;
      for (const btn of paginationBtns) {
        const num = parseInt(btn.textContent?.trim() || "", 10);
        if (!isNaN(num) && num > maxPage) maxPage = num;
      }
      if (maxPage > 0) return maxPage;

      // Method 3: "Showing X to Y of Z"
      const showingMatch = allText.match(/Showing\s+\d+\s*[-–to]+\s*(\d+)\s+of\s+(\d+)/i);
      if (showingMatch) {
        const perPage = parseInt(showingMatch[1], 10);
        const total = parseInt(showingMatch[2], 10);
        if (perPage > 0 && total > 0) return Math.ceil(total / perPage);
      }

      // Method 4: Numbered page links
      const pageLinks = document.querySelectorAll('a[href*="page="], a[data-page], li.page-item a');
      let max2 = 0;
      for (const link of pageLinks) {
        const num = parseInt(link.textContent?.trim() || "", 10);
        if (!isNaN(num) && num > max2) max2 = num;
      }
      if (max2 > 0) return max2;

      return 0;
    });

    let resultMessage: string;
    if (pageCount > 0) {
      resultMessage = `Total pages found: ${pageCount}`;
    } else {
      console.log("    ℹ️  DOM extraction didn't find page count, trying AI extract...");
      const extracted = await stagehand.extract(
        "Look at the bottom of the table/page. Find the pagination or page count. How many total pages are there? Return just the number."
      );
      const aiText = typeof extracted === "string" ? extracted : JSON.stringify(extracted);
      const numMatch = aiText.match(/(\d+)/);
      if (numMatch) {
        resultMessage = `Total pages found: ${numMatch[1]}`;
      } else {
        resultMessage = "No pagination found — possibly only 1 page or no results";
      }
    }

    console.log(`    ✅ ${resultMessage}`);
    await stagehand.close();

    return { status: "COMPLETED", result: resultMessage, sessionUrl };
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    try { await stagehand.close(); } catch {}
    return { status: "FAILED", result: `Error: ${error.message}`, sessionUrl };
  }
}