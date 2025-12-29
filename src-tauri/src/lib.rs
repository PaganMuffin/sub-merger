use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
// Dodajemy importy makr logowania
use tauri_plugin_log::log::{debug, error, info, warn};
use tauri_plugin_log::{Target, TargetKind};

#[derive(Clone, Serialize)]
struct ProgressUpdate {
    index: usize,
    percentage: f64,
    filename: String,
}

#[derive(Clone, Serialize)]
struct ProcessError {
    index: usize,
    error: String,
    filename: String,
}

#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

#[derive(Deserialize)]
struct ProbeOutput {
    format: ProbeFormat,
}

// Global cancellation flag
static CANCEL_FLAG: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn cancel_processing() {
    info!("User requested cancellation");
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn process_queue(
    app: tauri::AppHandle,
    videos: Vec<String>,
    subtitles: Vec<String>,
    fonts: Vec<String>,
    output_dir: String,
) -> Result<(), String> {
    info!("=== Starting process_queue ===");
    // Używamy debug! dla dużych struktur danych, aby nie zaśmiecać głównego logu
    debug!("Videos: {:?}", videos);
    debug!("Subtitles: {:?}", subtitles);
    debug!("Fonts: {:?}", fonts);
    info!("Output dir: {}", output_dir);

    // Reset cancel flag
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    for (index, (video, subtitle)) in videos.iter().zip(subtitles.iter()).enumerate() {
        info!("Processing video {} of {}", index + 1, videos.len());

        // Check if cancelled
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            warn!("Processing loop interrupted by user cancellation");
            return Err("Processing cancelled by user".to_string());
        }

        let filename = std::path::Path::new(video)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("output")
            .to_string();

        info!("Getting duration for: {}", video);
        // Get duration first
        let duration_us = match get_duration(&app, video).await {
            Ok(d) => {
                debug!("Got duration: {} microseconds", d);
                d
            }
            Err(e) => {
                error!("Failed to get duration for {}: {}", filename, e);
                app.emit(
                    "ffmpeg-error",
                    ProcessError {
                        index,
                        error: format!("Failed to get duration: {}", e),
                        filename: filename.clone(),
                    },
                )
                .ok();
                continue;
            }
        };

        // Build output path
        let output_path =
            std::path::Path::new(&output_dir).join(format!("{}_merged.mkv", filename));

        info!("Starting FFmpeg processing for: {}", filename);
        debug!("Output path: {:?}", output_path);

        // Process video
        match process_video(
            &app,
            index,
            video,
            subtitle,
            &fonts,
            &output_path.to_string_lossy(),
            duration_us,
            &filename,
        )
        .await
        {
            Ok(_) => {
                info!("Successfully processed: {}", filename);
                app.emit("ffmpeg-complete", serde_json::json!({ "index": index }))
                    .ok();
            }
            Err(e) => {
                error!("Error processing {}: {}", filename, e);
                app.emit(
                    "ffmpeg-error",
                    ProcessError {
                        index,
                        error: e,
                        filename: filename.clone(),
                    },
                )
                .ok();
            }
        }
    }

    info!("Queue processing finished");
    Ok(())
}

fn get_sidecar_path(
    app: &tauri::AppHandle,
    binary_name: &str,
) -> Result<std::path::PathBuf, String> {
    // Get the resource directory where sidecars are bundled
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    debug!("Resource directory: {:?}", resource_dir);

    // Try multiple possible binary names
    let possible_names = if cfg!(target_os = "windows") {
        vec![
            format!("{}.exe", binary_name),
            format!("{}-x86_64-pc-windows-msvc.exe", binary_name),
        ]
    } else if cfg!(target_os = "linux") {
        vec![
            binary_name.to_string(),
            format!("{}-x86_64-unknown-linux-gnu", binary_name),
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            binary_name.to_string(),
            format!("{}-x86_64-apple-darwin", binary_name),
            format!("{}-aarch64-apple-darwin", binary_name),
        ]
    } else {
        return Err("Unsupported platform".to_string());
    };

    // Try each possible name
    for name in possible_names {
        let binary_path = resource_dir.join(&name);
        // Używamy debug, bo to pętla sprawdzająca, nie chcemy spamu w Info
        debug!("Checking for binary at: {:?}", binary_path);

        if binary_path.exists() {
            info!("Found binary at: {:?}", binary_path);

            // Make sure it's executable on Unix systems
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let metadata = std::fs::metadata(&binary_path)
                    .map_err(|e| format!("Failed to get metadata: {}", e))?;
                let mut perms = metadata.permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&binary_path, perms)
                    .map_err(|e| format!("Failed to set permissions: {}", e))?;
            }

            return Ok(binary_path);
        }
    }

    let err_msg = format!(
        "Binary '{}' not found in resource directory: {:?}",
        binary_name, resource_dir
    );
    error!("{}", err_msg);
    Err(err_msg)
}

async fn get_duration(app: &tauri::AppHandle, input: &str) -> Result<f64, String> {
    debug!("get_duration called for: {}", input);

    let ffprobe_path = get_sidecar_path(app, "ffprobe")?;

    let output = Command::new(&ffprobe_path)
        .args(&[
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            input,
        ])
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        error!("ffprobe failed: {}", stderr);
        return Err(format!("ffprobe failed: {}", stderr));
    }

    let probe: ProbeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    let duration_str = probe.format.duration.ok_or("No duration found in video")?;

    let duration_sec: f64 = duration_str
        .parse()
        .map_err(|e| format!("Failed to parse duration: {}", e))?;

    Ok(duration_sec * 1_000_000.0) // Convert to microseconds
}

async fn process_video(
    app: &tauri::AppHandle,
    index: usize,
    video: &str,
    subtitle: &str,
    fonts: &[String],
    output: &str,
    duration_us: f64,
    filename: &str,
) -> Result<(), String> {
    let ffmpeg_path = get_sidecar_path(app, "ffmpeg")?;

    // Build FFmpeg arguments
    let mut args = vec![
        "-progress".to_string(),
        "pipe:2".to_string(),
        "-i".to_string(),
        video.to_string(),
        "-i".to_string(),
        subtitle.to_string(),
    ];

    for (i, font) in fonts.iter().enumerate() {
        args.push("-attach".to_string());
        args.push(font.clone());
        let ext = std::path::Path::new(font)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let mimetype = match ext.to_lowercase().as_str() {
            "ttf" => "application/x-truetype-font",
            "otf" => "application/vnd.ms-opentype",
            _ => "application/octet-stream",
        };
        args.push(format!("-metadata:s:t:{}", i));
        args.push(format!("mimetype={}", mimetype));
    }

    args.extend_from_slice(&[
        "-map".to_string(),
        "0".to_string(),
        "-map".to_string(),
        "1".to_string(),
        "-c".to_string(),
        "copy".to_string(),
        "-y".to_string(),
        output.to_string(),
    ]);

    debug!("Spawning ffmpeg with args: {:?}", args);

    let mut child = Command::new(&ffmpeg_path)
        .args(&args)
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;

    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let reader = BufReader::new(stderr);
    let app_clone = app.clone();
    let filename_clone = filename.to_string();

    // Parse progress
    for line in reader.lines() {
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            info!("Killing FFmpeg process due to cancellation");
            child.kill().ok();
            return Err("Cancelled by user".to_string());
        }

        let line = line.map_err(|e| e.to_string())?;

        // Opcjonalnie: loguj każdą linię postępu tylko na poziomie TRACE (jeśli włączone)
        // log::trace!("FFmpeg progress: {}", line);

        if line.starts_with("out_time_us=") {
            if let Some(time_str) = line.strip_prefix("out_time_us=") {
                if let Ok(time_us) = time_str.parse::<f64>() {
                    let percentage = (time_us / duration_us * 100.0).min(100.0);
                    
                    app_clone
                        .emit(
                            "ffmpeg-progress",
                            ProgressUpdate {
                                index,
                                percentage,
                                filename: filename_clone.clone(),
                            },
                        )
                        .ok();
                }
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;

    if !status.success() {
        error!("FFmpeg process exited with status: {}", status);
        return Err("FFmpeg process failed".to_string());
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                // Ustawiamy cel logowania
                .targets([
                    // Loguj do standardowego wyjścia (terminala) - przydatne przy developmencie
                    Target::new(TargetKind::Stdout),
                    // Loguj do pliku w folderze logów systemu
                    // Windows: %APPDATA%/com.identifier.app/logs/sub-merger.log
                    // Linux: ~/.cache/com.identifier.app/logs/sub-merger.log
                    Target::new(TargetKind::LogDir { 
                        file_name: Some("sub-merger.log".into()) 
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![process_queue, cancel_processing])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}