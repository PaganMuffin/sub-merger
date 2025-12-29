use std::sync::atomic::{AtomicBool, Ordering};
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use tauri::Emitter;
use serde::{Deserialize, Serialize};

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
    println!("=== Starting process_queue ===");
    println!("Videos: {:?}", videos);
    println!("Subtitles: {:?}", subtitles);
    println!("Fonts: {:?}", fonts);
    println!("Output dir: {}", output_dir);
    
    // Reset cancel flag
    CANCEL_FLAG.store(false, Ordering::Relaxed);

    for (index, (video, subtitle)) in videos.iter().zip(subtitles.iter()).enumerate() {
        println!("Processing video {} of {}", index + 1, videos.len());
        
        // Check if cancelled
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            return Err("Processing cancelled by user".to_string());
        }

        let filename = std::path::Path::new(video)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("output")
            .to_string();

        println!("Getting duration for: {}", video);
        // Get duration first
        let duration_us = match get_duration(&app, video).await {
            Ok(d) => {
                println!("Got duration: {} microseconds", d);
                d
            }
            Err(e) => {
                println!("Failed to get duration: {}", e);
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
        let output_path = std::path::Path::new(&output_dir)
            .join(format!("{}_merged.mkv", filename));

        println!("Starting FFmpeg processing for: {}", filename);
        println!("Output path: {:?}", output_path);
        
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
                app.emit("ffmpeg-complete", serde_json::json!({ "index": index }))
                    .ok();
            }
            Err(e) => {
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

    Ok(())
}

async fn get_duration(_app: &tauri::AppHandle, input: &str) -> Result<f64, String> {
    println!("get_duration called for: {}", input);
    
    // Use ffprobe from system binaries directory
    let mut cwd = std::env::current_dir()
        .map_err(|e| format!("Failed to get current directory: {}", e))?;
    
    println!("Current directory: {:?}", cwd);
    
    // If we're already in src-tauri directory, use binaries/ directly
    // Otherwise, use src-tauri/binaries/
    let ffprobe_path = if cwd.ends_with("src-tauri") {
        cwd.join("binaries/ffprobe-x86_64-unknown-linux-gnu")
    } else {
        cwd.join("src-tauri/binaries/ffprobe-x86_64-unknown-linux-gnu")
    };
    
    println!("FFprobe path: {:?}", ffprobe_path);
    
    if !ffprobe_path.exists() {
        return Err(format!("FFprobe binary not found at: {:?}", ffprobe_path));
    }

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
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let probe: ProbeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    let duration_str = probe
        .format
        .duration
        .ok_or("No duration found in video")?;

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
    // Use ffmpeg from system binaries directory
    let mut cwd = std::env::current_dir()
        .map_err(|e| format!("Failed to get current directory: {}", e))?;
    
    // If we're already in src-tauri directory, use binaries/ directly
    // Otherwise, use src-tauri/binaries/
    let ffmpeg_path = if cwd.ends_with("src-tauri") {
        cwd.join("binaries/ffmpeg-x86_64-unknown-linux-gnu")
    } else {
        cwd.join("src-tauri/binaries/ffmpeg-x86_64-unknown-linux-gnu")
    };
    
    if !ffmpeg_path.exists() {
        return Err(format!("FFmpeg binary not found at: {:?}", ffmpeg_path));
    }

    // Build FFmpeg arguments
    let mut args = vec![
        "-progress".to_string(),
        "pipe:2".to_string(),
        "-i".to_string(),
        video.to_string(),
        "-i".to_string(),
        subtitle.to_string(),
    ];

    // Attach all fonts and add mimetype metadata
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

    // Map all streams and copy codecs
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

    let mut child = Command::new(&ffmpeg_path)
        .args(&args)
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;

    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to capture stderr")?;

    let reader = BufReader::new(stderr);
    let app_clone = app.clone();
    let filename_clone = filename.to_string();

    // Parse progress
    for line in reader.lines() {
        // Check for cancellation
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            child.kill().ok();
            return Err("Cancelled by user".to_string());
        }

        let line = line.map_err(|e| e.to_string())?;

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
        return Err("FFmpeg process failed".to_string());
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![process_queue, cancel_processing])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

