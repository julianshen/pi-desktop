use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::{self, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub status: SaveStatus,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SaveStatus {
    Saved,
    Cancelled,
}

#[derive(Debug, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum SaveError {
    InvalidId(String),
    SourceMissing(String),
    SourceUnsafe(String),
    DestinationInvalid(String),
    WriteFailed(String),
    DialogFailed(String),
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn safe_scheduled_id(value: &str) -> bool {
    value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value.bytes().skip(1).all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-' || byte == b'_'
        })
}

fn safe_file_name(value: &str) -> String {
    value
        .rsplit(['/', '\\'])
        .next()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("generated-file")
        .to_owned()
}

fn generated_root() -> Result<PathBuf, SaveError> {
    if let Ok(data_dir) = std::env::var("PI_DESKTOP_DATA_DIR") {
        return Ok(PathBuf::from(data_dir).join("generated-files"));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| SaveError::SourceMissing("app data directory is unavailable".into()))?;
    Ok(PathBuf::from(home)
        .join(".pi-desktop")
        .join("data")
        .join("generated-files"))
}

fn data_root() -> Result<PathBuf, SaveError> {
    if let Ok(data_dir) = std::env::var("PI_DESKTOP_DATA_DIR") {
        return Ok(PathBuf::from(data_dir));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| SaveError::SourceMissing("app data directory is unavailable".into()))?;
    Ok(PathBuf::from(home).join(".pi-desktop").join("data"))
}

fn resolve_candidate(root: &Path, source: PathBuf) -> Result<PathBuf, SaveError> {
    let metadata = fs::symlink_metadata(&source)
        .map_err(|_| SaveError::SourceMissing("generated file is no longer available".into()))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(SaveError::SourceUnsafe(
            "generated file source is not a regular file".into(),
        ));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|_| SaveError::SourceMissing("generated file store is unavailable".into()))?;
    let canonical_source = source
        .canonicalize()
        .map_err(|_| SaveError::SourceMissing("generated file is no longer available".into()))?;
    if !canonical_source.starts_with(&canonical_root) {
        return Err(SaveError::SourceUnsafe(
            "generated file escaped app storage".into(),
        ));
    }
    Ok(canonical_source)
}

fn resolve_source(
    root: &Path,
    conversation_id: &str,
    run_id: &str,
    file_id: &str,
) -> Result<PathBuf, SaveError> {
    for value in [conversation_id, run_id, file_id] {
        if !safe_id(value) {
            return Err(SaveError::InvalidId(
                "generated-file identifier is invalid".into(),
            ));
        }
    }

    resolve_candidate(root, root.join(conversation_id).join(run_id).join(file_id))
}

fn resolve_scheduled_source(
    root: &Path,
    task_id: &str,
    run_id: &str,
    file_id: &str,
) -> Result<PathBuf, SaveError> {
    for value in [task_id, run_id, file_id] {
        if !safe_scheduled_id(value) {
            return Err(SaveError::InvalidId(
                "scheduled-file identifier is invalid".into(),
            ));
        }
    }
    resolve_candidate(
        root,
        root.join(task_id).join(run_id).join("files").join(file_id),
    )
}

fn atomic_copy(source: &Path, destination: &Path) -> Result<(), SaveError> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| SaveError::DestinationInvalid("save destination has no parent".into()))?;
    if !parent.is_dir() {
        return Err(SaveError::DestinationInvalid(
            "save destination directory is unavailable".into(),
        ));
    }

    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SaveError::DestinationInvalid("save destination name is invalid".into()))?;
    let temp = parent.join(format!(
        ".{file_name}.pi-desktop-{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let result = (|| -> Result<(), SaveError> {
        let input =
            fs::File::open(source).map_err(|error| SaveError::SourceMissing(error.to_string()))?;
        let output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| SaveError::WriteFailed(error.to_string()))?;
        let mut reader = BufReader::new(input);
        let mut writer = BufWriter::new(output);
        io::copy(&mut reader, &mut writer)
            .map_err(|error| SaveError::WriteFailed(error.to_string()))?;
        writer
            .flush()
            .and_then(|_| writer.get_ref().sync_all())
            .map_err(|error| SaveError::WriteFailed(error.to_string()))?;
        replace_file(&temp, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn replace_file(temp: &Path, destination: &Path) -> Result<(), SaveError> {
    #[cfg(windows)]
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| SaveError::WriteFailed(error.to_string()))?;
    }

    fs::rename(temp, destination).map_err(|error| SaveError::WriteFailed(error.to_string()))
}

fn copy_if_allowed(
    source: &Path,
    destination: &Path,
    overwrite: bool,
) -> Result<SaveStatus, SaveError> {
    if destination.exists() && !overwrite {
        return Ok(SaveStatus::Cancelled);
    }
    atomic_copy(source, destination)?;
    Ok(SaveStatus::Saved)
}

fn save_interactive(
    app: AppHandle,
    conversation_id: String,
    run_id: String,
    file_id: String,
    file_name: String,
) -> Result<SaveResult, SaveError> {
    let source = resolve_source(&generated_root()?, &conversation_id, &run_id, &file_id)?;
    save_resolved_interactive(app, source, file_name)
}

fn save_resolved_interactive(
    app: AppHandle,
    source: PathBuf,
    file_name: String,
) -> Result<SaveResult, SaveError> {
    let selected = app
        .dialog()
        .file()
        .set_title("Save generated file")
        .set_file_name(safe_file_name(&file_name))
        .blocking_save_file();
    let Some(selected) = selected else {
        return Ok(SaveResult {
            status: SaveStatus::Cancelled,
        });
    };
    let destination = selected
        .into_path()
        .map_err(|error| SaveError::DialogFailed(error.to_string()))?;

    if destination.exists() {
        let confirmed = app
            .dialog()
            .message("A file already exists at the selected destination. Replace it?")
            .title("Confirm overwrite")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Replace".into(),
                "Cancel".into(),
            ))
            .blocking_show();
        if !confirmed {
            return Ok(SaveResult {
                status: SaveStatus::Cancelled,
            });
        }
    }

    let status = copy_if_allowed(&source, &destination, true)?;
    Ok(SaveResult { status })
}

#[tauri::command]
pub async fn save_generated_file(
    app: AppHandle,
    conversation_id: String,
    run_id: String,
    file_id: String,
    file_name: String,
) -> Result<SaveResult, SaveError> {
    tauri::async_runtime::spawn_blocking(move || {
        save_interactive(app, conversation_id, run_id, file_id, file_name)
    })
    .await
    .map_err(|error| SaveError::WriteFailed(error.to_string()))?
}

#[tauri::command]
pub async fn save_scheduled_run_file(
    app: AppHandle,
    task_id: String,
    run_id: String,
    file_id: String,
    file_name: String,
) -> Result<SaveResult, SaveError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = data_root()?.join("scheduler-runs");
        let source = resolve_scheduled_source(&root, &task_id, &run_id, &file_id)?;
        save_resolved_interactive(app, source, file_name)
    })
    .await
    .map_err(|error| SaveError::WriteFailed(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "pi-generated-files-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            uuid::Uuid::new_v4(),
        ));
        let root = base.join("generated-files");
        let source_dir = root.join("conversation").join("run");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("file");
        fs::write(&source, b"exact\0generated\nbytes").unwrap();
        let destination = base.join("saved.bin");
        (root, source, destination)
    }

    #[test]
    fn generated_files_exact_copy_is_atomic_and_id_scoped() {
        let (root, source, destination) = fixture();
        let resolved = resolve_source(&root, "conversation", "run", "file").unwrap();
        assert_eq!(resolved, source.canonicalize().unwrap());
        atomic_copy(&resolved, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"exact\0generated\nbytes");
        assert!(!fs::read_dir(destination.parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn generated_files_reject_traversal_and_symlinks() {
        let (root, _, _) = fixture();
        assert!(matches!(
            resolve_source(&root, "..", "run", "file"),
            Err(SaveError::InvalidId(_))
        ));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("file", root.join("conversation/run/link")).unwrap();
            assert!(matches!(
                resolve_source(&root, "conversation", "run", "link"),
                Err(SaveError::SourceUnsafe(_))
            ));
        }
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn generated_files_failed_write_leaves_existing_destination_unchanged_and_no_temp() {
        let (root, source, destination) = fixture();
        fs::create_dir(&destination).unwrap();
        let result = atomic_copy(&source, &destination);
        assert!(result.is_err());
        assert!(destination.is_dir());
        assert!(!fs::read_dir(destination.parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")));
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn generated_files_declined_overwrite_preserves_existing_bytes() {
        let (root, source, destination) = fixture();
        fs::write(&destination, b"keep me").unwrap();
        let status = copy_if_allowed(&source, &destination, false).unwrap();
        assert_eq!(status, SaveStatus::Cancelled);
        assert_eq!(fs::read(&destination).unwrap(), b"keep me");
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn generated_files_confirmed_overwrite_replaces_existing_bytes() {
        let (root, source, destination) = fixture();
        fs::write(&destination, b"old bytes").unwrap();
        let status = copy_if_allowed(&source, &destination, true).unwrap();
        assert_eq!(status, SaveStatus::Saved);
        assert_eq!(fs::read(&destination).unwrap(), b"exact\0generated\nbytes");
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn generated_file_suggestion_uses_only_the_human_readable_basename() {
        assert_eq!(safe_file_name("../../report.csv"), "report.csv");
        assert_eq!(safe_file_name(""), "generated-file");
    }

    #[test]
    fn scheduled_files_are_opaque_id_scoped_and_reject_traversal_or_symlinks() {
        let base =
            std::env::temp_dir().join(format!("pi-scheduled-files-{}", uuid::Uuid::new_v4()));
        let root = base.join("scheduler-runs");
        let files = root.join("task").join("run").join("files");
        fs::create_dir_all(&files).unwrap();
        let source = files.join("file");
        fs::write(&source, b"scheduled bytes").unwrap();
        assert_eq!(
            resolve_scheduled_source(&root, "task", "run", "file").unwrap(),
            source.canonicalize().unwrap()
        );
        let dotted_files = root.join("task.v1").join("run.v1").join("files");
        fs::create_dir_all(&dotted_files).unwrap();
        let dotted_source = dotted_files.join("file.v1");
        fs::write(&dotted_source, b"scheduled bytes").unwrap();
        assert_eq!(
            resolve_scheduled_source(&root, "task.v1", "run.v1", "file.v1").unwrap(),
            dotted_source.canonicalize().unwrap()
        );
        assert!(matches!(
            resolve_scheduled_source(&root, "..", "run", "file"),
            Err(SaveError::InvalidId(_))
        ));
        assert!(matches!(
            resolve_scheduled_source(&root, "-task", "run", "file"),
            Err(SaveError::InvalidId(_))
        ));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("file", files.join("link")).unwrap();
            assert!(matches!(
                resolve_scheduled_source(&root, "task", "run", "link"),
                Err(SaveError::SourceUnsafe(_))
            ));
        }
        fs::remove_dir_all(base).unwrap();
    }
}
