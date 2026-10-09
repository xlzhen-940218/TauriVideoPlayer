//! 本地 FFmpeg 转流服务：
//! 绑定 127.0.0.1 随机端口，把浏览器不支持的容器/编码实时转封装或转码为
//! 分片 MP4（fMP4）流，供 <video> 通过 HTTP 顺序播放。

use ffmpeg_sidecar::paths::ffmpeg_path;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn kill_pid(pid: u32) {
    extern "system" {
        fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
        fn TerminateProcess(hProcess: isize, uExitCode: u32) -> i32;
        fn CloseHandle(hObject: isize) -> i32;
    }
    const PROCESS_TERMINATE: u32 = 0x0001;
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle != 0 {
            let _ = TerminateProcess(handle, 1);
            let _ = CloseHandle(handle);
        }
    }
}

#[cfg(not(windows))]
fn kill_pid(pid: u32) {
    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).output();
}

pub struct StreamShared {
    pub port: u16,
    pub token: String,
    pub active_stream_pid: Mutex<Option<u32>>,
    pub active_thumb_pid: Mutex<Option<u32>>,
    pub thumb_lock: Mutex<()>,
    pub thumb_cache: Mutex<HashMap<String, Vec<u8>>>,
}

#[derive(Serialize)]
pub struct StreamBase {
    pub base: String,
    pub token: String,
}

#[derive(Serialize)]
pub struct MediaInfo {
    pub duration: Option<f64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    /// copy：视频音频直接转封装；copy-audio：视频直拷、音频转 AAC；transcode：全部转码
    pub mode: String,
    /// copy 模式下音频为 ADTS AAC 时需要 aac_adtstoasc 过滤器才能写入 MP4
    pub aac_bsf: bool,
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn gen_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}-{:x}", nanos, std::process::id(), count)
}

/// 给命令加上 CREATE_NO_WINDOW，避免 Windows 上弹出黑框
fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
}

pub fn spawn_server() -> Arc<StreamShared> {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind stream server");
    let port = listener.local_addr().unwrap().port();
    let shared = Arc::new(StreamShared {
        port,
        token: gen_token(),
        active_stream_pid: Mutex::new(None),
        active_thumb_pid: Mutex::new(None),
        thumb_lock: Mutex::new(()),
        thumb_cache: Mutex::new(HashMap::new()),
    });
    eprintln!("[stream] 本地转流服务已启动: http://127.0.0.1:{} token={}", port, shared.token);
    let shared_for_thread = shared.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let s = shared_for_thread.clone();
            std::thread::spawn(move || {
                let _ = handle_connection(stream, s);
            });
        }
    });
    shared
}

pub fn base_info(shared: &Arc<StreamShared>) -> StreamBase {
    StreamBase {
        base: format!("http://127.0.0.1:{}", shared.port),
        token: shared.token.clone(),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let hex = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    out.push(h * 16 + l);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

struct Query {
    path: String,
    ss: f64,
    mode: String,
    bsf: bool,
    token: String,
}

fn parse_query(q: &str) -> Option<Query> {
    let mut query = Query {
        path: String::new(),
        ss: 0.0,
        mode: "copy".to_string(),
        bsf: false,
        token: String::new(),
    };
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=')?;
        let v = percent_decode(v);
        match k {
            "path" => query.path = v,
            "ss" => query.ss = v.parse().unwrap_or(0.0),
            "mode" => query.mode = v,
            "bsf" => query.bsf = v == "1",
            "token" => query.token = v,
            _ => {}
        }
    }
    if query.path.is_empty() {
        None
    } else {
        Some(query)
    }
}

fn write_response_head(stream: &mut TcpStream, status: &str, content_type: &str) {
    let head = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        status, content_type
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.flush();
}

fn handle_connection(mut stream: TcpStream, shared: Arc<StreamShared>) -> std::io::Result<()> {
    let read_stream = stream.try_clone()?;
    let mut reader = BufReader::new(read_stream);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(());
    }
    // 读完剩余请求头
    let mut range_header = String::new();
    let mut ua_header = String::new();
    loop {
        let mut header = String::new();
        let n = reader.read_line(&mut header)?;
        if n == 0 || header == "\r\n" || header == "\n" {
            break;
        }
        let lower = header.to_ascii_lowercase();
        if lower.starts_with("range:") {
            range_header = header.trim().to_string();
        } else if lower.starts_with("user-agent:") {
            ua_header = header.trim().to_string();
        }
    }

    let request: Vec<&str> = line.split_whitespace().collect();
    if request.len() < 2 || request[0] != "GET" {
        write_response_head(&mut stream, "400 Bad Request", "text/plain; charset=utf-8");
        let _ = stream.write_all("bad request".as_bytes());
        return Ok(());
    }

    let (route, query_str) = request[1].split_once('?').unwrap_or((request[1], ""));

    if route == "/health" {
        write_response_head(&mut stream, "200 OK", "text/plain");
        let _ = stream.write_all(b"ok");
        return Ok(());
    }

    if route != "/play" && route != "/thumb" {
        write_response_head(&mut stream, "404 Not Found", "text/plain; charset=utf-8");
        let _ = stream.write_all(b"not found");
        return Ok(());
    }

    let query = match parse_query(query_str) {
        Some(q) => q,
        None => {
            write_response_head(&mut stream, "400 Bad Request", "text/plain; charset=utf-8");
            let _ = stream.write_all("missing path".as_bytes());
            return Ok(());
        }
    };

    if query.token != shared.token {
        write_response_head(&mut stream, "403 Forbidden", "text/plain; charset=utf-8");
        let _ = stream.write_all(b"forbidden");
        return Ok(());
    }

    if route == "/thumb" {
        return handle_thumb(stream, query, shared);
    }

    // 启动 ffmpeg 转流前，先终止之前的旧转流进程（若仍在运行）
    {
        let mut prev = shared.active_stream_pid.lock().unwrap();
        if let Some(pid) = prev.take() {
            kill_pid(pid);
        }
    }

    // 启动 ffmpeg 转流
    let mut cmd = Command::new(ffmpeg_path());
    apply_no_window(&mut cmd);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-fflags")
        .arg("+genpts")
        .arg("-probesize")
        .arg("50M")
        .arg("-analyzeduration")
        .arg("20M");
    if query.ss > 0.0 {
        cmd.arg("-ss").arg(format!("{:.3}", query.ss));
    }
    cmd.arg("-i").arg(&query.path)
        .args(["-map", "0:v:0"])
        .args(["-map", "0:a:0?"]);
    match query.mode.as_str() {
        "copy" => {
            cmd.args(["-c", "copy"]);
            // TS/FLV 等容器中的 AAC 为 ADTS 头，写入 MP4 前必须转换
            if query.bsf {
                cmd.args(["-bsf:a", "aac_adtstoasc"]);
            }
        }
        "copy-audio" => {
            cmd.args(["-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ac", "2"]);
        }
        _ => {
            // 兜底软转码限制到 1080p 宽，保证实时性（4K 软转无法实时）
            cmd.args([
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                "-vf", "scale=1920:-2:force_original_aspect_ratio=decrease",
                "-c:a", "aac", "-b:a", "160k", "-ac", "2",
            ]);
        }
    }
    cmd.args([
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-",
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let fname = Path::new(&query.path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&query.path);
    eprintln!(
        "[stream] >> GET mode={} ss={:.2} file={} | {} | {}",
        query.mode, query.ss, fname, range_header, ua_header
    );

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[stream] ffmpeg 启动失败: {e}");
            write_response_head(&mut stream, "500 Internal Server Error", "text/plain; charset=utf-8");
            let _ = stream.write_all(format!("failed to start ffmpeg: {e}").as_bytes());
            return Ok(());
        }
    };

    let pid = child.id();
    *shared.active_stream_pid.lock().unwrap() = Some(pid);

    // 收集 ffmpeg stderr 尾部，便于诊断其退出原因
    let mut stderr = child.stderr.take().expect("piped stderr");
    let err_tail: Arc<std::sync::Mutex<Vec<u8>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let err_tail_clone = err_tail.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        let mut buf = Vec::new();
        while let Ok(n) = stderr.read(&mut chunk) {
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() > 8192 {
                let cut = buf.len() - 8192;
                buf.drain(..cut);
            }
        }
        *err_tail_clone.lock().unwrap() = buf;
    });

    let mut stdout = child.stdout.take().expect("piped stdout");
    write_response_head(&mut stream, "200 OK", "video/mp4");

    let started = std::time::Instant::now();
    let mut total = 0u64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = stdout.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if stream.write_all(&buf[..n]).is_err() || stream.flush().is_err() {
            // 前端已断开（切歌/拖动/关闭），终止转码进程
            let _ = child.kill();
            let _ = child.wait();
            *shared.active_stream_pid.lock().unwrap() = None;
            eprintln!(
                "[stream] << 客户端断开，已 kill ffmpeg（{:.1}s, {:.1} MB）",
                started.elapsed().as_secs_f64(),
                total as f64 / 1_048_576.0
            );
            return Ok(());
        }
    }
    let status = child.wait()?;
    *shared.active_stream_pid.lock().unwrap() = None;
    let tail = err_tail.lock().unwrap();
    let tail_str = String::from_utf8_lossy(&tail);
    let last_err = tail_str.trim().lines().last().unwrap_or("");
    eprintln!(
        "[stream] == ffmpeg 结束 status={:?}（{:.1}s, {:.1} MB）{}",
        status.code(),
        started.elapsed().as_secs_f64(),
        total as f64 / 1_048_576.0,
        if last_err.is_empty() { String::new() } else { format!(" | 末行: {last_err}") }
    );
    Ok(())
}

/// 进度条预览缩略图：严格单任务执行 + 内存缓存 + 快速搜寻 + 1线程，杜绝高并发吃满系统
fn handle_thumb(
    mut stream: TcpStream,
    query: Query,
    shared: Arc<StreamShared>,
) -> std::io::Result<()> {
    let cache_key = format!("{}@{:.0}", query.path, query.ss);

    // 1. 优先命中内存缓存
    {
        let cache = shared.thumb_cache.lock().unwrap();
        if let Some(jpeg) = cache.get(&cache_key) {
            return write_thumb_response(&mut stream, jpeg);
        }
    }

    // 2. 终止任何正在进行的旧缩略图抽取，避免无用排队
    {
        let mut prev = shared.active_thumb_pid.lock().unwrap();
        if let Some(pid) = prev.take() {
            kill_pid(pid);
        }
    }

    // 3. 全局缩略图互斥锁：同一时刻最多仅允许 1 个 ffmpeg 抽帧进程运行
    let _guard = shared.thumb_lock.lock().unwrap();

    // 4. 获取锁后再次检查缓存（可能刚被前一个请求算出来）
    {
        let cache = shared.thumb_cache.lock().unwrap();
        if let Some(jpeg) = cache.get(&cache_key) {
            return write_thumb_response(&mut stream, jpeg);
        }
    }

    let mut cmd = Command::new(ffmpeg_path());
    apply_no_window(&mut cmd);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-threads")
        .arg("1") // 限制 1 个线程，绝不抢占 CPU
        .arg("-ss")
        .arg(format!("{:.3}", query.ss.max(0.0)))
        .arg("-noaccurate_seek") // 快速关键帧定位，速度提升数十倍
        .arg("-i")
        .arg(&query.path)
        .args(["-map", "0:v:0", "-frames:v", "1"])
        .args(["-vf", "scale=240:-2:flags=fast_bilinear"])
        .args(["-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "6", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            write_response_head(
                &mut stream,
                "500 Internal Server Error",
                "text/plain; charset=utf-8",
            );
            let _ = stream.write_all(format!("failed to start ffmpeg: {e}").as_bytes());
            return Ok(());
        }
    };

    let pid = child.id();
    *shared.active_thumb_pid.lock().unwrap() = Some(pid);

    let mut stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            *shared.active_thumb_pid.lock().unwrap() = None;
            return Ok(());
        }
    };

    let mut jpeg = Vec::new();
    let read_result = stdout.read_to_end(&mut jpeg);

    // 确保子进程完全退出并回收资源
    let _ = child.kill();
    let _ = child.wait();
    *shared.active_thumb_pid.lock().unwrap() = None;

    if read_result.is_err() || jpeg.is_empty() {
        return Ok(());
    }

    // 写入内存缓存（上限 150 张，约 1.5MB 内存）
    {
        let mut cache = shared.thumb_cache.lock().unwrap();
        if cache.len() > 150 {
            cache.clear();
        }
        cache.insert(cache_key, jpeg.clone());
    }

    write_thumb_response(&mut stream, &jpeg)?;
    Ok(())
}

fn write_thumb_response(stream: &mut TcpStream, jpeg: &[u8]) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 200 OK\r\n\
Content-Type: image/jpeg\r\n\
Content-Length: {}\r\n\
Cache-Control: max-age=86400\r\n\
Access-Control-Allow-Origin: *\r\n\
Connection: close\r\n\r\n",
        jpeg.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(jpeg)?;
    stream.flush()
}

/* ----------------------------- FFmpeg 命令封装 ----------------------------- */

/// 运行 `ffmpeg -i <path>` 并从 stderr 解析时长与编码
pub fn probe(path: &str) -> Result<MediaInfo, String> {
    let mut cmd = Command::new(ffmpeg_path());
    apply_no_window(&mut cmd);
    cmd.arg("-hide_banner")
        .arg("-probesize")
        .arg("50M")
        .arg("-analyzeduration")
        .arg("20M")
        .arg("-i")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let output = cmd.output().map_err(|e| format!("无法启动 ffmpeg：{e}"))?;
    // 未给输出文件时 ffmpeg 以非零码退出，stderr 仍包含完整媒体信息
    let text = String::from_utf8_lossy(&output.stderr);

    let mut duration = None;
    let mut vcodec = None;
    let mut acodec = None;

    for line in text.lines() {
        // 仅解析真正的流描述行，避开警告中的 "Audio:" 字样
        let is_stream_line = line.contains("Stream #");
        if duration.is_none() {
            if let Some((_, rest)) = line.split_once("Duration: ") {
                let time = rest.split(',').next().unwrap_or("").trim();
                let mut parts = time.split(':');
                if let (Some(h), Some(m), Some(s)) = (parts.next(), parts.next(), parts.next()) {
                    if let (Ok(h), Ok(m), Ok(s)) =
                        (h.parse::<f64>(), m.parse::<f64>(), s.parse::<f64>())
                    {
                        duration = Some(h * 3600.0 + m * 60.0 + s);
                    }
                }
            }
        }
        if is_stream_line && vcodec.is_none() {
            if let Some(idx) = line.find("Video:") {
                vcodec = line[idx + 6..]
                    .split_whitespace()
                    .next()
                    .map(|s| s.to_lowercase());
            }
        }
        if is_stream_line && acodec.is_none() {
            if let Some(idx) = line.find("Audio:") {
                acodec = line[idx + 6..]
                    .split_whitespace()
                    .next()
                    .map(|s| s.to_lowercase());
            }
        }
    }

    let mode = decide_mode(vcodec.as_deref(), acodec.as_deref()).to_string();
    let aac_bsf = mode == "copy" && acodec.as_deref() == Some("aac");
    Ok(MediaInfo {
        duration,
        vcodec,
        acodec,
        mode,
        aac_bsf,
    })
}

fn decide_mode(vcodec: Option<&str>, acodec: Option<&str>) -> &'static str {
    // Chromium 能在 fMP4 中解码的视频编码；HEVC 取决于系统（失败时前端会降级转码）
    let video_copy =
        matches!(vcodec, Some("h264") | Some("hevc") | Some("vp9") | Some("av1"));
    // Chromium 支持的音频编码；无音频轨时按可直拷处理
    let audio_copy = matches!(
        acodec,
        None | Some("aac") | Some("mp3") | Some("opus")
    );
    match (video_copy, audio_copy) {
        (true, true) => "copy",
        (true, false) => "copy-audio",
        (false, _) => "transcode",
    }
}

/// 截取指定时间点的一帧保存为图片
pub fn take_screenshot(path: &str, seconds: f64, save_path: &str) -> Result<(), String> {
    let mut cmd = Command::new(ffmpeg_path());
    apply_no_window(&mut cmd);
    cmd.arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-ss")
        .arg(format!("{:.3}", seconds.max(0.0)))
        .arg("-i")
        .arg(path)
        .args(["-map", "0:v:0", "-frames:v", "1", "-y"])
        .arg(save_path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let output = cmd.output().map_err(|e| format!("无法启动 ffmpeg：{e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffmpeg 截图失败：{}",
            err.trim().lines().last().unwrap_or("未知错误")
        ));
    }
    Ok(())
}
