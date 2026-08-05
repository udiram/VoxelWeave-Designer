import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const evidenceDir = join(process.cwd(), "test-results/visual-evidence");
mkdirSync(evidenceDir, { recursive: true });

function workspaceButton(page: Page, label: string) {
  return page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: label, exact: true });
}

function evidencePrefix(page: Page) {
  return page.viewportSize()?.width === 390 ? "mobile" : "desktop";
}

async function resetProject(page: Page) {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page).toHaveTitle("VoxelWeave Designer");
  const desktopProjectButton = page.getByTestId("open-synthetic-project");
  if (await desktopProjectButton.isVisible()) {
    await desktopProjectButton.click();
  } else {
    await page.getByTestId("open-synthetic-project-mobile").click();
  }
}

async function runSyntheticWorkflow(page: Page) {
  await workspaceButton(page, "DICOM").click();
  await expect(page.getByRole("heading", { name: "DICOM" })).toBeVisible();
  await page.getByRole("group", { name: "Print orientation" }).getByRole("button", { name: "Sagittal", exact: true }).click();
  await page.getByTestId("create-print-selection").click();
  await expect(page.getByText(/Print selection created/)).toBeVisible();

  await page.getByRole("button", { name: "Review calibration" }).click();
  await expect(page.getByRole("heading", { name: "Calibrate" })).toBeVisible();
  await page.getByTestId("review-calibration").click();
  await page.getByRole("button", { name: "Continue to Prepare" }).click();

  await expect(page.getByRole("heading", { name: "Prepare" })).toBeVisible();
  await page.getByTestId("generate-toolpath").click();
  await expect(page.getByRole("button", { name: "Review clipping" })).toBeVisible();
  await page.getByTestId("acknowledge-clipping").click();
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.getByTestId("generate-audited-gcode").click();
  await expect(page.getByRole("button", { name: "Audited G-code ready" })).toBeVisible();
  await page.getByRole("button", { name: "Continue to Send" }).click();

  await expect(page.getByRole("heading", { name: "Send" })).toBeVisible();
  await page.getByTestId("export-run-package").click();
  await expect(page.getByText(/Exported lung-phantom-study_run-vw-demo-0001.zip/)).toBeVisible();
  await workspaceButton(page, "Verify").click();

  await expect(page.getByRole("heading", { name: "Verify" })).toBeVisible();
  await page.getByTestId("import-scan-back").click();
  await expect(page.getByText(/Imported scan-back_lung-phantom/)).toBeVisible();
  await page.getByTestId("export-report").click();
  await expect(page.getByRole("button", { name: "Report exported" })).toBeVisible();
}

async function writeAccessibilityEvidence(page: Page, fileName: string) {
  mkdirSync(evidenceDir, { recursive: true });
  const result = await page.evaluate(() => {
    const namedButtons = [...document.querySelectorAll("button")].filter((button) => button.getAttribute("aria-label") || button.textContent?.trim());
    return {
      landmarks: {
        main: Boolean(document.querySelector("main")),
        navigation: Boolean(document.querySelector("nav[aria-label='Workspaces']")),
        footer: Boolean(document.querySelector("footer[aria-label='Project evidence status']")),
      },
      namedInteractiveControls: namedButtons.length,
      focusVisibleRule: Boolean([...document.styleSheets].some((sheet) => {
        try { return [...sheet.cssRules].some((rule) => rule.cssText.includes("focus-visible")); } catch { return false; }
      })),
      overflow: { width: document.documentElement.scrollWidth, viewport: window.innerWidth },
    };
  });
  writeFileSync(join(evidenceDir, fileName), JSON.stringify(result, null, 2));
  expect(result.landmarks.main).toBe(true);
  expect(result.landmarks.navigation).toBe(true);
  expect(result.landmarks.footer).toBe(true);
  expect(result.namedInteractiveControls).toBeGreaterThan(20);
  expect(result.overflow.width).toBeLessThanOrEqual(result.overflow.viewport);
}

test.describe("VoxelWeave Designer synthetic desktop workflow", () => {
  test("opens selection, calibration, audited package, and verification report", async ({ page }) => {
    await resetProject(page);
    const prefix = evidencePrefix(page);
    const viewport = page.viewportSize();
    const suffix = viewport?.width === 390 ? "390x844" : "1536x1024";
    await page.screenshot({ path: join(evidenceDir, `${prefix}-design-${suffix}.png`), fullPage: false, scale: "css" });
    await workspaceButton(page, "DICOM").click();
    await page.screenshot({ path: join(evidenceDir, `${prefix}-dicom-${suffix}.png`), fullPage: false, scale: "css" });
    await workspaceButton(page, "Prepare").click();
    await page.screenshot({ path: join(evidenceDir, `${prefix}-prepare-empty-${suffix}.png`), fullPage: false, scale: "css" });
    await runSyntheticWorkflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(evidenceDir, `${prefix}-verify-${suffix}.png`), fullPage: false, scale: "css" });
    await writeAccessibilityEvidence(page, `${prefix}-accessibility.json`);
  });

  test("blocks a native empty project without calibration and requires explicit acceptance", async ({ page }) => {
    test.skip(page.viewportSize()?.width === 390, "native empty-project gate is covered at the desktop viewport");
    await page.addInitScript(() => {
      window.localStorage.clear();
      Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    });
    await page.goto("/");
    await workspaceButton(page, "Calibrate").click();
    await expect(page.getByText("No calibration profiles")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to Prepare" })).toBeDisabled();
  });

  test("requires explicit acceptance before a fixture calibration can be used", async ({ page }) => {
    await resetProject(page);
    await workspaceButton(page, "Calibrate").click();
    await expect(page.getByRole("button", { name: "Revoke acceptance" })).toBeVisible();
    await page.getByRole("button", { name: "Revoke acceptance" }).click();
    await expect(page.getByRole("button", { name: "Accept calibration" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to Prepare" })).toBeDisabled();
    await page.getByRole("button", { name: "Accept calibration" }).click();
    await expect(page.getByRole("button", { name: "Revoke acceptance" })).toBeVisible();
  });

  test("keeps workspace navigation and evidence controls usable at 390px", async ({ page }) => {
    await resetProject(page);
    const prefix = evidencePrefix(page);
    const viewport = page.viewportSize();
    const suffix = viewport?.width === 390 ? "390x844" : "1536x1024";
    await expect(workspaceButton(page, "DICOM")).toBeVisible();
    await workspaceButton(page, "DICOM").click();
    await page.screenshot({ path: join(evidenceDir, `${prefix}-dicom-${suffix}.png`), fullPage: false, scale: "css" });
    await runSyntheticWorkflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(evidenceDir, `${prefix}-verify-${suffix}.png`), fullPage: false, scale: "css" });
    await writeAccessibilityEvidence(page, `${prefix}-accessibility.json`);
  });
});
