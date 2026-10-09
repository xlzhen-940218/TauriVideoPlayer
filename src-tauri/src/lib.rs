mod stream;

use std::fs;
use std::path::Path;
use std::sync::Arc;

use stream::{MediaInfo, StreamShared};
use tauri::Manager;

const VIDEO_EXTS: &[&str] = &[
    "mp4", "m4v", "mov", "webm", "ogv", "ogg", "mkv", "avi", "flv", "ts", "m2ts", "mts", "wmv",
    "3gp", "3g2", "f4v", "vob", "rm", "rmvb",
];

/// 列出目录下所有受支持的视频文件（按文件名排序）
#[tauri::command]
fn list_videos(dir: String) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_video = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| VIDEO_EXTS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false);
        if is_video {
            if let Some(p) = path.to_str() {
                files.push(p.to_string());
            }
        }
    }
    files.sort_by_key(|p| {
        Path::new(p)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.to_lowercase())
            .unwrap_or_default()
    });
    Ok(files)
}

/// 确保 ffmpeg 可用：已安装（PATH 或程序目录）则直接返回，否则自动下载
#[tauri::command]
fn ffmpeg_ensure() -> Result<(), String> {
    ffmpeg_sidecar::download::auto_download().map_err(|e| e.to_string())
}

/// 返回本地转流服务地址与访问令牌
#[tauri::command]
fn stream_base(state: tauri::State<'_, Arc<StreamShared>>) -> stream::StreamBase {
    stream::base_info(&state)
}

/// 探测媒体信息并给出建议的转流模式
#[tauri::command]
fn probe_media(path: String) -> Result<MediaInfo, String> {
    stream::probe(&path)
}

/// 使用 ffmpeg 截取指定时间点的画面，自动保存到用户图片文件夹，返回完整路径
#[tauri::command]
fn take_screenshot(app: tauri::AppHandle, path: String, seconds: f64) -> Result<String, String> {
    let dir = app
        .path()
        .picture_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Pictures")))
        .map_err(|e| format!("无法获取图片文件夹：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建图片文件夹失败：{e}"))?;

    let stem = Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("screenshot");
    let secs = seconds.max(0.0) as u64;
    let stamp = format!("{:02}-{:02}-{:02}", secs / 3600, (secs / 60) % 60, secs % 60);
    let mut target = dir.join(format!("{stem}-{stamp}.png"));
    let mut n = 2;
    while target.exists() {
        target = dir.join(format!("{stem}-{stamp}-{n}.png"));
        n += 1;
    }
    let save_path = target
        .to_str()
        .ok_or("图片保存路径包含无效字符")?
        .to_string();
    stream::take_screenshot(&path, seconds, &save_path)?;
    Ok(save_path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let shared = stream::spawn_server();
            app.manage(shared);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_videos,
            ffmpeg_ensure,
            stream_base,
            probe_media,
            take_screenshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
