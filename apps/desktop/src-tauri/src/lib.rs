use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;
use tauri::{Emitter, Manager, RunEvent, State};

const MAX_JSONL_BYTES: usize = 256 * 1024;
const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_JSON_DEPTH: usize = 12;
const MAX_ARRAY_ITEMS: usize = 4096;
const MAX_STRING_BYTES: usize = 64 * 1024;
const SIDECAR_RESPONSE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PROGRESS_EVENT: &str = "voxelweave://sidecar-progress";

#[derive(Clone)]
struct ManagedProcess {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
}

struct SidecarManager {
    process: Mutex<Option<ManagedProcess>>,
    pending: Arc<Mutex<HashMap<String, Sender<Result<Value, String>>>>>,
    authorized_paths: Mutex<HashSet<PathBuf>>,
    cache_paths: Mutex<HashSet<PathBuf>>,
}

impl Default for SidecarManager {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            authorized_paths: Mutex::new(HashSet::new()),
            cache_paths: Mutex::new(HashSet::new()),
        }
    }
}

fn canonical_existing(path: &PathBuf) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("selected paths must be absolute".to_string());
    }
    std::fs::canonicalize(path).map_err(|error| format!("cannot authorize {}: {error}", path.display()))
}

fn authorized_path(manager: &SidecarManager, requested: &str, allow_missing_target: bool) -> Result<PathBuf, String> {
    let raw = PathBuf::from(requested);
    if !raw.is_absolute() {
        return Err("path must be absolute; choose it through the native dialog".to_string());
    }
    let canonical = if raw.exists() {
        std::fs::canonicalize(&raw).map_err(|error| format!("cannot resolve {}: {error}", raw.display()))?
    } else if allow_missing_target {
        let parent = raw.parent().ok_or_else(|| "path has no parent directory".to_string())?;
        let parent = std::fs::canonicalize(parent).map_err(|error| format!("cannot resolve {}: {error}", parent.display()))?;
        parent.join(raw.file_name().ok_or_else(|| "path has no file name".to_string())?)
    } else {
        return Err(format!("path does not exist: {}", raw.display()));
    };
    let guard = manager.authorized_paths.lock().map_err(|_| "authorized path state is poisoned".to_string())?;
    if guard.iter().any(|root| canonical == *root || canonical.starts_with(root)) {
        return Ok(canonical);
    }
    Err(format!("path is outside the user-authorized scope: {}", raw.display()))
}

fn authorize_path_impl(manager: &SidecarManager, path: &str) -> Result<String, String> {
    let raw = PathBuf::from(path);
    let canonical = if raw.exists() {
        canonical_existing(&raw)?
    } else {
        let parent = raw.parent().ok_or_else(|| "path has no parent directory".to_string())?;
        canonical_existing(&parent.to_path_buf())?
    };
    let mut guard = manager.authorized_paths.lock().map_err(|_| "authorized path state is poisoned".to_string())?;
    guard.insert(canonical.clone());
    Ok(raw.to_string_lossy().into_owned())
}

fn validate_bounded_value(value: &Value, depth: usize, location: &str) -> Result<(), String> {
    if depth > MAX_JSON_DEPTH {
        return Err(format!("{location} exceeds the maximum JSON nesting depth"));
    }
    match value {
        Value::String(text) => {
            if text.len() > MAX_STRING_BYTES {
                return Err(format!(
                    "{location} contains an oversized string; use a scoped artifact path"
                ));
            }
        }
        Value::Array(items) => {
            if items.len() > MAX_ARRAY_ITEMS {
                return Err(format!(
                    "{location} contains too many array items; use a scoped binary artifact"
                ));
            }
            for (index, item) in items.iter().enumerate() {
                validate_bounded_value(item, depth + 1, &format!("{location}[{index}]"))?;
            }
        }
        Value::Object(map) => {
            for (key, item) in map {
                validate_bounded_value(
                    &Value::String(key.clone()),
                    depth + 1,
                    &format!("{location}.key"),
                )?;
                validate_bounded_value(item, depth + 1, &format!("{location}.{key}"))?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

fn validate_control_request(request: &Value) -> Result<(String, String), String> {
    let encoded = serde_json::to_vec(request)
        .map_err(|error| format!("cannot encode control request: {error}"))?;
    if encoded.len() > MAX_JSONL_BYTES {
        return Err("control request exceeds the bounded JSONL line limit".to_string());
    }
    let object = request
        .as_object()
        .ok_or_else(|| "control request must be a JSON object".to_string())?;
    if object.get("protocol").and_then(Value::as_str) != Some("voxelweave.control.v1") {
        return Err("unsupported control protocol".to_string());
    }
    let request_id = object
        .get("request_id")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && !value.contains('\r')
                && !value.contains('\n')
                && value.len() <= 128
        })
        .ok_or_else(|| {
            "request_id must be a non-empty single-line value of at most 128 bytes".to_string()
        })?
        .to_string();
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| "control request operation is required".to_string())?
        .to_string();
    let supported = [
        "inspect_dicom_source",
        "select_dicom_series",
        "build_volume_cache",
        "request_mpr_plane",
        "request_volume_preview",
        "sample_voxel",
        "calculate_histogram",
        "create_print_selection",
        "validate_scene",
        "generate_toolpath",
        "reverse_audit_gcode",
        "export_run_package",
        "verify_scan_back",
        "cancel",
    ];
    if !supported.contains(&operation.as_str()) {
        return Err(format!("unsupported sidecar operation: {operation}"));
    }
    let payload = object
        .get("payload")
        .ok_or_else(|| "control request payload is required".to_string())?;
    if !payload.is_object() {
        return Err("control request payload must be a JSON object".to_string());
    }
    validate_bounded_value(payload, 0, "payload")?;
    Ok((request_id, operation))
}

fn authorize_payload_paths(manager: &SidecarManager, value: &Value, location: &str) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if let Some(path) = child.as_str() {
                    if matches!(key.as_str(), "source" | "scan_back_source" | "source_path" | "sourcePath" | "directory" | "output_path") {
                        if path.starts_with("synthetic://") {
                            return Err("native sidecar rejects synthetic sources; choose a local path".to_string());
                        }
                        let allow_missing = matches!(key.as_str(), "directory" | "output_path");
                        authorized_path(manager, path, allow_missing).map_err(|error| format!("{location}.{key}: {error}"))?;
                    }
                }
                authorize_payload_paths(manager, child, &format!("{location}.{key}"))?;
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                authorize_payload_paths(manager, child, &format!("{location}[{index}]"))?;
            }
        }
        Value::String(_) | Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

fn sidecar_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(configured) = std::env::var("VOXELWEAVE_SIDECAR_PATH") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return std::fs::canonicalize(&path).map_err(|error| format!("cannot resolve sidecar path: {error}"));
        }
        return Err(format!(
            "VOXELWEAVE_SIDECAR_PATH does not point to a file: {}",
            path.display()
        ));
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("cannot resolve Tauri resource directory: {error}"))?;
    for resource in [
        resource_dir.join("voxelweave-sidecar"),
        resource_dir.join("resources/voxelweave-sidecar"),
    ] {
        if resource.is_file() {
            return Ok(resource);
        }
    }
    let development =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/voxelweave-sidecar");
    if development.is_file() {
        return Ok(development);
    }
    Err(format!(
        "bundled voxelweave-sidecar is missing below {} (build it with scripts/build-sidecar.sh)",
        resource_dir.display()
    ))
}

fn drain_stderr(stderr: impl Read + Send + 'static) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            line.clear();
        }
    });
}

fn fail_pending(
    pending: &Arc<Mutex<HashMap<String, Sender<Result<Value, String>>>>>,
    message: String,
) {
    let mut guard = match pending.lock() {
        Ok(value) => value,
        Err(_) => return,
    };
    let waiting = std::mem::take(&mut *guard);
    drop(guard);
    for (_, sender) in waiting {
        let _ = sender.send(Err(message.clone()));
    }
}

fn read_sidecar_output(
    app: tauri::AppHandle,
    stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<String, Sender<Result<Value, String>>>>>,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    fail_pending(
                        &pending,
                        "voxelweave-sidecar exited before completing the request".to_string(),
                    );
                    break;
                }
                Ok(_) => {
                    if line.len() > MAX_JSONL_BYTES {
                        fail_pending(
                            &pending,
                            "voxelweave-sidecar emitted an oversized JSONL line".to_string(),
                        );
                        continue;
                    }
                    let value: Value = match serde_json::from_str(line.trim_end()) {
                        Ok(value) => value,
                        Err(error) => {
                            fail_pending(
                                &pending,
                                format!("voxelweave-sidecar emitted invalid JSON: {error}"),
                            );
                            continue;
                        }
                    };
                    if value.get("protocol").and_then(Value::as_str)
                        == Some("voxelweave.progress.v1")
                    {
                        let _ = app.emit(PROGRESS_EVENT, value);
                        continue;
                    }
                    let request_id = value
                        .get("request_id")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    if let Some(request_id) = request_id {
                        if let Ok(mut guard) = pending.lock() {
                            if let Some(sender) = guard.remove(&request_id) {
                                let _ = sender.send(Ok(value));
                            }
                        }
                    }
                }
                Err(error) => {
                    fail_pending(
                        &pending,
                        format!("cannot read voxelweave-sidecar output: {error}"),
                    );
                    break;
                }
            }
        }
    });
}

fn ensure_process(
    app: &tauri::AppHandle,
    manager: &SidecarManager,
) -> Result<ManagedProcess, String> {
    let mut slot = manager
        .process
        .lock()
        .map_err(|_| "sidecar process state is poisoned".to_string())?;
    if let Some(process) = slot.as_ref() {
        let running = process
            .child
            .lock()
            .map_err(|_| "sidecar child state is poisoned".to_string())?
            .try_wait()
            .map_err(|error| format!("cannot inspect sidecar process: {error}"))?
            .is_none();
        if running {
            return Ok(process.clone());
        }
        *slot = None;
    }

    let executable = sidecar_path(app)?;
    let mut child = Command::new(&executable)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot start {}: {error}", executable.display()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "sidecar stdin was not available".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout was not available".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        drain_stderr(stderr);
    }
    let process = ManagedProcess {
        stdin: Arc::new(Mutex::new(stdin)),
        child: Arc::new(Mutex::new(child)),
    };
    read_sidecar_output(app.clone(), stdout, Arc::clone(&manager.pending));
    *slot = Some(process.clone());
    Ok(process)
}

fn wait_for_response(
    receiver: Receiver<Result<Value, String>>,
    request_id: &str,
) -> Result<Value, String> {
    match receiver.recv_timeout(SIDECAR_RESPONSE_TIMEOUT) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(error),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("sidecar request {request_id} timed out"))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("sidecar response channel disconnected".to_string())
        }
    }
}

#[tauri::command]
fn sidecar_request(
    app: tauri::AppHandle,
    state: State<'_, SidecarManager>,
    request: Value,
) -> Result<Value, String> {
    let (request_id, _operation) = validate_control_request(&request)?;
    if let Some(payload) = request.get("payload") {
        authorize_payload_paths(&state, payload, "payload")?;
        if let Some(directory) = payload.get("directory").and_then(Value::as_str) {
            let path = authorized_path(&state, directory, true)?;
            if let Ok(mut cache_paths) = state.cache_paths.lock() { cache_paths.insert(path); }
        }
    }
    let process = ensure_process(&app, &state)?;
    let (sender, receiver) = mpsc::channel();
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "sidecar pending state is poisoned".to_string())?;
        pending.insert(request_id.clone(), sender);
    }
    let encoded = serde_json::to_vec(&request)
        .map_err(|error| format!("cannot encode sidecar request: {error}"))?;
    let write_result = {
        let mut stdin = process
            .stdin
            .lock()
            .map_err(|_| "sidecar stdin state is poisoned".to_string())?;
        stdin
            .write_all(&encoded)
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
    };
    if let Err(error) = write_result {
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&request_id);
        }
        return Err(format!("cannot write sidecar request: {error}"));
    }
    wait_for_response(receiver, &request_id)
}

#[tauri::command]
fn authorize_path(state: State<'_, SidecarManager>, path: String) -> Result<String, String> {
    authorize_path_impl(&state, &path)
}

#[tauri::command]
fn save_voxelweave_document(state: State<'_, SidecarManager>, path: String, document: Value) -> Result<(), String> {
    let target = authorized_path(&state, &path, true)?;
    if target.extension().and_then(|value| value.to_str()) != Some("voxelweave") {
        return Err("project documents must use the .voxelweave extension".to_string());
    }
    validate_bounded_value(&document, 0, "document")?;
    let encoded = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("cannot encode project document: {error}"))?;
    if encoded.len() > MAX_DOCUMENT_BYTES {
        return Err("project document exceeds the bounded document size".to_string());
    }
    std::fs::write(&target, encoded)
        .map_err(|error| format!("cannot write {}: {error}", target.display()))
}

#[tauri::command]
fn open_voxelweave_document(state: State<'_, SidecarManager>, path: String) -> Result<Value, String> {
    let target = authorized_path(&state, &path, false)?;
    if target.extension().and_then(|value| value.to_str()) != Some("voxelweave") {
        return Err("project documents must use the .voxelweave extension".to_string());
    }
    let metadata = std::fs::metadata(&target)
        .map_err(|error| format!("cannot inspect {}: {error}", target.display()))?;
    if metadata.len() as usize > MAX_DOCUMENT_BYTES {
        return Err("project document exceeds the bounded document size".to_string());
    }
    let encoded = std::fs::read_to_string(&target)
        .map_err(|error| format!("cannot read {}: {error}", target.display()))?;
    let document: Value = serde_json::from_str(&encoded)
        .map_err(|error| format!("project document is not valid JSON: {error}"))?;
    validate_bounded_value(&document, 0, "document")?;
    Ok(document)
}

#[tauri::command]
fn read_authorized_text_file(state: State<'_, SidecarManager>, path: String) -> Result<String, String> {
    let target = authorized_path(&state, &path, false)?;
    let metadata = std::fs::metadata(&target)
        .map_err(|error| format!("cannot inspect {}: {error}", target.display()))?;
    if metadata.len() as usize > MAX_DOCUMENT_BYTES {
        return Err("calibration profile exceeds the bounded document size".to_string());
    }
    std::fs::read_to_string(&target)
        .map_err(|error| format!("cannot read {}: {error}", target.display()))
}

fn shutdown_sidecar_process(state: &SidecarManager) -> Result<(), String> {
    let mut process = state
        .process
        .lock()
        .map_err(|_| "sidecar process state is poisoned".to_string())?;
    if let Some(process) = process.take() {
        if let Ok(mut child) = process.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    let cache_paths = state.cache_paths.lock().map_err(|_| "cache path state is poisoned".to_string())?.drain().collect::<Vec<_>>();
    for path in cache_paths {
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(path);
        } else if path.is_file() {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

#[tauri::command]
fn sidecar_shutdown(state: State<'_, SidecarManager>) -> Result<(), String> {
    shutdown_sidecar_process(&state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(SidecarManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            sidecar_request,
            sidecar_shutdown,
            authorize_path,
            save_voxelweave_document,
            open_voxelweave_document,
            read_authorized_text_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building VoxelWeave Designer");
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            let state = app_handle.state::<SidecarManager>();
            let _ = shutdown_sidecar_process(&state);
        }
    });
}
