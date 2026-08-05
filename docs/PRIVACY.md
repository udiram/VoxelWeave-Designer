# Privacy and data handling

VoxelWeave Designer is local-first. The desktop workflow keeps scientific source data, preview caches, project documents, and diagnostic exports on the operator's machine unless the operator deliberately exports or uploads a selected artifact.

## Default behavior

- Raw identifiable DICOM is not embedded in a `.voxelweave` document by default. The document stores authorized source references, derived cache identity, transforms, selections, calibration references, evidence references, and hashes.
- Full-resolution signed HU data remains in the Python engine and binary cache. Display pyramids, MPR textures, and WebGL textures are previews, not alternate scientific sources.
- Normal logs and release evidence redact patient fields. Use a non-identifying run label for exported reports.
- The application does not transmit telemetry to a vendor or analytics endpoint by default. Performance diagnostics are local and user-exportable.
- Optional Prusa Connect upload is an explicit authenticated operator action. Credentials belong in the macOS Keychain, not in a project or browser store.

## Operator responsibilities

Local-first is not the same as risk-free. Source paths, cache names, transforms, calibration identifiers, printer details, scan-back files, screenshots, crash logs, and release evidence may still identify a person, site, study, or machine. Store them according to the lab's approved data classification and access controls.

Before sharing a project or report, inspect it for patient fields, absolute paths, DICOM-derived labels, thumbnails, screenshots, printer identifiers, credentials, and embedded logs. Redact or replace them with synthetic data. Do not commit raw DICOM, `.voxelweave` documents, or local data directories; the repository ignore rules are a guardrail, not a data-governance policy.

## Network boundary

The public website and release API expose product and release information, not local source data. A future networked feature must document the data fields, consent/authorization, retention, authentication, and failure behavior before implementation. No telemetry, DICOM, or patient data should be added to a network request merely because a service is available.
