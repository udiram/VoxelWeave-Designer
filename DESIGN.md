# VoxelWeave Designer Design System

## Direction

VoxelWeave Designer should feel like a native macOS fabrication instrument used in a bright medical-physics lab: clinical white working surfaces, graphite instrument chrome, measured burnt-sienna focus cues, and dark imaging canvases only where CT or toolpath data requires them. It is precise, calm, material, and candid.

The desktop workspace is the product. The public site shows the real workspace, its evidence chain, and its release artifacts without surrounding them with generic SaaS decoration.

## Accepted Concept References

- `design/concepts/palette-board.png` — palette, compact typography, control geometry, table and warning treatment.
- `design/concepts/desktop-dicom-workspace.png` — primary desktop shell, four-pane viewer, series rail, print-selection inspector, and evidence status bar.
- `design/concepts/desktop-prepare-workspace.png` — exact toolpath canvas, layer rail, run checks, clipping block, estimates, and disabled audited-output state.
- `design/concepts/site-hero.png` — public header, product-first hero, CT workspace product render, calls to action, and first workflow preview.
- `design/concepts/site-workflow.png` — continuous physical fabrication bench and six connected workspaces.
- `design/concepts/site-release.png` — artifact table, DMG installation view, architecture receipt, evidence band, scientific boundary, and footer.

These images are composition references, not rasterized application UI. Product controls, labels, CT panes, tables, status, and interactions remain code-native. Generated imagery may be used only for the marketing product render or fabrication-bench treatment when it remains subordinate to real product screenshots.

## Palette

Use OKLCH tokens throughout.

```css
:root {
  --color-canvas: oklch(1 0 0);
  --color-chrome: oklch(0.965 0.004 40);
  --color-panel: oklch(0.985 0.002 40);
  --color-panel-strong: oklch(0.935 0.008 40);
  --color-ink: oklch(0.205 0.018 40);
  --color-muted: oklch(0.475 0.018 40);
  --color-subtle: oklch(0.655 0.012 40);
  --color-divider: oklch(0.865 0.008 40);
  --color-focus: oklch(0.5 0.151 40);
  --color-focus-hover: oklch(0.455 0.151 40);
  --color-focus-soft: oklch(0.94 0.03 40);
  --color-signal: oklch(0.36 0.095 190);
  --color-signal-soft: oklch(0.94 0.025 190);
  --color-warning: oklch(0.64 0.15 70);
  --color-warning-soft: oklch(0.96 0.035 70);
  --color-danger: oklch(0.49 0.18 28);
  --color-viewport: oklch(0.13 0.008 40);
  --color-viewport-ink: oklch(0.94 0.005 40);
}
```

Color strategy is Restrained in the desktop product and Committed only for public download actions and the graphite scientific-boundary band. Burnt sienna denotes focus, selection, and the primary action. Teal denotes verified or ready states. Amber denotes a warning requiring action. Never use color as decoration or as the sole carrier of state.

## Typography

Desktop UI uses the native macOS family: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`. The public site uses `Geist Sans` when bundled locally, falling back to the same native stack. Do not use a serif, display/typewriter contrast, or monospace as a technical costume. Monospace is reserved for checksums, file hashes, and console receipts.

Desktop type scale is fixed:

- App/project title: 15px/20px, 600.
- Workspace navigation: 13px/18px, 500.
- Inspector heading: 15px/20px, 600.
- Section heading: 13px/18px, 600.
- Body/control: 13px/18px, 400–500.
- Dense table/caption: 12px/16px.
- Status bar: 12px/16px.
- Tabular data uses `font-variant-numeric: tabular-nums`.

Public headings use a fluid but bounded scale with `letter-spacing` no tighter than `-0.035em`; the hero maximum is 80px. Body copy is 17–20px with a maximum measure of 68ch.

## Spacing and Geometry

Use a 4px base scale: 4, 8, 12, 16, 24, 32, 48, 64, 96.

- Desktop toolbar: 48–56px.
- Desktop left rail: 208–224px.
- Desktop right inspector: 296–320px.
- Status bar: 40–48px.
- Compact controls: 28–32px visual height with at least 44px touch/pointer hit area when isolated.
- Panel and control radius: 6–10px.
- Large marketing media frames: maximum 14px radius.
- Dividers: 1px; no accent side stripes thicker than 1px.
- Shadows are reserved for menus, dialogs, and the DMG window. Never pair a decorative wide shadow with a 1px border.

Desktop layout uses solid rails, divided panes, inspectors, tables, canvases, and status bars. Do not float the shell, round the sidebar exterior, nest cards, or convert data tables into card grids.

## Desktop Shell

The permanent top-level workspace order is Design, DICOM, Calibrate, Prepare, Send, Verify. The current workspace is marked with burnt-sienna icon/text and a restrained underline. The project title remains visible in the titlebar/toolbar. Utility settings, logs, and diagnostics stay secondary.

Every workspace uses:

- A contextual left rail for scene, source, plate, job, or evidence navigation.
- A dominant central canvas or task surface.
- A right inspector for the active selection and consequential action.
- A bottom evidence/status bar naming source resolution, preview mode, connection state, or automatic-print boundary.

## DICOM Workspace

Default center layout is an exact 2×2 grid: Axial, Sagittal, Coronal, 3D. MPR panes use dark viewports, grayscale images, anatomical labels, physical position, spacing, window/level, and synchronized burnt-sienna crosshairs. The 3D pane shows crop, selected slab, orthogonal planes, orientation cube, and explicit preview quality.

The left rail holds series selection and geometry status. The right inspector holds print orientation, single/range selection, start/end, physical thickness, output mode, crop, source/output dimensions, scale, and selection creation. Preview resolution and scientific-source resolution must appear simultaneously.

## Prepare Workspace

The exact toolpath canvas dominates. It shows generated segments, tools, width, flow, travel, anchors, layer selection, and emitted ordering. The right inspector lists deterministic checks as rows, not status cards. Blocking clipping or flow findings interrupt the list at their source and disable audited-output generation until acknowledged or resolved.

## States and Feedback

Every interactive component requires default, hover, focus-visible, active, disabled, loading, error, success, and overflow behavior. Loading uses progressive skeletons and named stages. Errors answer what happened, why it matters, and how to resolve it. Destructive actions name the object and consequence.

Use motion only to preserve context: pane maximize/restore, inspector selection change, crosshair synchronization, progress-stage transitions, and layer/toolpath updates. Default duration is 150–220ms with ease-out-quart. Respect `prefers-reduced-motion` and never gate visible content behind animation.

## Website Structure

1. Compact header and product-first hero with download and GitHub actions.
2. Continuous source-to-scan workflow using real app screenshots and a physical fabrication-bench motif.
3. Evidence and release section with a real artifact table, checksum copy actions, installation guide, architecture receipt, and current test evidence.
4. Graphite scientific-boundary band and restrained footer.

The public page must not add testimonials, pricing, customer logos, fake adoption metrics, waitlist copy, or roadmap promises. The real release and its evidence are the proof.

## Icons and Visualization

Use one coherent line-icon family with 1.5–1.75px strokes, round caps/joins only where the concept shows them, and 16–20px optical sizes. Orientation cubes, crop glyphs, crosshairs, plane glyphs, and toolpath symbols may use small custom SVGs when a generic icon would change meaning.

CT images, 3D volume, geometry, and toolpaths are product visualizations. They must be generated from real or deterministic synthetic data in the application—not decorative raster placeholders.

## Responsive Behavior

Desktop application minimum usable viewport is 1180×720. At narrower widths, right inspector becomes a sheet/drawer and the left rail collapses to a rail with an explicit reveal control. Pane maximize remains available. Do not stack four MPR panes into an unusable page.

The public site supports 1440+, 1024, 768, 390, and 320px widths. On mobile, the hero product image follows copy and actions; the workflow becomes a horizontal snap rail or ordered open list with preserved visual screenshots; artifact tables permit horizontal scroll with a fixed first column. Touch targets are at least 44×44px.

## Accessibility

- Body text contrast is at least 4.5:1; primary text targets 7:1.
- Focus indicators are 2px burnt-sienna with adequate offset and never color-only.
- Pane state, tool visibility, run checks, and warnings have icons/text in addition to color.
- All canvas functions have keyboard-reachable equivalents and textual status.
- Screen readers receive the current crosshair coordinate, HU, active pane, selected range, progress stage, and blocking check through polite live regions.
- Reduced motion, high contrast, keyboard-only, VoiceOver, and 200% zoom are release checks.

## Absolute Bans

No glassmorphism, gradients, gradient text, glows, fake charts, metric-card grids, nested cards, floating rounded sidebars, oversized radii, hero sections inside the desktop app, repeated eyebrows, numbered decorative section markers, decorative status dots, blue-dominant dark SaaS styling, serif marketing shortcut, patient identifiers, diagnostic claims, automatic print-start controls, or language implying that software inspection proves physical fidelity.

