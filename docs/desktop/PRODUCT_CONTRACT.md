# VoxelWeave Designer Desktop Product Contract

This contract defines the v1 desktop product. It is normative for implementation and tests.

## Identity and Documents

- Product name: VoxelWeave Designer.
- Document extension: `.voxelweave`.
- Platform: macOS 14 or newer on Apple Silicon only.
- Shell: Tauri 2 with a React 19 and TypeScript interface.
- A project may contain modeled geometry, one DICOM-derived printable object, or both.
- Raw identifiable DICOM is not embedded in the document by default. The document stores authorized source references, derived cache identity, transforms, selections, calibrations, evidence references, and hashes.

## Workspaces

The permanent navigation order is Design, DICOM, Calibrate, Prepare, Send, Verify. DICOM remains separate from Design because its series, MPR, physical-coordinate, and print-selection workflow is materially different from modeling.

## DICOM Source and Preview Boundary

The scientific source is a full-resolution signed-HU volume maintained by the Python sidecar and binary cache. Preview pyramids, MPR textures, and GPU volume textures are derived views. Their resolution or interpolation may not affect generated scientific output.

Series handling must group by SeriesInstanceUID, sort by projected ImagePositionPatient, validate orientation/spacing/continuity, exclude non-image and ineligible objects, redact patient fields from normal logs, and emit specific errors for unsupported geometry.

## Orthogonal Printing

Supported print planes are axial, sagittal, and coronal. Arbitrary oblique and curved planar printing are excluded from v1.

Selection types:

- Single plane: one physical source plane repeated through a configured print thickness.
- Continuous range: an inclusive physical slab mapped continuously to printer Z and resampled at every printer-layer center.
- Tile range: selected planes, optionally strided, become separately removable tiles laid out over one or more plates.

Continuous output never inserts artificial solid faces at source-slice boundaries and never treats one DICOM slice as one printer layer. Tile labels, notches, tabs, anchors, and spacing are structural regions outside the calibrated measurement region.

Crop bounds are stored in physical patient coordinates and synchronized across all MPR panes and the 3D crop box. Physical aspect ratio is locked by default. The run report records the complete source-to-print transform and resampling method. A single-plane transform has a zero normal-axis column and translates to the selected source plane. Tile output records one such matrix per tile/source index because a set of independently placed planes cannot be represented by one affine matrix.

## Geometry and Regions

Design supports boxes, cylinders, wedges, regular-polygon prisms, polygon extrusions, transforms, snapping, alignment, grouping, union, subtraction, intersection, and STL/3MF import with 3MF preferred. Imported topology is previewed interactively, but canonical generation reads the explicitly authorized local mesh file directly and records its SHA-256; large mesh arrays are never embedded in the bounded JSON control channel or saved project document.

The scene tree preserves Boolean operands. Occupied solid and material/tool ownership are separate concepts. DICOM-derived material, structural supports, fixtures, frames, bases, and inserts remain explicitly owned regions. Ambiguous overlap blocks slicing.

Modeled objects use the Designer scene frame in millimetres. Combined DICOM/model runs center the DICOM print selection on the Designer origin and record the exact scene-to-print transform in the run report; the selection manifest independently records the complete source physical-coordinate transform. Modeled-only runs record the canonical scene-bounds translation.

## Calibration and Rail Field

Commanded rail width is the calibration independent variable. Pitch, layer height, flow, nozzle, tool, material, lot, printer, scanner, and reconstruction stay bound to the calibration. T0 0.25 mm Jessie natural/clear PLA and T1 0.4 mm Generic white PLA require separate accepted calibrations and a common layer height for combined prints.

The canonical rail-field query returns occupied state, DICOM source coordinate, source HU, clipped HU, region, tool, material, calibration, target HU, effective fill, commanded width, and range status. Sagittal and coronal selections resample the full source volume using the orientation matrix; they never use rendered MPR images.

## G-code and Preview

VoxelWeave emits alternating X/Y variable-width roads at a global layer height, obeying tool/material flow caps, speed and acceleration limits, minimum segment length, width-transition constraints, bed bounds, first-layer protection, and explicit multi-tool interface policy.

The run package contains plaintext G-code, run report, toolpath trace, DICOM selection manifest, source-to-print transform, exact generated-segment preview stream, and SHA-256 hashes. Final G-code is reverse-parsed and compared with the preview stream for coordinates, widths, tools, feedrates, extrusion, bounds, and wrapper identity.

Opening a saved project clears process-local generated/audited/exported/verification flags. If the document references local DICOM or mesh sources, the desktop app lists their count and requires an explicit reauthorization confirmation for the new session before those paths are made available to the sidecar. Generation then reconstructs the persisted DICOM selection from its normalized fields, preventing stale cross-project engine state.

## Send and Verify

Send supports local, inspectable run-package export. Printer-service upload is not included in this release, and the app never automatically starts a printer.

Verify imports scan-back data, records registration method and confidence, preserves raw and transformed evidence, and exports inspectable comparisons. HU gamma remains distinct from dose gamma. No software state can claim deposited width or physical HU fidelity without accepted physical calibration and scan-back evidence.

## Release Boundary

The release contains only Apple Silicon `.app`, DMG, and native sidecar artifacts. Architecture inspection fails for Intel-only or unexpected universal components. The app must launch without Homebrew, system Python, Node, or Rosetta installed.
