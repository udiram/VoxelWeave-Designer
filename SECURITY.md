# Security policy

VoxelWeave Designer is research software, not a clinical system. It does not make diagnostic, treatment, or automatic patient-specific decisions, and this repository makes no clinical safety or regulatory claim.

## Supported security boundary

Reports are welcome for vulnerabilities in this repository's source, build scripts, release artifacts, local document handling, authentication boundary, or release API. Report security details through the repository's configured private security channel or directly to the maintainers. Do not put exploit details, credentials, PHI, raw DICOM, or private release material in a public issue. If a private channel is not configured, contact the maintainers first with a minimal description and no sensitive attachment.

Include the affected commit or release, platform, reproduction steps using synthetic data, impact, and a proposed mitigation when known. Please allow time for coordinated remediation before public disclosure.

## Security expectations

- Secrets belong in the macOS Keychain, CI secret storage, or Railway secret storage. They must not be placed in project documents, browser storage, logs, or release evidence.
- The Tauri sidecar exposes bounded, versioned operations. It must never become an arbitrary shell-execution bridge.
- This release stores no printer-service credentials and performs no printer upload. The application never starts a printer automatically.
- Logs and exported evidence redact patient fields and should contain identifiers only when the operator has deliberately supplied a non-PHI run label.
- The public site and release API should expose release metadata and checksums, not raw DICOM, patient data, signing material, or local filesystem paths.
- Release evidence records whether signing and notarization happened; development prereleases must not imply notarization.

## Out of scope

Physical printer safety, deposited geometry, material behavior, CT scanner operation, clinical interpretation, and the accuracy of unvalidated calibration data are not established by a software security review. Follow the [validation boundary](docs/VALIDATION.md) and the physical procedures approved by the responsible lab.
