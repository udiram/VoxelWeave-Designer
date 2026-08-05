import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const evidenceDir = join(process.cwd(), "test-results/visual-evidence");
mkdirSync(evidenceDir, { recursive: true });

function workspaceButton(page: Page, label: string) {
  return page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: label, exact: true });
}

async function switchWorkspace(page: Page, label: string) {
  const button = workspaceButton(page, label);
  if (await button.isVisible()) await button.click();
  else await page.getByRole("combobox", { name: "Switch workspace" }).selectOption({ label });
}

function evidencePrefix(page: Page) {
  return page.viewportSize()?.width === 390 ? "mobile" : "desktop";
}

async function resetProject(page: Page) {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page).toHaveTitle("VoxelWeave Designer");
  const projectButton = page.locator('[data-testid="open-synthetic-project"]:visible, [data-testid="open-synthetic-project-mobile"]:visible').first();
  await expect(projectButton).toBeVisible();
  await projectButton.click();
  await expect(page.getByRole("heading", { name: "Design" })).toBeVisible();
  const renderer = page.locator('[data-testid="design-scene-viewport"][data-voxelweave-renderer="three-r3f"] canvas');
  await expect(renderer).toBeVisible();
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="design-scene-viewport"][data-voxelweave-renderer="three-r3f"] canvas');
    return Boolean(canvas && canvas.width > 0 && canvas.height > 0 && canvas.getContext("webgl2"));
  });
  await page.waitForTimeout(300);
}

async function runSyntheticWorkflow(page: Page) {
  await switchWorkspace(page, "DICOM");
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
  await switchWorkspace(page, "Verify");

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
    await switchWorkspace(page, "DICOM");
    await page.screenshot({ path: join(evidenceDir, `${prefix}-dicom-${suffix}.png`), fullPage: false, scale: "css" });
    await switchWorkspace(page, "Prepare");
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
    await switchWorkspace(page, "Calibrate");
    await expect(page.getByText("No calibration profiles")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to Prepare" })).toBeDisabled();
  });

  test("requires explicit acceptance before a fixture calibration can be used", async ({ page }) => {
    await resetProject(page);
    await switchWorkspace(page, "Calibrate");
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
    const workspaceSwitch = page.getByRole("combobox", { name: "Switch workspace" });
    if (page.viewportSize()?.width === 390) await expect(workspaceSwitch).toBeVisible();
    else await expect(workspaceButton(page, "DICOM")).toBeVisible();
    await switchWorkspace(page, "DICOM");
    await page.screenshot({ path: join(evidenceDir, `${prefix}-dicom-${suffix}.png`), fullPage: false, scale: "css" });
    await runSyntheticWorkflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(evidenceDir, `${prefix}-verify-${suffix}.png`), fullPage: false, scale: "css" });
    await writeAccessibilityEvidence(page, `${prefix}-accessibility.json`);
  });

  test("manipulates a selected object with keyboard, modes, grid, and history", async ({ page }) => {
    test.skip(page.viewportSize()?.width === 390, "the desktop scene interaction contract is covered at the full workspace viewport");
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(message.text()); });
    await resetProject(page);
    const viewport = page.getByTestId("design-scene-viewport");
    const positionX = page.getByRole("textbox", { name: "Position x" });
    await expect(positionX).toHaveValue("0");

    const viewportBox = await viewport.boundingBox();
    expect(viewportBox).not.toBeNull();
    if (viewportBox) {
      await page.mouse.click(viewportBox.x + viewportBox.width * 0.5, viewportBox.y + viewportBox.height * 0.45);
      await expect(page.getByRole("heading", { name: "Airway support" })).toBeVisible();
      await page.getByTestId("scene-row-scene-reference-box").click();
      await page.waitForTimeout(250);
      const dragHandle = page.getByRole("button", { name: "Move Reference frame" });
      await expect(dragHandle).toBeVisible();
      await dragHandle.click();
      await expect(page.getByRole("button", { name: "Undo scene edit" })).toBeDisabled();
      const dragHandleBox = await dragHandle.boundingBox();
      expect(dragHandleBox).not.toBeNull();
      const handleX = dragHandleBox!.x + dragHandleBox!.width / 2;
      const handleY = dragHandleBox!.y + dragHandleBox!.height / 2;
      await page.mouse.move(handleX, handleY);
      await page.mouse.down();
      await page.mouse.move(handleX + 48, handleY + 24, { steps: 8 });
      await page.mouse.up();
      const positionY = page.getByRole("textbox", { name: "Position y" });
      const positionZ = page.getByRole("textbox", { name: "Position z" });
      await expect.poll(async () => [await positionX.inputValue(), await positionY.inputValue(), await positionZ.inputValue()].join("|")).not.toBe("0|0|-26");
      await page.getByRole("button", { name: "Undo scene edit" }).click();
      await expect(positionX).toHaveValue("0");
      await expect(positionY).toHaveValue("0");
      await expect(positionZ).toHaveValue("-26");
    }

    await viewport.focus();
    await viewport.press("ArrowRight");
    await expect(positionX).toHaveValue("0.5");
    await page.getByRole("button", { name: "Undo scene edit" }).click();
    await expect(positionX).toHaveValue("0");
    await page.getByRole("button", { name: "Redo scene edit" }).click();
    await expect(positionX).toHaveValue("0.5");

    await page.getByRole("button", { name: "Rotate selection" }).click();
    await expect(viewport).toHaveAttribute("data-transform-mode", "rotate");
    const rotateHandle = page.getByRole("button", { name: "Rotate Reference frame" });
    const rotateHandleBox = await rotateHandle.boundingBox();
    expect(rotateHandleBox).not.toBeNull();
    await page.mouse.move(rotateHandleBox!.x + rotateHandleBox!.width / 2, rotateHandleBox!.y + rotateHandleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(rotateHandleBox!.x + rotateHandleBox!.width / 2 + 48, rotateHandleBox!.y + rotateHandleBox!.height / 2 - 24, { steps: 8 });
    await page.mouse.up();
    const rotationX = page.getByRole("textbox", { name: "Rotation x" });
    const rotationZ = page.getByRole("textbox", { name: "Rotation z" });
    await expect.poll(async () => `${await rotationX.inputValue()}|${await rotationZ.inputValue()}`).not.toBe("0|0");
    await page.getByRole("button", { name: "Scale selection" }).click();
    await expect(viewport).toHaveAttribute("data-transform-mode", "scale");
    const sizeX = page.getByRole("textbox", { name: "Size x" });
    const sizeBeforeGesture = await sizeX.inputValue();
    const scaleHandle = page.getByRole("button", { name: "Scale Reference frame" });
    const scaleHandleBox = await scaleHandle.boundingBox();
    expect(scaleHandleBox).not.toBeNull();
    await page.mouse.move(scaleHandleBox!.x + scaleHandleBox!.width / 2, scaleHandleBox!.y + scaleHandleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(scaleHandleBox!.x + scaleHandleBox!.width / 2 + 48, scaleHandleBox!.y + scaleHandleBox!.height / 2 - 24, { steps: 8 });
    await page.mouse.up();
    await expect(sizeX).not.toHaveValue(sizeBeforeGesture);
    await page.getByRole("button", { name: "Toggle grid" }).click();
    await expect(viewport).toHaveAttribute("data-grid-visible", "false");

    await sizeX.fill("210.5");
    await sizeX.press("Enter");
    await expect(sizeX).toHaveValue("210.5");
    await page.getByRole("button", { name: "Focus selection in view" }).click();
    await page.screenshot({ path: join(evidenceDir, "desktop-design-manipulation-1536x1024.png"), fullPage: false, scale: "css" });
    expect(runtimeErrors).toEqual([]);
  });
});
