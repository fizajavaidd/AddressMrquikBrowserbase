// decline-quotes-module.ts
// Logs into Sera, navigates to filtered appointments page,
// goes to a specific page number, then for each job:
//   - Opens the job
//   - Goes to Quotes tab
//   - Declines all open quotes with reason "Briq Denied Quote"
//   - Returns to the appointment list

import { Stagehand } from "@browserbasehq/stagehand";

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

export async function declineQuotesOnPage(input: {
  dateFilter: string;
  pageNumber: number;
}): Promise<{
  status: string;
  result: string;
  jobsProcessed: number;
  quotesDeclined: number;
  sessionUrl: string;
}> {
  const EMAIL = process.env.STRATABLUE_EMAIL || "mcc@stratablue.com";
  const PASSWORD = process.env.STRATABLUE_PASSWORD || "";
  const { dateFilter, pageNumber } = input;

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: "google/gemini-2.5-flash",
    verbose: DEBUG ? 2 : 1,
    disablePino: !DEBUG,
  });

  let sessionUrl = "";
  let jobsProcessed = 0;
  let quotesDeclined = 0;

  // Helper: navigate with timeout protection
  async function safeGoto(page: any, url: string) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeoutMs: 60000 });
    } catch (e: any) {
      console.log(`    ⚠️  Page load timeout for ${url.substring(0, 80)}... — continuing anyway`);
    }
  }

  try {
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    console.log(`✅ Session: ${sessionUrl}`);

    const page = stagehand.context.pages()[0];

    // ==================== STEP 1: LOGIN ====================
    console.log("  → Login");
    await safeGoto(page, "https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);
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
    if (page.url().includes("/login")) {
      throw new Error("Login failed — still on login page");
    }
    console.log(`    ✅ Logged in`);

    // ==================== STEP 2: GO TO FILTERED APPOINTMENTS ====================
    const appointmentsUrl = `https://misterquik.sera.tech/reports/appointments?jobs-table_scheduled_time=${encodeURIComponent(dateFilter)}&jobs-table_status=completed`;
    console.log(`  → Navigating to appointments: ${appointmentsUrl}`);
    await safeGoto(page, appointmentsUrl);
    await page.waitForTimeout(15000);
    console.log(`    ✅ On: ${page.url()}`);

    // ==================== STEP 3: NAVIGATE TO REQUESTED PAGE ====================
    if (pageNumber > 1) {
      console.log(`  → Navigating to page ${pageNumber}`);
      const clicked = await page.evaluate((pn: number) => {
        const links = document.querySelectorAll('ul.pagination a.page-link, .dt-paging-button a, .page-item a');
        for (const link of links) {
          const text = link.textContent?.trim();
          if (text === String(pn)) {
            (link as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, pageNumber);

      if (!clicked) {
        console.log(`    ⚠️  Could not click page ${pageNumber} button, trying AI...`);
        await stagehand.act(`click on page number ${pageNumber} in the pagination at the bottom`);
      }

      await page.waitForTimeout(5000);
      console.log(`    ✅ On page ${pageNumber}`);
    }

    // ==================== STEP 4: COLLECT JOB IDS ====================
    console.log("  → Collecting job IDs");

    const jobIds: string[] = await page.evaluate(() => {
      const ids: string[] = [];
      const rows = document.querySelectorAll('table tbody tr');
      for (const row of rows) {
        const firstCell = row.querySelector('td:first-child');
        if (firstCell) {
          const link = firstCell.querySelector('a');
          const text = (link?.textContent || firstCell.textContent || "").trim();
          const idMatch = text.match(/(\d{5,})/);
          if (idMatch) ids.push(idMatch[1]);
        }
      }
      return ids;
    });

    console.log(`    ℹ️  Found ${jobIds.length} jobs: ${jobIds.join(", ")}`);

    if (jobIds.length === 0) {
      await stagehand.close();
      return {
        status: "COMPLETED",
        result: `Page ${pageNumber}: No jobs found`,
        jobsProcessed: 0,
        quotesDeclined: 0,
        sessionUrl,
      };
    }

    // ==================== STEP 5: PROCESS EACH JOB ====================
    for (const jobId of jobIds) {
      console.log(`\n  → Processing job ${jobId}`);

      try {
        // Navigate to the job page
        const jobUrl = `https://misterquik.sera.tech/jobs/${jobId}`;
        await safeGoto(page, jobUrl);
        await page.waitForTimeout(5000);

        // Click on Quotes tab
        console.log(`    → Clicking Quotes tab`);
        const quotesTabClicked = await page.evaluate(() => {
          const tabs = document.querySelectorAll('a, button, [role="tab"], .nav-link, .tab');
          for (const tab of tabs) {
            if (tab.textContent?.trim().toLowerCase().includes("quote")) {
              (tab as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (!quotesTabClicked) {
          console.log(`    ⚠️  Quotes tab not found via DOM, trying AI...`);
          await stagehand.act("click on the Quotes tab in the centre of the page");
        }

        await page.waitForTimeout(3000);

        // Find and decline all open quotes
        console.log(`    → Looking for open quotes`);

        let hasMoreQuotes = true;
        let quotesOnThisJob = 0;

        while (hasMoreQuotes) {
          // Check if there are any open quotes visible
          const hasOpenQuote = await page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            const hasOpen = text.includes("open") &&
              (document.querySelector('[class*="open"]') !== null ||
               document.querySelector('[data-cy*="quote"]') !== null ||
               text.includes("quote"));
            const dots = document.querySelectorAll('[class*="dots"], [class*="menu"], [class*="action"], .dropdown-toggle, .btn-icon, [data-toggle="dropdown"]');
            return dots.length > 0 && hasOpen;
          });

          if (!hasOpenQuote && quotesOnThisJob === 0) {
            try {
              const extracted = await stagehand.extract(
                "Are there any open quotes visible on this page under the Open section? Answer yes or no."
              );
              const answer = typeof extracted === "string" ? extracted : JSON.stringify(extracted);
              if (answer.toLowerCase().includes("no")) {
                console.log(`    ℹ️  No open quotes on job ${jobId}`);
                hasMoreQuotes = false;
                break;
              }
            } catch {
              console.log(`    ℹ️  Could not determine if quotes exist on job ${jobId}`);
              hasMoreQuotes = false;
              break;
            }
          }

          if (!hasOpenQuote && quotesOnThisJob > 0) {
            hasMoreQuotes = false;
            break;
          }

          // Click the three dots menu on the first open quote
          console.log(`    → Clicking three dots menu`);
          try {
            await stagehand.act("click the three dots menu button on the right side of the first open quote");
            await page.waitForTimeout(1500);

            // Click "Decline Quote" from the dropdown
            console.log(`    → Clicking Decline Quote`);
            await stagehand.act('click on "Decline Quote" from the dropdown menu');
            await page.waitForTimeout(2000);

            // Fill in the reason in the popup
            console.log(`    → Filling decline reason`);
            const filled = await page.evaluate(() => {
              const inputs = document.querySelectorAll('textarea, input[type="text"], .modal input, .modal textarea, [role="dialog"] textarea, [role="dialog"] input[type="text"]');
              for (const input of inputs) {
                const el = input as HTMLInputElement | HTMLTextAreaElement;
                if (el.offsetParent !== null) {
                  el.value = "Briq Denied Quote";
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                  return true;
                }
              }
              return false;
            });

            if (!filled) {
              await stagehand.act('type "Briq Denied Quote" in the text field in the popup');
            }
            await page.waitForTimeout(1000);

            // Click the Decline Quote button in the popup
            console.log(`    → Confirming decline`);
            await stagehand.act('click the "Decline Quote" button in the popup to confirm');
            await page.waitForTimeout(3000);

            quotesOnThisJob++;
            quotesDeclined++;
            console.log(`    ✅ Declined quote ${quotesOnThisJob} on job ${jobId}`);

          } catch (e: any) {
            console.log(`    ⚠️  Error declining quote on job ${jobId}: ${e.message}`);
            hasMoreQuotes = false;
          }
        }

        jobsProcessed++;
        console.log(`  ✅ Job ${jobId} done — ${quotesOnThisJob} quotes declined`);

      } catch (e: any) {
        console.log(`  ⚠️  Error processing job ${jobId}: ${e.message}`);
        jobsProcessed++;
      }
    }

    // ==================== DONE ====================
    const resultMsg = `Page ${pageNumber}: Processed ${jobsProcessed} jobs, declined ${quotesDeclined} quotes`;
    console.log(`\n🎉 ${resultMsg}`);

    await stagehand.close();

    return {
      status: "COMPLETED",
      result: resultMsg,
      jobsProcessed,
      quotesDeclined,
      sessionUrl,
    };
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    try { await stagehand.close(); } catch {}
    return {
      status: "FAILED",
      result: `Error: ${error.message}`,
      jobsProcessed,
      quotesDeclined,
      sessionUrl,
    };
  }
}