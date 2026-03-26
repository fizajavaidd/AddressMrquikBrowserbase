// qbo-batch-module.ts
// Stagehand task — QBO unbatched invoice batcher
// Extracted from qbo-batch-server.ts for use in server.ts

import { Stagehand } from "@browserbasehq/stagehand";

// =============================================================================
// TYPES
// =============================================================================

export interface QBOBatchOptions {
  testInvoiceUrl?: string;
}

export interface QBOBatchResult {
  success: boolean;
  message: string;
  testMode: boolean;
  invoiceCount: number;
  invoiceAmount: string;
  invoiceItems: string;
  paymentAmount: string;
  paymentItems: string;
  batchNumber: string;
  noInvoices: boolean;
  paymentsCleared: boolean;
  batchCreated: boolean;
  elapsedMinutes: number;
  sessionUrl: string;
}

// =============================================================================
// HELPERS
// =============================================================================

async function waitUntilVisible(page: any, selector: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const visible = await page.locator(selector).first().isVisible();
      if (visible) return true;
    } catch { /* not ready */ }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timeout (${timeoutMs}ms): "${selector}" never became visible`);
}

async function waitUntilHidden(page: any, selector: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const visible = await page.locator(selector).first().isVisible();
      if (!visible) return true;
    } catch { return true; }
    await page.waitForTimeout(500);
  }
  return false;
}

async function deselectAllOnCurrentTab(page: any): Promise<number> {
  return await page.evaluate(() => {
    const headerCb = document.querySelector(
      'thead input[type="checkbox"], th input[type="checkbox"]'
    ) as HTMLInputElement | null;
    if (headerCb && headerCb.checked) {
      headerCb.click();
      return 1;
    }
    const rowCbs = Array.from(
      document.querySelectorAll('tbody input[type="checkbox"]:checked')
    ) as HTMLInputElement[];
    rowCbs.forEach(cb => cb.click());
    return rowCbs.length;
  });
}

async function clickTab(page: any, tabName: "Invoices" | "Payments"): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const clicked = await page.evaluate((pattern: string) => {
      const re = new RegExp(pattern, "i");
      const el = Array.from(
        document.querySelectorAll("a, button, [role='tab'], li, span")
      ).find(
        (e) => re.test(e.textContent?.trim() || "") &&
               (e as HTMLElement).offsetParent !== null
      ) as HTMLElement | null;
      if (el) { el.click(); return true; }
      return false;
    }, `^${tabName}`);
    if (clicked) return true;
    console.log(`    ⚠️  "${tabName}" tab not found — attempt ${attempt + 1}/5`);
    await page.waitForTimeout(2000);
  }
  return false;
}

// =============================================================================
// EXPORTED TASK FUNCTION
// =============================================================================

export async function runQBOBatchTask(options: QBOBatchOptions = {}): Promise<QBOBatchResult> {
  const email     = process.env.SERA_EMAIL    || "mcc@stratablue.com";
  const password  = process.env.SERA_PASSWORD || "";
  const startTime = Date.now();
  const context: any = {};

  const isTestMode   = !!options.testInvoiceUrl;
  const unbatchedUrl = options.testInvoiceUrl || "https://misterquik.sera.tech/accounting/unbatched";

  console.log(isTestMode
    ? `\n🧪 TEST MODE — URL: ${unbatchedUrl}`
    : "\n🚀 PRODUCTION MODE — processing all unbatched invoices"
  );

  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    model: {
      modelName: "google/gemini-2.5-flash",
      apiKey: process.env.GEMINI_API_KEY || "",
    },
    verbose: 1,
    disablePino: true,
  });

  let sessionUrl = "";

  try {
    await stagehand.init();
    sessionUrl = `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`;
    console.log(`✅ Session started: ${sessionUrl}`);

    const page = stagehand.context.pages()[0];

    // ------------------------------------------------------------------
    // STEP 1 — Login
    // ------------------------------------------------------------------
    console.log("\n[1] → Navigating to login page");
    await page.goto("https://misterquik.sera.tech/admins/login");
    await page.waitForTimeout(3000);

    const currentUrl: string = await page.url();
    if (currentUrl.includes("/login")) {
      console.log("    → Filling credentials");
      await page.locator('input[type="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(password);
      await page.waitForTimeout(500);

      const clicked = await page.evaluate(() => {
        const btn = Array.from(
          document.querySelectorAll('button, input[type="submit"]')
        ).find(
          (el) =>
            ["sign in", "login", "log in"].some(
              (kw) =>
                el.textContent?.toLowerCase().trim() === kw ||
                (el as HTMLInputElement).value?.toLowerCase() === kw
            ) && (el as HTMLElement).offsetParent !== null
        ) as HTMLElement | null;
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!clicked) {
        await page.locator('button[type="submit"]').first().click();
      }

      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(1000);
        const url: string = await page.url();
        if (!url.includes("/login")) {
          console.log(`    ✅ Logged in — redirected to: ${url}`);
          break;
        }
        if (i === 29) throw new Error("Still on login page after 30s — check credentials");
      }
    } else {
      console.log("    ✅ Already logged in");
    }

    // ------------------------------------------------------------------
    // STEP 2 — Navigate to unbatched page
    // ------------------------------------------------------------------
    console.log(`\n[2] → Navigating to: ${unbatchedUrl}`);
    await page.goto(unbatchedUrl);

    console.log("\n[2b] → Waiting 15 seconds for page to load...");
    await page.waitForTimeout(15000);
    console.log("    ✅ Page load wait complete");

    // ------------------------------------------------------------------
    // STEP 3 — Read BOTH tab labels for correct counts
    // ------------------------------------------------------------------
    console.log("\n[3] → Reading tab labels for correct counts");

    const tabCounts: {
      invoiceCount: number;
      paymentCount: number;
      invoiceTabLabel: string;
      paymentTabLabel: string;
    } = await page.evaluate(() => {
      let invoiceCount    = 0;
      let paymentCount    = 0;
      let invoiceTabLabel = "";
      let paymentTabLabel = "";

      const allEls = Array.from(
        document.querySelectorAll("a, button, [role='tab'], li, span, div")
      ).filter(e => (e as HTMLElement).offsetParent !== null);

      for (const el of allEls) {
        const text = el.textContent?.trim() || "";

        const invMatch = text.match(/^invoices?\s*[(\[]?\s*(\d+)\s*[)\]]?$/i);
        if (invMatch && !invoiceTabLabel) {
          invoiceCount    = parseInt(invMatch[1], 10);
          invoiceTabLabel = text;
        }

        const payMatch = text.match(/^payments?\s*[(\[]?\s*(\d+)\s*[)\]]?$/i);
        if (payMatch && !paymentTabLabel) {
          paymentCount    = parseInt(payMatch[1], 10);
          paymentTabLabel = text;
        }
      }

      return { invoiceCount, paymentCount, invoiceTabLabel, paymentTabLabel };
    });

    console.log(`    ℹ️  Invoice tab: "${tabCounts.invoiceTabLabel}" → ${tabCounts.invoiceCount}`);
    console.log(`    ℹ️  Payment tab: "${tabCounts.paymentTabLabel}" → ${tabCounts.paymentCount}`);

    const invoiceCount = tabCounts.invoiceCount;
    context.invoiceCount = invoiceCount;

    // ------------------------------------------------------------------
    // STEP 4 — Invoices tab → deselect everything first
    // ------------------------------------------------------------------
    console.log("\n[4] → Invoices tab — deselecting any pre-selected rows");
    await clickTab(page, "Invoices");
    await page.waitForTimeout(3000);

    const invDeselected = await deselectAllOnCurrentTab(page);
    console.log(`    ℹ️  Deselected ${invDeselected} invoice row(s)`);
    await page.waitForTimeout(1500);

    // ------------------------------------------------------------------
    // STEP 5 — Payments tab → deselect everything
    // ------------------------------------------------------------------
    console.log("\n[5] → Payments tab — deselecting all payments");
    await clickTab(page, "Payments");
    await page.waitForTimeout(3000);

    const payDeselected = await deselectAllOnCurrentTab(page);
    console.log(`    ℹ️  Deselected ${payDeselected} payment row(s)`);
    await page.waitForTimeout(1500);

    let paymentsNoneSelected: boolean = await page.evaluate(() =>
      /total payments?[:\s]*none selected/i.test(document.body.textContent || "")
    );

    if (!paymentsNoneSelected) {
      console.log("    ⚠️  Retrying payment deselect");
      await deselectAllOnCurrentTab(page);
      await page.waitForTimeout(2000);
      paymentsNoneSelected = await page.evaluate(() =>
        /total payments?[:\s]*none selected/i.test(document.body.textContent || "")
      );
    }

    console.log(paymentsNoneSelected
      ? "    ✅ Total Payments: None Selected (0 items)"
      : "    ⚠️  'None Selected' not detected — modal is the final safety gate"
    );
    context.paymentsCleared = true;

    // ------------------------------------------------------------------
    // STEP 6 — Back to Invoices tab
    // ------------------------------------------------------------------
    console.log("\n[6] → Back to Invoices tab");
    const invoicesClicked = await clickTab(page, "Invoices");
    if (!invoicesClicked) throw new Error("Could not click Invoices tab");
    await page.waitForTimeout(3000);

    // ------------------------------------------------------------------
    // NO INVOICES — bail early
    // ------------------------------------------------------------------
    if (invoiceCount === 0) {
      context.noInvoices = true;
      context.completionMessage = "No records found.";
      console.log("    ✅ No invoices to batch");

    } else {
      // ------------------------------------------------------------------
      // STEP 7 — Select ALL invoices via header checkbox
      // ------------------------------------------------------------------
      console.log(`\n[7] → Selecting all ${invoiceCount} invoice(s)`);
      const selectAllClicked = await page.evaluate(() => {
        const cb = document.querySelector(
          "thead input[type='checkbox'], th input[type='checkbox']"
        ) as HTMLInputElement | null;
        if (cb) {
          if (!cb.checked) cb.click();
          return true;
        }
        return false;
      });
      if (!selectAllClicked) throw new Error("Select All checkbox not found on Invoices tab");
      await page.waitForTimeout(2000);

      const headerTotals = await page.evaluate(() => {
        const bodyText = document.body.textContent || "";
        const invMatch = bodyText.match(/total invoices?[:\s]*\$?([\d,]+\.?\d*)/i);
        const payNone  = /total payments?[:\s]*none selected/i.test(bodyText);
        const snippet  = (bodyText.match(/total invoices?.{0,220}/i) || [""])[0]
          .replace(/\s+/g, " ").trim();
        return {
          invoiceTotal:        invMatch ? `$${invMatch[1]}` : "N/A",
          paymentNoneSelected: payNone,
          rawHeaderText:       snippet,
        };
      });

      console.log(`    ℹ️  Header: "${headerTotals.rawHeaderText}"`);
      console.log(`    ℹ️  Invoice total: ${headerTotals.invoiceTotal}`);
      console.log(`    ℹ️  Total Payments: None Selected = ${headerTotals.paymentNoneSelected}`);
      context.invoiceTotal = headerTotals.invoiceTotal;

      if (/none selected/i.test(headerTotals.invoiceTotal) || headerTotals.invoiceTotal === "N/A") {
        context.noInvoices = true;
        context.completionMessage = "No records found.";
        console.log("    ✅ Header shows no invoices selected — returning No records found");
      } else {

        if (headerTotals.paymentNoneSelected) {
          console.log("    ✅ Perfect — invoices selected, Total Payments: None Selected");
        } else {
          console.log("    ⚠️  Payments not 'None Selected' — doing one final retry");
          await clickTab(page, "Payments");
          await page.waitForTimeout(2000);
          await deselectAllOnCurrentTab(page);
          await page.waitForTimeout(2000);
          await clickTab(page, "Invoices");
          await page.waitForTimeout(2000);
          await page.evaluate(() => {
            const cb = document.querySelector(
              "thead input[type='checkbox'], th input[type='checkbox']"
            ) as HTMLInputElement | null;
            if (cb && !cb.checked) cb.click();
          });
          await page.waitForTimeout(2000);

          const recheckNone = await page.evaluate(() =>
            /total payments?[:\s]*none selected/i.test(document.body.textContent || "")
          );
          console.log(recheckNone
            ? "    ✅ Confirmed: Total Payments: None Selected"
            : "    ⚠️  Still not 'None Selected' — proceeding, modal is the final gate"
          );
        }

        // ------------------------------------------------------------------
        // STEP 8 — Click Send to QuickBooks
        // ------------------------------------------------------------------
        console.log("\n[8] → Clicking Send to QuickBooks");
        const qbClicked = await page.evaluate(() => {
          const el = Array.from(document.querySelectorAll("button, a")).find(
            (e) =>
              (e.textContent?.toLowerCase().includes("send to quickbooks") ||
                e.textContent?.toLowerCase().includes("quickbooks")) &&
              (e as HTMLElement).offsetParent !== null
          ) as HTMLElement | null;
          if (el) { el.click(); return true; }
          return false;
        });
        if (!qbClicked) throw new Error('"Send to QuickBooks" button not found');
        await page.waitForTimeout(3000);

        // ------------------------------------------------------------------
        // STEP 9 — Read modal — HARD safety gate
        // ------------------------------------------------------------------
        console.log("\n[9] → Reading batch modal");
        await waitUntilVisible(page, '.modal, [role="dialog"], .modal-content, .sera-modal', 15000);
        await page.waitForTimeout(3000);

        const modalDetails: {
          batchNumber:   string;
          invoiceAmount: string;
          invoiceItems:  number;
          paymentAmount: string;
          paymentItems:  number;
          rawText:       string;
        } = await page.evaluate(() => {
          const modal   = document.querySelector(
            '.modal, [role="dialog"], .modal-content, .sera-modal'
          );
          const text    = modal?.textContent || "";
          const rawText = text.replace(/\s+/g, " ").trim().substring(0, 600);

          const batchMatch =
            text.match(/batch\s*#?\s*(\d{4,})/i) ||
            text.match(/#\s*(\d{4,})/);

          const lines = text
            .split(/[\n\r]+/)
            .map(l => l.replace(/\s+/g, " ").trim())
            .filter(Boolean);

          let invoiceAmount = "";
          let invoiceItems  = 0;
          let paymentAmount = "$0.00";
          let paymentItems  = 0;

          for (const line of lines) {
            if (/^invoices?/i.test(line)) {
              const amt   = line.match(/\$([\d,]+\.\d{2})/);
              const items = line.match(/(\d+)\s*items?/i);
              if (amt)   invoiceAmount = `$${amt[1]}`;
              if (items) invoiceItems  = parseInt(items[1], 10);
            }
            if (/^payments?/i.test(line)) {
              const amt   = line.match(/\$([\d,]+\.\d{2})/);
              const items = line.match(/(\d+)\s*items?/i);
              if (amt)   paymentAmount = `$${amt[1]}`;
              if (items) paymentItems  = parseInt(items[1], 10);
            }
          }

          if (!invoiceAmount) {
            const m = text.match(/invoices?\s*\$\s*([\d,]+\.\d{2})/i);
            if (m) invoiceAmount = `$${m[1]}`;
          }
          if (!invoiceItems) {
            const m = text.match(/invoices?[^$\n]*?(\d+)\s*items?/i);
            if (m) invoiceItems = parseInt(m[1], 10);
          }
          if (paymentItems === 0) {
            const m = text.match(/payments?[^$\n]*?(\d+)\s*items?/i);
            if (m) paymentItems = parseInt(m[1], 10);
          }

          return {
            batchNumber:   batchMatch ? batchMatch[1] : "",
            invoiceAmount,
            invoiceItems,
            paymentAmount,
            paymentItems,
            rawText,
          };
        });

        console.log(`\n    📋 Modal raw text:\n    ${modalDetails.rawText}\n`);
        console.log(`    ℹ️  Batch #:   "${modalDetails.batchNumber}"`);
        console.log(`    ℹ️  Invoices:   ${modalDetails.invoiceAmount} (${modalDetails.invoiceItems} items)`);
        console.log(`    ℹ️  Payments:   ${modalDetails.paymentAmount} (${modalDetails.paymentItems} items)`);

        // HARD ABORT — if any payment items in batch, stop now
        if (modalDetails.paymentItems > 0) {
          throw new Error(
            `Modal shows ${modalDetails.paymentItems} payment item(s) — aborting. Only invoices should be batched.`
          );
        }
        console.log("    ✅ Modal verified — 0 payment items in batch");

        const batchLabel = modalDetails.batchNumber
          ? `Batch #${modalDetails.batchNumber}`
          : "Batch";

        context.batchNumber   = modalDetails.batchNumber;
        context.invoiceAmount = modalDetails.invoiceAmount || context.invoiceTotal || "N/A";
        context.invoiceItems  = String(modalDetails.invoiceItems || invoiceCount);
        context.paymentAmount = modalDetails.paymentAmount;
        context.paymentItems  = String(modalDetails.paymentItems);

        // ------------------------------------------------------------------
        // STEP 10 — Click Create Batch
        // ------------------------------------------------------------------
        console.log("\n[10] → Clicking Create Batch");
        const createBatchClicked = await page.evaluate(() => {
          const modal  = document.querySelector(
            '.modal, [role="dialog"], .modal-content, .sera-modal'
          );
          const scope  = modal || document;
          const byText = Array.from(scope.querySelectorAll("button")).find(
            (e) =>
              e.textContent?.toLowerCase().includes("create batch") &&
              (e as HTMLElement).offsetParent !== null
          ) as HTMLElement | null;
          if (byText) { byText.click(); return true; }
          const fallback = scope.querySelector(
            'button[type="submit"], button.btn-primary, button.primary'
          ) as HTMLElement | null;
          if (fallback) { (fallback as HTMLElement).click(); return true; }
          return false;
        });
        if (!createBatchClicked) throw new Error('"Create Batch" button not found');
        await page.waitForTimeout(5000);

        // ------------------------------------------------------------------
        // STEP 11 — Wait for modal to close
        // ------------------------------------------------------------------
        console.log("\n[11] → Waiting for batch to complete");
        await waitUntilHidden(page, '.modal, [role="dialog"], .modal-content', 30000);

        context.batchCreated = true;
        context.completionMessage = [
          `**Invoice Processing:** Selected ${invoiceCount} invoice(s) on the 'Invoices' tab.`,
          `**Batch Creation:** Created ${batchLabel}.`,
          `   - **Total Invoices:** ${context.invoiceAmount} (${context.invoiceItems} items)`,
          `   - **Total Payments:** ${context.paymentAmount} (${context.paymentItems} items)`,
          `**Confirmation:** The batch is currently processing on the system.`,
        ].join("\n");

        console.log(`\n✅ Done:\n${context.completionMessage}`);
      }
    }
  } catch (error: any) {
    console.error(`\n❌ Task error: ${error.message}`);
    context.taskError = error.message;
    context.completionMessage = `Task failed: ${error.message}. Session: ${sessionUrl}`;
  } finally {
    await stagehand.close();
    console.log("\n🔒 Browser session closed");
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  const success = !!context.batchCreated || !!context.noInvoices;

  return {
    success,
    message:         context.completionMessage || "Task did not complete — check session replay.",
    testMode:        isTestMode,
    invoiceCount:    context.invoiceCount    ?? 0,
    invoiceAmount:   context.invoiceAmount   ?? "N/A",
    invoiceItems:    context.invoiceItems    ?? "0",
    paymentAmount:   context.paymentAmount   ?? "$0.00",
    paymentItems:    context.paymentItems    ?? "0",
    batchNumber:     context.batchNumber     ?? "",
    noInvoices:      context.noInvoices      ?? false,
    paymentsCleared: context.paymentsCleared ?? false,
    batchCreated:    context.batchCreated    ?? false,
    elapsedMinutes:  parseFloat(elapsed),
    sessionUrl,
  };
}