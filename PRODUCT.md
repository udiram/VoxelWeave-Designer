# VoxelWeave Designer

## Register

Product is the primary register. The desktop workspace is a scientific fabrication tool where design serves precision, traceability, and safe completion of a DICOM-to-print workflow. The public website uses a brand register while preserving the product's restrained, evidence-led voice.

## Platform

Web-based interface packaged as a native Apple Silicon macOS desktop application with Tauri 2. Minimum macOS 14. Public product website and health/download service deploy to Railway. No Intel, Windows, Linux, Rosetta, or universal-binary support in v1.

## Product

VoxelWeave Designer is a research-only desktop workspace for converting complete CT DICOM series and designer-created geometry into calibrated, auditable, multi-tool Prusa XL G-code. Projects are saved as `.voxelweave` documents.

The app joins six explicit workspaces:

- Design — primitives, imported solids, transforms, regions, and Boolean CSG.
- DICOM — complete-series import, synchronized axial/sagittal/coronal/3D viewing, crop and print selection.
- Calibrate — tool/material/scanner/reconstruction-specific rail-width-to-HU evidence.
- Prepare — exact toolpath preview, clipping, flow, bed, runtime, and safety checks.
- Send — local, inspectable run-package export; never automatic print start.
- Verify — scan-back registration, HU comparison, provenance, reports, and research conclusions.

## Target Users

- Medical physicists developing CT-equivalent 3D-printed phantoms.
- Imaging and radiation-therapy researchers evaluating fabrication methods.
- Technical operators preparing calibrated Prusa XL jobs under a validated protocol.
- Collaborators who need an inspectable run package without learning the engine internals.

These users are technically fluent but often operate under time pressure around valuable datasets, printer time, and physical materials. The interface must expose consequential assumptions without turning every screen into documentation.

## Core Promise

Move from a complete DICOM series or modeled solid to a deterministic, inspectable print package while preserving physical coordinates, calibration provenance, tool/material ownership, bidirectional source/print transforms, and the distinction between software evidence and physical validation.

## Scientific Contract

- Full-resolution signed HU data in the Python engine is the scientific source. Display pyramids and WebGL textures are previews only.
- DICOM geometry is interpreted from physical patient coordinates and orientation matrices, not filename order or rendered screenshots.
- Continuous-volume output samples the selected physical slab at printer-layer centers without inserting artificial slice interfaces.
- Tile output preserves each source plane's identity and keeps labels, tabs, anchors, and structural regions outside the calibrated measurement region.
- Commanded rail width controls effective fill. Calibration maps commanded width to measured HU while pitch and layer height remain calibration-locked.
- Tool, material, lot, printer, scanner, reconstruction, nozzle, flow, and layer-height mismatches fail closed or require explicit documented acknowledgment.
- A software audit, exact preview, or successful G-code generation never proves deposited geometry or physical HU fidelity. Calibration and scan-back evidence remain required.
- The product is non-diagnostic and must not be used for clinical interpretation or automatic patient-specific decisions.

## Primary Workflow

1. Create or open a `.voxelweave` project.
2. Import a complete DICOM source or build geometry in Design.
3. Inspect series validity and navigate synchronized MPR and 3D views.
4. Select axial, sagittal, or coronal single-plane, continuous-range, or tile-range output with a physical crop and scale.
5. Bind accepted tool/material calibrations and resolve any clipping or resolution warnings.
6. Generate and reverse-audit exact multi-tool G-code plus manifests, transforms, hashes, and a toolpath trace.
7. Export the local run package. Printing remains an attended external action.
8. Import scan-back data, register it with explicit confidence, compare results, and export a versioned verification package.

## Scope Boundaries

In v1: Apple Silicon macOS 14+, Tauri 2, React 19, TypeScript, Three.js/React Three Fiber, WebGL2, Manifold WASM, Python Manifold, the existing VoxelWeave scientific engine, complete DICOM series, four-pane MPR/3D, orthogonal printing, continuous and tiled output, designer primitives/imports/CSG, multi-tool calibration and G-code, local run-package export, and scan-back verification.

Out of v1: Intel or non-macOS builds, oblique printing, curved planar reformations, diagnostic interpretation, automatic anatomical segmentation, sculpting, STEP/B-rep CAD, automatic printer start, silent calibration extrapolation, and scientific conversion from preview data.

## Brand Personality

- Precise — dimensions, coordinates, provenance, and states are concrete.
- Calm — the tool supports long expert sessions without visual noise.
- Candid — warnings and evidence limits are visible and specific.
- Material — the interface acknowledges rails, plates, tools, polymer, CT acquisition, and physical failure modes.
- Assured — familiar macOS and professional-tool conventions; no experimental interaction for its own sake.

## Voice and Copy

Use plain, direct verbs: Import series, Build volume cache, Select slab, Generate toolpath, Export run package. Errors state what happened, why it matters, and how to resolve it. Avoid startup slogans, playful error copy, decorative technical jargon, and claims such as validated, accurate, safe, or production-ready unless the relevant evidence is present and named.

## Strategic Design Principles

1. The current task is unmistakable within two seconds; product chrome recedes behind the scientific workspace.
2. Preview resolution and scientific-source resolution are visually and verbally distinct everywhere.
3. Consequential warnings sit at the decision point and block unsafe progression; routine detail stays inspectable without dominating.
4. Spatial relationships are shown directly across MPR, 3D, crop, slab, bed, and toolpath views.
5. The same nouns, status vocabulary, controls, and geometry conventions persist across all six workspaces.
6. Use open canvas, rails, inspectors, tables, and divided panes rather than decorative cards or dashboard metrics.
7. The public site demonstrates the real product and evidence chain instead of promising future capability.

## Anti-References

- Generic dark SaaS control rooms with cyan glows, fake charts, and metric-card grids.
- Medical interfaces that imply diagnosis, certainty, or clinical authorization.
- CAD clones that hide scientific provenance behind a generic modeling canvas.
- Marketing pages built from repetitive feature cards, empty superlatives, or static screenshot placeholders.
- Over-rounded, glassy, animated shells that make precise controls feel soft or unstable.

## Success Criteria

- A user can complete the full synthetic DICOM workflow across all six workspaces and produce a deterministic audited run package.
- Axial, sagittal, and coronal selections share physical coordinates and remain synchronized with the 3D view and print transform.
- Preview-quality changes do not change generated scientific output.
- Desktop launch, cache, MPR, volume, geometry, and toolpath performance meet the documented Apple Silicon budgets or report measured exceptions honestly.
- Automated unit, integration, accessibility, responsive, desktop, packaging, and end-to-end tests pass.
- The public Railway site explains the product, exposes current release downloads and checksums, and clearly states research-only limits.
- GitHub contains reproducible source, CI, release automation, documentation, and downloadable Apple Silicon artifacts.
