#!/usr/bin/env node

/**
 * Production-bundle UI qualification for the desktop web surface.
 *
 * This is deliberately a browser-adapter gate, not a native WebKit or
 * Instruments claim. The Tauri application is qualified separately by the
 * native smoke and sidecar benchmark jobs. This script exercises the same
 * built React surface in Chromium, records browser capabilities, and emits
 * repeatable evidence for severe regressions.
 */

import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const desktopRoot = path.join(root, "apps", "desktop");
const defaultOutputDir = path.join(root, "desktop-ui-performance");
const defaultBudgetPath = path.join(root, "scripts", "desktop-ui-performance-budget.json");

const LONG_TASK_INIT_SCRIPT = String.raw`
  (() => {
    const state = window.__voxelweaveUiPerf = window.__voxelweaveUiPerf || {
      longTasks: [],
      probes: [],
    };
    if (!state.longTaskObserver && typeof PerformanceObserver !== "undefined") {
      try {
        state.longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.longTasks.push({ start: entry.startTime, duration: entry.duration, name: entry.name });
          }
        });
        state.longTaskObserver.observe({ type: "longtask", buffered: true });
      } catch {
        state.longTaskObserver = null;
      }
    }
    window.__voxelweaveBeginUiProbe = (label) => {
      const probe = { label, started: performance.now(), frames: [], lastFrame: null, rafId: 0 };
      const tick = (timestamp) => {
        if (probe.lastFrame !== null) probe.frames.push(timestamp - probe.lastFrame);
        probe.lastFrame = timestamp;
        probe.rafId = requestAnimationFrame(tick);
      };
      probe.rafId = requestAnimationFrame(tick);
      state.activeProbe = probe;
    };
    window.__voxelweaveEndUiProbe = (label) => {
      const probe = state.activeProbe;
      if (!probe || probe.label !== label) return { label, unavailable: true, frames: [] };
      cancelAnimationFrame(probe.rafId);
      const ended = performance.now();
      const frames = probe.frames.slice();
      const sorted = frames.slice().sort((a, b) => a - b);
      const percentile = (fraction) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] : null;
      const longTasks = state.longTasks.filter((task) => task.start >= probe.started && task.start <= ended);
      state.probes.push({ label, started: probe.started, ended, durationMs: ended - probe.started, frames, longTasks });
      state.activeProbe = null;
      return {
        label,
        durationMs: ended - probe.started,
        frameCount: frames.length,
        fps: frames.length ? (frames.length * 1000) / Math.max(1, ended - probe.started) : 0,
        p50FrameMs: percentile(0.5),
        p95FrameMs: percentile(0.95),
        maxFrameMs: frames.length ? Math.max(...frames) : null,
        longTaskCount: longTasks.length,
        longTaskMaxMs: longTasks.length ? Math.max(...longTasks.map((task) => task.duration)) : 0,
        longTasks,
      };
    };
  })();
`;

function parseArgs(argv) {
  const args = {
    outputDir: defaultOutputDir,
    budgetPath: defaultBudgetPath,
    iterations: 3,
    warmups: 1,
    port: 4174,
    keepServer: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--output-dir") args.outputDir = path.resolve(next ?? "");
    else if (token === "--budget") args.budgetPath = path.resolve(next ?? "");
    else if (token === "--iterations") args.iterations = Number(next);
    else if (token === "--warmups") args.warmups = Number(next);
    else if (token === "--port") args.port = Number(next);
    else if (token === "--keep-server") args.keepServer = true;
    else if (token === "--help" || token === "-h") {
      console.log("Usage: benchmark-desktop-ui.mjs [--output-dir DIR] [--budget FILE] [--iterations N] [--warmups N] [--port N] [--keep-server]");
      process.exit(0);
    } else if (token.startsWith("--")) {
      throw new Error(`unknown option ${token}`);
    }
    if (["--output-dir", "--budget", "--iterations", "--warmups", "--port"].includes(token)) index += 1;
  }
  if (!Number.isInteger(args.iterations) || args.iterations < 1 || args.iterations > 20) throw new Error("--iterations must be an integer from 1 to 20");
  if (!Number.isInteger(args.warmups) || args.warmups < 0 || args.warmups > 10) throw new Error("--warmups must be an integer from 0 to 10");
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) throw new Error("--port must be a valid local TCP port");
  return args;
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function percentile(values, fraction) {
  const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function aggregate(values, budget) {
  const finite = values.filter((value) => Number.isFinite(value));
  const summary = {
    samples: values,
    count: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: finite.length ? Math.max(...finite) : null,
    targetMs: budget?.target_ms ?? null,
    gateMs: budget?.gate_ms ?? null,
    targetMet: budget?.target_ms === undefined ? null : finite.length > 0 && percentile(finite, 0.95) <= budget.target_ms,
    gatePassed: budget?.gate_ms === undefined ? true : finite.length > 0 && Math.max(...finite) <= budget.gate_ms,
  };
  return summary;
}

function allGateFailures(metrics) {
  return Object.entries(metrics)
    .filter(([, metric]) => metric.gatePassed === false)
    .map(([name, metric]) => `${name}: max/p95 ${metric.max ?? "n/a"}/${metric.p95 ?? "n/a"} ms exceeds gate ${metric.gateMs} ms`);
}

function sleepMs(milliseconds) {
  return wait(milliseconds);
}

async function waitForPreview(url, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleepMs(200);
  }
  throw new Error(`Vite preview did not become ready at ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
}

async function startPreview(port, serverLogPath) {
  const logFd = openSync(serverLogPath, "w");
  const child = spawn("pnpm", ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: desktopRoot,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, BROWSER: "none" },
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForPreview(`${url}/`);
    return { child, url, logFd };
  } catch (error) {
    killProcessTree(child);
    closeSync(logFd);
    throw error;
  }
}

function createRequireForDesktop() {
  return createRequire(pathToFileURL(path.join(desktopRoot, "package.json")));
}

function navigation(page, label) {
  return page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: label, exact: true });
}

async function firstMeaningfulWorkspace(page, url) {
  const started = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Design" }).waitFor({ state: "visible" });
  await page.locator("main").waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts?.ready);
  const timing = await page.evaluate(() => {
    const navigationEntry = performance.getEntriesByType("navigation")[0];
    return {
      performanceNowMs: performance.now(),
      domContentLoadedMs: navigationEntry?.domContentLoadedEventEnd ?? null,
      loadEventMs: navigationEntry?.loadEventEnd ?? null,
    };
  });
  return { elapsedWallMs: Date.now() - started, ...timing };
}

async function measureProbe(page, label, action) {
  await page.evaluate((probeLabel) => window.__voxelweaveBeginUiProbe?.(probeLabel), label);
  await action();
  await page.waitForTimeout(250);
  return page.evaluate((probeLabel) => window.__voxelweaveEndUiProbe?.(probeLabel) ?? { label: probeLabel, unavailable: true }, label);
}

async function dragInside(page, locator, { moves = 20, wheel = 0 } = {}) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`could not resolve interaction bounds for ${await locator.getAttribute("aria-label")}`);
  const left = box.x + box.width * 0.2;
  const top = box.y + box.height * 0.25;
  await page.mouse.move(left, top);
  await page.mouse.down();
  for (let step = 1; step <= moves; step += 1) {
    await page.mouse.move(box.x + box.width * (0.2 + 0.6 * (step / moves)), box.y + box.height * (0.25 + 0.45 * (step / moves)));
  }
  await page.mouse.up();
  if (wheel) {
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55);
    await page.mouse.wheel(0, wheel);
  }
}

async function measureDicom(page) {
  await navigation(page, "DICOM").click();
  await page.getByRole("heading", { name: "DICOM" }).waitFor({ state: "visible" });
  const panes = page.locator(".mpr-grid .interactive-mpr");
  await panes.first().waitFor({ state: "visible" });
  return measureProbe(page, "dicom-mpr", async () => {
    const count = await panes.count();
    for (let index = 0; index < count; index += 1) await dragInside(page, panes.nth(index), { moves: 12 });
    await dragInside(page, page.locator(".interactive-volume"), { moves: 10, wheel: 180 });
    await page.getByRole("button", { name: "Linked crosshair", exact: true }).click();
  });
}

async function measureDesign(page) {
  await navigation(page, "Design").click();
  await page.getByRole("heading", { name: "Design" }).waitFor({ state: "visible" });
  const viewport = page.getByTestId("design-scene-viewport");
  await viewport.waitFor({ state: "visible" });
  const renderer = await inspectThreeSurface(page, '[data-testid="design-scene-viewport"]');
  const probe = await measureProbe(page, "design-geometry", async () => {
    for (const primitive of ["Box", "Cylinder", "Wedge", "Polygon prism"]) {
      await page.getByRole("button", { name: primitive, exact: true }).click();
    }
    await dragInside(page, viewport, { moves: 30 });
    const positionX = page.getByLabel("Position x");
    if (await positionX.count()) {
      for (const value of ["1.2", "-0.8", "2.4", "0"]) await positionX.fill(value);
    }
    await page.getByRole("button", { name: "Validate scene", exact: true }).click();
  });
  return { ...probe, renderer };
}

async function generateToolpath(page) {
  await navigation(page, "DICOM").click();
  await page.getByRole("heading", { name: "DICOM" }).waitFor({ state: "visible" });
  const create = page.getByTestId("create-print-selection");
  if (!(await create.isDisabled())) {
    await create.click();
    await page.getByText(/Print selection created/).waitFor({ state: "visible" });
  }
  const review = page.getByRole("button", { name: "Review calibration", exact: true });
  if (await review.isVisible()) await review.click();
  await page.getByRole("heading", { name: "Calibrate" }).waitFor({ state: "visible" });
  const reviewCalibration = page.getByTestId("review-calibration");
  if (await reviewCalibration.isEnabled()) await reviewCalibration.click();
  const continueButton = page.getByRole("button", { name: "Continue to Prepare", exact: true });
  if (await continueButton.isDisabled()) throw new Error("synthetic workflow could not reach Prepare: accepted calibration or print selection missing");
  await continueButton.click();
  await page.getByRole("heading", { name: "Prepare" }).waitFor({ state: "visible" });
  const generate = page.getByTestId("generate-toolpath");
  if (await generate.isVisible()) {
    await generate.click();
    await page.getByRole("button", { name: "Review clipping" }).waitFor({ state: "visible" });
    await page.getByTestId("acknowledge-clipping").click();
    const dismiss = page.getByRole("button", { name: "Dismiss notification" });
    if (await dismiss.isVisible()) await dismiss.click();
  }
  await page.locator(".toolpath-canvas").waitFor({ state: "visible" });
}

async function measureToolpath(page) {
  await generateToolpath(page);
  const canvas = page.locator(".toolpath-canvas");
  const renderer = await inspectThreeSurface(page, ".toolpath-canvas");
  const probe = await measureProbe(page, "toolpath-layer", async () => {
    await dragInside(page, canvas, { moves: 32 });
    const layer = page.getByRole("slider", { name: "Active layer" });
    if (await layer.count()) {
      for (const value of ["1", "8", "16", "4"]) {
        await layer.evaluate((element, nextValue) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(element, nextValue);
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        }, value);
      }
    }
    const viewButtons = page.getByRole("button", { name: /^(Tool|Layer|3D)$/ });
    const count = await viewButtons.count();
    for (let index = 0; index < count; index += 1) await viewButtons.nth(index).click();
  });
  return { ...probe, renderer };
}

async function inspectThreeSurface(page, selector) {
  return page.evaluate((surfaceSelector) => {
    const root = document.querySelector(surfaceSelector);
    const marker = root?.getAttribute("data-voxelweave-renderer") ?? null;
    const canvas = root?.querySelector("canvas");
    let webgl2 = false;
    try { webgl2 = Boolean(canvas?.getContext("webgl2")); } catch { webgl2 = false; }
    return {
      selector: surfaceSelector,
      present: Boolean(root),
      marker,
      canvasPresent: Boolean(canvas),
      canvasWebgl2: webgl2,
      qualifies: marker === "three-r3f" && webgl2,
      contract: "data-voxelweave-renderer=three-r3f on the Design/Toolpath root plus a child WebGL2 canvas",
    };
  }, selector);
}

async function probeCapabilities(page) {
  return page.evaluate(() => {
    const started = performance.now();
    const canvas = document.createElement("canvas");
    let gl = null;
    try { gl = canvas.getContext("webgl2"); } catch { gl = null; }
    let renderer = null;
    if (gl) {
      const extension = gl.getExtension("WEBGL_debug_renderer_info");
      if (extension) renderer = gl.getParameter(extension.UNMASKED_RENDERER_WEBGL);
    }
    return {
      probeMs: performance.now() - started,
      webgl2Supported: Boolean(gl),
      webgl2Renderer: renderer,
      productRenderer: {
        canvas2d: document.querySelectorAll("canvas").length > 0,
        svg: document.querySelectorAll("svg").length > 0,
        r3fDetected: Boolean(document.querySelector('[data-voxelweave-renderer="three-r3f"]')),
      },
      nativeWebKitMeasured: false,
      instrumentsMeasured: false,
    };
  });
}

function gatherLongTasks(probes) {
  return probes.flatMap((probe) => Array.isArray(probe.longTasks) ? probe.longTasks : []);
}

async function runIteration(browser, url, iteration, browserLogs) {
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 }, serviceWorkers: "block" });
  await context.addInitScript({ content: LONG_TASK_INIT_SCRIPT });
  const page = await context.newPage();
  page.on("console", (message) => browserLogs.push(`[iteration ${iteration}] console.${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => browserLogs.push(`[iteration ${iteration}] pageerror: ${error.message}`));
  const first = await firstMeaningfulWorkspace(page, url);
  await page.getByTestId("open-synthetic-project").click();
  const capabilities = await probeCapabilities(page);
  const dicom = await measureDicom(page);
  const design = await measureDesign(page);
  const toolpath = await measureToolpath(page);
  const perfState = await page.evaluate(() => ({ probes: window.__voxelweaveUiPerf?.probes ?? [], longTasks: window.__voxelweaveUiPerf?.longTasks ?? [] }));
  await context.close();
  return { iteration, first, capabilities, probes: { dicom, design, toolpath }, perfState };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const budget = await loadJson(args.budgetPath);
  const distIndex = path.join(desktopRoot, "dist", "index.html");
  try { await readFile(distIndex); } catch { throw new Error(`production desktop bundle is missing: ${distIndex}; run pnpm --dir apps/desktop run build first`); }
  await mkdir(args.outputDir, { recursive: true });
  const serverLogPath = path.join(args.outputDir, "vite-preview.log");
  const browserLogPath = path.join(args.outputDir, "browser-console.log");
  const browserLogs = [];
  let preview;
  let browser;
  let evidence;
  try {
    preview = await startPreview(args.port, serverLogPath);
    const desktopRequire = createRequireForDesktop();
    let playwright;
    try { playwright = desktopRequire("@playwright/test"); } catch (error) { throw new Error(`@playwright/test is unavailable from apps/desktop; run pnpm run setup (${error.message})`); }
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=swiftshader"],
    });
    const url = `${preview.url}/`;
    for (let warmup = 0; warmup < args.warmups; warmup += 1) {
      const context = await browser.newContext({ viewport: { width: 1536, height: 1024 }, serviceWorkers: "block" });
      await context.addInitScript({ content: LONG_TASK_INIT_SCRIPT });
      const page = await context.newPage();
      await firstMeaningfulWorkspace(page, url);
      await context.close();
    }
    const iterations = [];
    for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
      iterations.push(await runIteration(browser, url, iteration, browserLogs));
    }
    const firstValues = iterations.map((item) => item.first.performanceNowMs);
    const dicomValues = iterations.map((item) => item.probes.dicom.p95FrameMs);
    const designValues = iterations.map((item) => item.probes.design.p95FrameMs);
    const toolpathValues = iterations.map((item) => item.probes.toolpath.p95FrameMs);
    const longTaskValues = iterations.flatMap((item) => gatherLongTasks(item.probes ? [item.probes.dicom, item.probes.design, item.probes.toolpath] : [] )).map((task) => task.duration);
    const capabilities = iterations[iterations.length - 1].capabilities;
    const designRenderer = iterations[iterations.length - 1].probes.design.renderer;
    const toolpathRenderer = iterations[iterations.length - 1].probes.toolpath.renderer;
    const metrics = {
      first_workspace_render_ms: aggregate(firstValues, budget.metrics.first_workspace_render_ms),
      dicom_mpr_interaction_p95_frame_ms: aggregate(dicomValues, budget.metrics.dicom_mpr_interaction_p95_frame_ms),
      design_geometry_interaction_p95_frame_ms: aggregate(designValues, budget.metrics.design_geometry_interaction_p95_frame_ms),
      toolpath_interaction_p95_frame_ms: aggregate(toolpathValues, budget.metrics.toolpath_interaction_p95_frame_ms),
      main_thread_long_task_max_ms: aggregate(longTaskValues.length ? longTaskValues : [0], budget.metrics.main_thread_long_task_max_ms),
      webgl2_probe_ms: aggregate(iterations.map((item) => item.capabilities.probeMs), budget.metrics.webgl2_probe_ms),
    };
    const failures = allGateFailures(metrics);
    if (!capabilities.webgl2Supported) failures.push("webgl2: Chromium could not create a WebGL2 context");
    if (!designRenderer.qualifies) failures.push("design renderer: expected data-voxelweave-renderer=three-r3f with a child WebGL2 canvas");
    if (!toolpathRenderer.qualifies) failures.push("toolpath renderer: expected data-voxelweave-renderer=three-r3f with a child WebGL2 canvas");
    evidence = {
      schemaVersion: "voxelweave.desktop-ui-performance.v1",
      status: failures.length ? "failed" : "passed",
      gate: "production-web-bundle-chromium-browser-adapter",
      generatedAt: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch, node: process.version },
      configuration: { iterations: args.iterations, warmups: args.warmups, viewport: { width: 1536, height: 1024 }, url, budget: path.relative(root, args.budgetPath) },
      adapter: { mode: "synthetic-browser-test", nativeTauriRuntime: false, exactNativePayloadContract: "covered by scripts/check-native-adapter-contract.py" },
      rendererFacts: {
        chromiumWebgl2: capabilities,
        design: designRenderer,
        toolpath: toolpathRenderer,
        nativeWebKitMeasured: false,
        instrumentsMeasured: false,
        limitation: "The gate requires explicit three-r3f markers and a child WebGL2 canvas on Design and Toolpath roots. It records Chromium WebGL2 evidence but does not claim native WebKit or Instruments qualification.",
      },
      metrics,
      iterations,
      failures,
      limitations: [
        "Browser-adapter evidence is not native Tauri/WebKit evidence.",
        "WebGL2 is probed with a temporary capability canvas; Design and Toolpath must provide the explicit three-r3f marker contract before this gate can pass.",
        "Native WebKit frame pacing, GPU memory, and Instruments main-thread traces require a packaged-app profiling run.",
        "Synthetic fixtures do not establish performance for clinical DICOM series or physical print fidelity.",
      ],
    };
  } finally {
    await writeFile(browserLogPath, `${browserLogs.join("\n")}${browserLogs.length ? "\n" : ""}`, "utf8");
    if (browser) await browser.close();
    if (preview && !args.keepServer) {
      killProcessTree(preview.child);
      await sleepMs(100);
      closeSync(preview.logFd);
    }
  }
  if (!evidence) throw new Error("UI benchmark produced no evidence");
  await writeFile(path.join(args.outputDir, "ui-performance.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: evidence.status, output: path.join(args.outputDir, "ui-performance.json"), failures: evidence.failures, webgl2: evidence.rendererFacts.chromiumWebgl2 }, null, 2));
  if (evidence.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(`desktop UI performance gate failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
