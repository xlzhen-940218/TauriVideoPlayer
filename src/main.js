const { invoke, convertFileSrc } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { getCurrentWindow } = window.__TAURI__.window;
const { getCurrentWebview } = window.__TAURI__.webview;

const appWindow = getCurrentWindow();

const VIDEO_EXTS = [
  "mp4", "m4v", "mov", "webm", "ogv", "ogg", "mkv", "avi", "flv", "ts",
  "m2ts", "mts", "wmv", "3gp", "3g2", "f4v", "vob", "rm", "rmvb",
];
// Chromium 原生支持的容器直接走 asset 协议，其余格式通过本地 ffmpeg 转流播放
const NATIVE_EXTS = ["mp4", "m4v", "mov", "webm", "ogv", "ogg"];
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const MODES = {
  list: { icon: "icon-mode-list", title: "列表循环（播完自动下一个）" },
  single: { icon: "icon-mode-single", title: "单曲循环" },
  order: { icon: "icon-mode-order", title: "顺序播放（播完即停）" },
};
const MODE_ORDER = ["list", "single", "order"];

const SETTINGS_KEY = "vp.settings.v1";
const POSITIONS_KEY = "vp.positions.v1";
const MODE_KEY = "vp.mode.v1";

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const settings = Object.assign({ volume: 1, muted: false, rate: 1 }, loadJSON(SETTINGS_KEY, {}));
let positions = loadJSON(POSITIONS_KEY, {});
let mode = MODE_ORDER.includes(localStorage.getItem(MODE_KEY)) ? localStorage.getItem(MODE_KEY) : "list";

const state = {
  items: [], // { path, name }
  index: -1,
  lastSave: 0,
  errorGuard: false,
  loadingTrack: false,
  // 转流模式：null 表示走浏览器原生播放；否则 { start, duration, level }
  stream: null,
  nativeTried: false,
  endHandled: false,
};

let ffmpegReady = false;
let streamBaseCache = null;
let streamSeq = 0; // 转流请求序号，连续 seek 时只采用最后一次

const $ = (id) => document.getElementById(id);
const video = $("video");
const stage = $("stage");

/* ---------------- Seek 封面帧（避免重开流时黑屏） ---------------- */

const seekCover = $("seek-cover");
let coverFadeTimer = null;
let coverWatchTimer = null;
const COVER_WATCHDOG_MS = 12000; // 新流迟迟不出首帧且没有 error 时的兜底

function showSeekCover() {
  if (!video.videoWidth || !video.videoHeight) return;
  try {
    clearTimeout(coverFadeTimer);
    clearTimeout(coverWatchTimer);
    seekCover.width = video.videoWidth;
    seekCover.height = video.videoHeight;
    seekCover.getContext("2d").drawImage(video, 0, 0);
    seekCover.classList.remove("hide");
    seekCover.style.display = "block";
    coverWatchTimer = setTimeout(() => hideSeekCover(), COVER_WATCHDOG_MS);
  } catch {
    seekCover.style.display = "none";
  }
}

function hideSeekCover() {
  if (seekCover.style.display === "none") return;
  clearTimeout(coverWatchTimer);
  const finish = () => {
    seekCover.classList.add("hide");
    coverFadeTimer = setTimeout(() => {
      seekCover.style.display = "none";
      seekCover.classList.remove("hide");
    }, 220);
  };

  // 等待新流的第一帧真实提交到合成器后再淡出封面，确保新旧画面无缝衔接，杜绝黑帧
  if ("requestVideoFrameCallback" in video) {
    video.requestVideoFrameCallback(() => {
      requestAnimationFrame(finish);
    });
  } else {
    requestAnimationFrame(() => requestAnimationFrame(finish));
  }
}

/* ---------------- OSD icons ---------------- */

const OSD_SVGS = {
  play: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  forward: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>',
  back: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>',
  vol: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
  muted: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
};

const osdEl = $("center-osd");
let osdTimer = null;
function flashOSD(kind, label) {
  clearTimeout(osdTimer);
  osdEl.classList.remove("show");
  void osdEl.offsetWidth;
  osdEl.innerHTML = OSD_SVGS[kind] || "";
  if (label) {
    const sub = document.createElement("div");
    sub.textContent = label;
    sub.style.cssText = "position:absolute;bottom:14px;font-size:13px;font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,.8)";
    osdEl.appendChild(sub);
  }
  osdEl.classList.add("show");
  osdTimer = setTimeout(() => osdEl.classList.remove("show"), 600);
}

/* ---------------- Toasts ---------------- */

function toast(msg, type = "info", duration = 2200) {
  const el = document.createElement("div");
  el.className = `toast${type === "error" ? " error" : ""}`;
  el.textContent = msg;
  $("toast-container").appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 260);
  }, duration);
}

/* ---------------- Helpers ---------------- */

function basename(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function extOf(p) {
  const m = /\.([^./\\]+)$/.exec(p);
  return m ? m[1].toLowerCase() : "";
}

function isVideoFile(p) {
  return VIDEO_EXTS.includes(extOf(p));
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function savePosition(force = false) {
  if (state.index < 0 || !video.src || state.loadingTrack) return;
  const t = currentPos();
  const dur = totalDur();
  const now = Date.now();
  if (!force && now - state.lastSave < 2500) return;
  state.lastSave = now;
  const path = state.items[state.index].path;
  if (t >= 10 && dur > 0 && t < dur - 20) {
    positions[path] = t;
  } else {
    delete positions[path];
  }
  localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
}

/* ---------------- 时间轴（兼容原生与转流模式） ---------------- */

function currentPos() {
  if (state.stream) {
    return state.stream.start + (isFinite(video.currentTime) ? video.currentTime : 0);
  }
  return video.currentTime || 0;
}

function totalDur() {
  if (state.stream) {
    return state.stream.duration || (isFinite(video.duration) ? video.duration : 0);
  }
  return isFinite(video.duration) ? video.duration : 0;
}

/* ---------------- FFmpeg 转流 ---------------- */

async function ensureFfmpeg(silent = false) {
  if (ffmpegReady) return;
  if (!silent) toast("首次使用正在准备 FFmpeg 解码组件，请稍候…", "info", 5000);
  await invoke("ffmpeg_ensure");
  ffmpegReady = true;
}

async function ensureStreamBase() {
  if (!streamBaseCache) streamBaseCache = await invoke("stream_base");
  return streamBaseCache;
}

/**
 * 通过本地 ffmpeg 服务播放当前曲目
 * @param {number} ss 起始时间（秒）
 * @param {string|null} level copy / copy-audio / transcode，null 表示先探测
 * @param {boolean} autoplay
 * @param {boolean} aacBsf copy AAC 时是否需要 aac_adtstoasc
 */
async function startStreamPlayback(ss, level, autoplay, aacBsf = false) {
  const item = state.items[state.index];
  if (!item) return;
  const seq = ++streamSeq;
  state.endHandled = false;
  // 重开流会让 video 短暂清空，先把当前帧盖在上面避免黑屏
  showSeekCover();
  stage.classList.add("buffering");
  try {
    await ensureFfmpeg();
    let info = null;
    if (!level) {
      info = await invoke("probe_media", { path: item.path });
      if (seq !== streamSeq) return; // 期间又发起了更新的 seek
      level = info.mode || "copy";
      aacBsf = !!info.aac_bsf;
    }
    const base = await ensureStreamBase();
    if (seq !== streamSeq) return;
    state.stream = {
      start: ss,
      // seek 重开时没有新 probe，沿用已知时长，避免时间轴失效
      duration: info?.duration ?? state.stream?.duration ?? null,
      level,
      aacBsf,
    };
    const url =
      `${base.base}/play?token=${encodeURIComponent(base.token)}` +
      `&path=${encodeURIComponent(item.path)}&ss=${ss}&mode=${level}&bsf=${aacBsf ? 1 : 0}`;
    video.src = url;
    video.playbackRate = settings.rate;
    if (autoplay) video.play().catch(() => {});
  } catch (e) {
    if (seq !== streamSeq) return;
    state.loadingTrack = false;
    stage.classList.remove("buffering");
    hideSeekCover();
    toast(`无法播放「${item.name}」：${e}`, "error", 3600);
  }
}

/* ---------------- Playlist ---------------- */

const playlistEl = $("playlist");
const playlistItemsEl = $("playlist-items");

function renderPlaylist() {
  $("playlist-count").textContent = state.items.length;
  playlistItemsEl.innerHTML = "";
  if (state.items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "playlist-empty";
    empty.textContent = "还没有视频，拖放或点击“打开文件”";
    empty.style.cursor = "default";
    playlistItemsEl.appendChild(empty);
    return;
  }
  state.items.forEach((item, i) => {
    const li = document.createElement("li");
    if (i === state.index) {
      li.classList.add("active");
      if (video.paused) li.classList.add("paused-li");
    }

    const idx = document.createElement("span");
    idx.className = "item-index";
    idx.innerHTML = `<span class="idx-num">${i + 1}</span><span class="playing-bars"><span></span><span></span><span></span></span>`;

    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent = item.name;
    name.title = item.path;

    const remove = document.createElement("button");
    remove.className = "item-remove";
    remove.title = "移除";
    remove.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      removeItem(i);
    });

    li.appendChild(idx);
    li.appendChild(name);
    li.appendChild(remove);
    li.addEventListener("click", () => loadIndex(i, true));
    playlistItemsEl.appendChild(li);
  });
}

function updatePlaylistPlayState() {
  playlistItemsEl.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("paused-li", i === state.index && video.paused);
  });
}

function removeItem(i) {
  const removedCurrent = i === state.index;
  state.items.splice(i, 1);
  if (state.items.length === 0) {
    state.index = -1;
    resetPlayer();
  } else if (removedCurrent) {
    state.index = Math.min(i, state.items.length - 1);
    loadIndex(state.index, true);
  } else if (i < state.index) {
    state.index -= 1;
  }
  renderPlaylist();
  updateEmptyState();
}

function resetPlayer() {
  video.pause();
  video.removeAttribute("src");
  video.load();
  state.index = -1;
  state.stream = null;
  state.nativeTried = false;
  state.endHandled = false;
  stage.classList.remove("has-video", "buffering", "idle", "video-hidden");
  clearTimeout(coverWatchTimer);
  clearTimeout(streamSeekTimer);
  pendingStreamSeekTarget = null;
  lastSeekPos = null;
  clearTimeout(thumbTimer);
  thumbClientCache.clear();
  seekCover.style.display = "none";
  thumbReqId++;
  thumbImg.classList.remove("show");
  $("now-playing").textContent = "";
  $("now-playing").title = "";
  $("time").textContent = "00:00 / 00:00";
  setProgress(0, 0);
  appWindow.setTitle("西瓜视频播放器");
}

function addFiles(paths, { replace = false, play = true } = {}) {
  const videos = paths.filter(isVideoFile);
  if (videos.length === 0) {
    toast("没有可识别的视频文件", "error");
    return 0;
  }
  if (replace) {
    state.items = [];
    state.index = -1;
  }
  let firstNew = -1;
  for (const p of videos) {
    if (!state.items.some((it) => it.path === p)) {
      if (firstNew < 0) firstNew = state.items.length;
      state.items.push({ path: p, name: basename(p) });
    }
  }
  if (firstNew < 0) {
    toast("文件已在播放列表中");
    renderPlaylist();
    return 0;
  }
  renderPlaylist();
  updateEmptyState();
  if (play && (state.index < 0 || replace)) {
    loadIndex(replace ? 0 : firstNew, true);
  }
  return videos.length;
}

async function expandPaths(paths) {
  const out = [];
  for (const p of paths) {
    if (isVideoFile(p)) {
      out.push(p);
    } else {
      // 拖入文件夹时展开其中的视频
      try {
        const files = await invoke("list_videos", { dir: p });
        out.push(...files);
      } catch {
        // 非目录且不是视频扩展名，忽略
      }
    }
  }
  return out;
}

/* ---------------- Loading / playback ---------------- */

function loadIndex(i, autoplay) {
  if (i < 0 || i >= state.items.length) return;
  savePosition(true);
  state.loadingTrack = true;
  state.index = i;
  state.errorGuard = false;
  state.stream = null;
  state.nativeTried = false;
  state.endHandled = false;
  clearTimeout(streamSeekTimer);
  pendingStreamSeekTarget = null;
  lastSeekPos = null;
  clearTimeout(thumbTimer);
  thumbReqId++;
  lastThumbKey = "";
  thumbImg.classList.remove("show");
  const item = state.items[i];
  stage.classList.add("has-video");
  $("now-playing").textContent = item.name;
  $("now-playing").title = item.path;
  appWindow.setTitle(`${item.name} - 西瓜视频播放器`);
  renderPlaylist();
  const active = playlistItemsEl.querySelector("li.active");
  if (active) active.scrollIntoView({ block: "nearest" });

  if (NATIVE_EXTS.includes(extOf(item.path))) {
    // 浏览器原生通道
    video.src = convertFileSrc(item.path);
    video.playbackRate = settings.rate;
    if (autoplay) {
      video.play().catch(() => {
        /* WebView 自动播放受限或解码失败，等待用户点击 */
      });
    }
  } else {
    // 其他容器走 ffmpeg 转流（续播点直接作为起始时间）
    const saved = positions[item.path] || 0;
    startStreamPlayback(saved, null, autoplay);
  }
}

function togglePlay() {
  if (state.index < 0) {
    pickFiles();
    return;
  }
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

let streamSeekTimer = null;
let pendingStreamSeekTarget = null;
let lastSeekPos = null;

function seekBy(delta) {
  if (state.index < 0) return;
  const dur = totalDur();
  // 流模式结尾要留余量：起点太靠近片尾，流会瞬间结束触发 ended 重载
  const maxT = state.stream && dur ? Math.max(0, dur - 1.5) : dur || Infinity;

  if (state.stream) {
    const base = pendingStreamSeekTarget !== null ? pendingStreamSeekTarget : currentPos();
    if (lastSeekPos === null) lastSeekPos = currentPos();
    const target = Math.min(Math.max(0, base + delta), maxT);
    pendingStreamSeekTarget = target;
    const totalDiff = Math.round(target - lastSeekPos);
    flashOSD(delta >= 0 ? "forward" : "back", `${totalDiff >= 0 ? "+" : ""}${totalDiff}s`);
    setProgress(dur ? target / dur : 0, 0);

    // 连续快速 Seek 时防抖 180ms，只在松手/停顿后启动一次最终目标 ffmpeg 流
    clearTimeout(streamSeekTimer);
    streamSeekTimer = setTimeout(() => {
      const finalTarget = pendingStreamSeekTarget;
      pendingStreamSeekTarget = null;
      lastSeekPos = null;
      startStreamPlayback(finalTarget, state.stream.level, !video.paused, state.stream.aacBsf);
    }, 180);
  } else {
    if (!isFinite(video.duration)) return;
    const target = Math.min(Math.max(0, currentPos() + delta), maxT);
    video.currentTime = target;
    flashOSD(delta >= 0 ? "forward" : "back", `${delta > 0 ? "+" : ""}${delta}s`);
  }
}

function nextTrack(autoplay = true) {
  if (state.items.length === 0) return;
  if (state.index < state.items.length - 1) {
    loadIndex(state.index + 1, autoplay);
  } else if (mode === "list") {
    loadIndex(0, autoplay);
  }
}

function prevTrack() {
  if (state.items.length === 0) return;
  if (currentPos() > 3) {
    if (state.stream) startStreamPlayback(0, state.stream.level, !video.paused, state.stream.aacBsf);
    else video.currentTime = 0;
    return;
  }
  const i = state.index <= 0 ? state.items.length - 1 : state.index - 1;
  loadIndex(i, true);
}

/* ---------------- Open dialogs ---------------- */

async function pickFiles() {
  const selected = await open({
    multiple: true,
    filters: [
      { name: "视频文件", extensions: VIDEO_EXTS },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  addFiles(paths, { replace: true });
}

async function pickFolder() {
  const dir = await open({ directory: true });
  if (!dir) return;
  try {
    const files = await invoke("list_videos", { dir });
    if (files.length === 0) {
      toast("该文件夹中没有视频文件");
      return;
    }
    addFiles(files, { replace: true });
    toast(`已添加 ${files.length} 个视频`);
  } catch (e) {
    toast(`无法读取文件夹：${e}`, "error");
  }
}

/* ---------------- Volume ---------------- */

function applyVolume() {
  video.volume = settings.volume;
  video.muted = settings.muted;
  $("volume").value = settings.muted ? 0 : Math.round(settings.volume * 100);
  const high = $("icon-vol-high");
  const low = $("icon-vol-low");
  const mute = $("icon-vol-mute");
  high.classList.toggle("hidden", settings.muted || settings.volume < 0.5);
  low.classList.toggle("hidden", settings.muted || settings.volume >= 0.5 || settings.volume === 0);
  mute.classList.toggle("hidden", !settings.muted && settings.volume > 0);
}

function changeVolume(delta) {
  settings.muted = false;
  settings.volume = Math.min(1, Math.max(0, settings.volume + delta));
  applyVolume();
  saveSettings();
  flashOSD(settings.volume === 0 ? "muted" : "vol", `${Math.round(settings.volume * 100)}%`);
}

function toggleMute() {
  settings.muted = !settings.muted;
  if (!settings.muted && settings.volume === 0) settings.volume = 0.5;
  applyVolume();
  saveSettings();
  flashOSD(settings.muted ? "muted" : "vol", settings.muted ? "静音" : `${Math.round(settings.volume * 100)}%`);
}

/* ---------------- Speed ---------------- */

function setRate(rate) {
  settings.rate = rate;
  video.playbackRate = rate;
  $("btn-speed").textContent = rate === 1 ? "1.0x" : `${rate}x`;
  document.querySelectorAll("#speed-menu button").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.rate) === rate);
  });
  saveSettings();
}

function bumpRate(dir) {
  const i = RATES.indexOf(settings.rate);
  const next = Math.min(RATES.length - 1, Math.max(0, (i < 0 ? 3 : i) + dir));
  setRate(RATES[next]);
  toast(`播放速度：${RATES[next]}x`);
}

/* ---------------- Play mode ---------------- */

function setMode(m) {
  mode = m;
  localStorage.setItem(MODE_KEY, m);
  ["icon-mode-list", "icon-mode-single", "icon-mode-order"].forEach((id) =>
    $(id).classList.toggle("hidden", id !== MODES[m].icon)
  );
  $("btn-mode").title = MODES[m].title;
  video.loop = m === "single" && !state.stream;
}

function cycleMode() {
  const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
  setMode(next);
  toast(MODES[next].title.replace(/（.*$/, ""));
}

/* ---------------- Progress bar ---------------- */

const progress = $("progress");
const playedEl = $("progress-played");
const bufferedEl = $("progress-buffered");
const handleEl = $("progress-handle");
const tipEl = $("progress-tip");
const tipTimeEl = $("progress-tip-time");
const thumbImg = $("progress-thumb");
let seeking = false;

/* 进度条缩略图快速预览（后端 ffmpeg 抽帧） */
let thumbReqId = 0;
let lastThumbKey = "";
let thumbTimer = null;
const thumbClientCache = new Set();
// tip 实际半宽（缩略图 176px + 内边距），用于两端 clamp
const TIP_HALF = 100;

function scheduleThumb(t) {
  clearTimeout(thumbTimer);
  if (state.index < 0) return;
  const item = state.items[state.index];
  if (!item) return;

  // 5 秒一个时间槽，兼顾预览粒度与性能
  const slot = Math.max(0, Math.round(t / 5));
  const key = `${item.path}@${slot}`;

  if (thumbClientCache.has(key)) {
    // 已经获取过，直接更新显示，不需要等待防抖
    requestThumb(item.path, slot, key);
  } else {
    // 未缓存：鼠标在时间轴划过时防抖 180ms，只有悬停停顿才向后端请求
    thumbTimer = setTimeout(() => {
      requestThumb(item.path, slot, key);
    }, 180);
  }
}

function requestThumb(path, slot, key) {
  if (key === lastThumbKey && thumbImg.classList.contains("show")) return;
  lastThumbKey = key;
  const id = ++thumbReqId;
  ensureFfmpeg(true)
    .then(ensureStreamBase)
    .then((base) => {
      if (id !== thumbReqId) return;
      thumbImg.onload = () => {
        if (id === thumbReqId) {
          thumbImg.classList.add("show");
          thumbClientCache.add(key);
        }
      };
      thumbImg.onerror = () => {
        if (id === thumbReqId) thumbImg.classList.remove("show");
      };
      thumbImg.src =
        `${base.base}/thumb?token=${encodeURIComponent(base.token)}` +
        `&path=${encodeURIComponent(path)}&ss=${slot * 5}`;
    })
    .catch(() => {});
}

function updateProgressTip(e) {
  const dur = totalDur();
  if (!dur) return;
  const rect = progress.getBoundingClientRect();
  const ratio = progressRatio(e);
  const x = Math.min(Math.max(ratio * rect.width, TIP_HALF), rect.width - TIP_HALF);
  tipEl.style.left = `${x}px`;
  const t = ratio * dur;
  tipTimeEl.textContent = formatTime(t);

  // 正在拖动 Seek 时绝不触发抽帧（用户正专注拖动，高频抽帧会造成巨大负担）
  if (!seeking) {
    scheduleThumb(t);
  } else {
    clearTimeout(thumbTimer);
    thumbImg.classList.remove("show");
  }
}

function setProgress(ratio, bufferedRatio) {
  const p = `${Math.min(100, Math.max(0, ratio * 100))}%`;
  playedEl.style.width = p;
  handleEl.style.left = p;
  bufferedEl.style.width = `${Math.min(100, Math.max(0, bufferedRatio * 100))}%`;
}

function progressRatio(e) {
  const rect = progress.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
}

let wasPlayingBeforeSeek = false;
let seekRafId = null;

progress.addEventListener("pointerdown", (e) => {
  const dur = totalDur();
  if (!dur) return;
  seeking = true;
  progress.classList.add("seeking");
  progress.setPointerCapture(e.pointerId);
  const ratio = progressRatio(e);
  if (!state.stream) {
    wasPlayingBeforeSeek = !video.paused;
    if (wasPlayingBeforeSeek) {
      video.pause();
    }
    video.currentTime = ratio * dur;
  }
  setProgress(ratio, state.stream ? 0 : bufferedRatio());
  updateProgressTip(e);
});

progress.addEventListener("pointermove", (e) => {
  if (totalDur()) updateProgressTip(e);
  if (seeking) {
    const ratio = progressRatio(e);
    if (state.stream) {
      // 转流模式只更新视觉，松手时再以新起点重开流
      setProgress(ratio, 0);
    } else {
      setProgress(ratio, bufferedRatio());
      if (seekRafId) cancelAnimationFrame(seekRafId);
      seekRafId = requestAnimationFrame(() => {
        seekRafId = null;
        if (!video.seeking) {
          video.currentTime = ratio * totalDur();
        }
      });
    }
  }
});

progress.addEventListener("pointerup", (e) => {
  const dur = totalDur();
  if (seeking) {
    if (state.stream && dur) {
      // 片尾留 1.5s 余量，避免短流瞬间结束触发 ended
      const target = Math.min(progressRatio(e) * dur, Math.max(0, dur - 1.5));
      startStreamPlayback(target, state.stream.level, !video.paused, state.stream.aacBsf);
    } else if (!state.stream && dur) {
      if (seekRafId) {
        cancelAnimationFrame(seekRafId);
        seekRafId = null;
      }
      video.currentTime = progressRatio(e) * dur;
      if (wasPlayingBeforeSeek) {
        video.play().catch(() => {});
      }
    }
  }
  seeking = false;
  progress.classList.remove("seeking");
  savePosition(true);
});

progress.addEventListener("pointerleave", () => {
  clearTimeout(thumbTimer);
  thumbImg.classList.remove("show");
});

function bufferedRatio() {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t && t <= video.buffered.end(i)) {
      return video.buffered.end(i) / (video.duration || 1);
    }
  }
  return 0;
}

/* ---------------- Fullscreen / PiP ---------------- */

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    stage.requestFullscreen().catch((e) => toast(`无法进入全屏：${e}`, "error"));
  }
}

async function togglePiP() {
  if (state.index < 0) return;
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
      await video.requestPictureInPicture();
    } else {
      toast("当前环境不支持画中画", "error");
    }
  } catch (e) {
    toast(`画中画失败：${e}`, "error");
  }
}

/* ---------------- Screenshot ---------------- */

async function takeSnapshot() {
  if (state.index < 0) {
    toast("没有可截取的画面", "error");
    return;
  }
  const item = state.items[state.index];
  const seconds = currentPos();
  try {
    await ensureFfmpeg();
    const saved = await invoke("take_screenshot", { path: item.path, seconds });
    const name = saved.split(/[\\/]/).pop();
    toast(`截图已保存到图片文件夹：${name}`, "info", 3000);
  } catch (e) {
    toast(`截图失败：${e}`, "error");
  }
}

/* ---------------- Video events ---------------- */

video.addEventListener("play", () => {
  $("icon-play").classList.add("hidden");
  $("icon-pause").classList.remove("hidden");
  stage.classList.remove("paused");
  updatePlaylistPlayState();
});

video.addEventListener("pause", () => {
  $("icon-play").classList.remove("hidden");
  $("icon-pause").classList.add("hidden");
  stage.classList.add("paused");
  savePosition(true);
  updatePlaylistPlayState();
});

video.addEventListener("loadedmetadata", () => {
  console.log("[event] loadedmetadata duration=", video.duration, "size=", video.videoWidth + "x" + videoHeightSafe(), "stream=", state.stream);
  applyVolume();
  video.loop = mode === "single" && !state.stream;
  if (!state.stream) {
    const saved = positions[state.items[state.index]?.path];
    if (saved && saved > 10 && saved < video.duration - 20) {
      video.currentTime = saved;
      toast(`已从 ${formatTime(saved)} 继续播放`, "info", 1800);
    }
  }
  state.loadingTrack = false;
});

function videoHeightSafe() {
  return video.videoHeight || 0;
}

video.addEventListener("timeupdate", () => {
  const dur = totalDur();
  if (dur > 0 && !seeking) {
    setProgress(currentPos() / dur, state.stream ? 0 : bufferedRatio());
  }
  $("time").textContent = `${formatTime(currentPos())} / ${formatTime(dur)}`;
  // 转流模式下部分源不会触发 ended，这里用时间兜底
  if (state.stream && dur > 0 && currentPos() >= dur - 0.8 && !state.endHandled) {
    state.endHandled = true;
    handleEnded();
  }
  savePosition(false);
});

video.addEventListener("loadeddata", () => {
  // 新流首帧已可渲染，撤掉 seek 封面
  hideSeekCover();
});

video.addEventListener("waiting", () => {
  console.log("[event] waiting t=", currentPos());
  stage.classList.add("buffering");
});
video.addEventListener("playing", () => {
  console.log("[event] playing t=", currentPos());
  stage.classList.remove("buffering");
  hideSeekCover();
  state.errorGuard = false;
});
video.addEventListener("canplay", () => stage.classList.remove("buffering"));
["stalled", "suspend", "emptied", "abort"].forEach((ev) =>
  video.addEventListener(ev, () => console.log(`[event] ${ev} t=`, currentPos(), "readyState=", video.readyState, "networkState=", video.networkState))
);

function handleEnded() {
  savePosition(true);
  if (mode === "single") {
    if (state.stream) startStreamPlayback(0, state.stream.level, true, state.stream.aacBsf);
    else {
      video.currentTime = 0;
      video.play().catch(() => {});
    }
  } else {
    nextTrack(true);
  }
}

video.addEventListener("ended", () => {
  if (!state.endHandled) {
    state.endHandled = true;
    handleEnded();
  }
});

video.addEventListener("error", () => {
  if (state.index < 0 || state.errorGuard) return;
  const item = state.items[state.index];
  if (!item) return;
  const code = video.error ? video.error.code : -1;
  console.error("[video error]", code, state.stream, currentPos(), video.src);

  if (state.stream) {
    // 转流失败：copy/copy-audio → 强制转码重试一次
    if (state.stream.level !== "transcode") {
      state.errorGuard = true;
      toast("当前编码浏览器无法解码，正在转码播放…", "info", 3000);
      startStreamPlayback(Math.max(0, currentPos() - 1), "transcode", true, false);
      return;
    }
  } else if (!state.nativeTried) {
    // 原生通道失败 → 回退到 ffmpeg 转流
    state.nativeTried = true;
    state.errorGuard = true;
    startStreamPlayback(isFinite(video.duration) ? video.currentTime : 0, null, true);
    return;
  }

  state.loadingTrack = false;
  stage.classList.remove("buffering");
  hideSeekCover();
  toast(`无法播放「${item.name}」，格式或编码可能不受支持`, "error", 3200);
  setTimeout(() => {
    state.errorGuard = false;
    if (state.index < state.items.length - 1) nextTrack(true);
  }, 600);
});

/* 单击暂停/播放，双击全屏（延迟单击以避免冲突） */
let clickTimer = null;
video.addEventListener("click", () => {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    togglePlay();
  }, 220);
});
video.addEventListener("dblclick", () => {
  clearTimeout(clickTimer);
  toggleFullscreen();
});

stage.addEventListener("wheel", (e) => {
  if (state.index < 0) return;
  e.preventDefault();
  changeVolume(e.deltaY < 0 ? 0.05 : -0.05);
}, { passive: false });

$("big-play").addEventListener("click", () => togglePlay());

/* ---------------- Fullscreen UI ---------------- */

document.addEventListener("fullscreenchange", () => {
  const fs = !!document.fullscreenElement;
  document.body.classList.toggle("is-fullscreen", fs);
  $("icon-fs-enter").classList.toggle("hidden", fs);
  $("icon-fs-exit").classList.toggle("hidden", !fs);
  if (!fs) stage.classList.remove("idle");
});

let idleTimer = null;
function pokeIdle() {
  stage.classList.remove("idle");
  clearTimeout(idleTimer);
  if (document.fullscreenElement && !video.paused) {
    idleTimer = setTimeout(() => stage.classList.add("idle"), 2600);
  }
}
stage.addEventListener("mousemove", pokeIdle);
stage.addEventListener("mouseleave", () => {
  if (document.fullscreenElement && !video.paused) stage.classList.add("idle");
});

/* ---------------- Drag & drop ---------------- */

getCurrentWebview().onDragDropEvent((event) => {
  const { type, paths } = event.payload;
  if (type === "enter" || type === "over") {
    stage.classList.add("dragging");
  } else if (type === "leave") {
    stage.classList.remove("dragging");
  } else if (type === "drop") {
    stage.classList.remove("dragging");
    expandPaths(paths).then((files) => {
      const n = addFiles(files, { replace: false });
      if (n > 0) toast(n === files.length ? `已添加 ${n} 个视频` : `已添加 ${n} 个视频（已过滤不支持的文件）`);
    });
  }
});

/* ---------------- Keyboard ---------------- */

const shortcutsModal = $("shortcuts-modal");

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;

  if (e.key === "Escape") {
    if (!shortcutsModal.classList.contains("hidden")) shortcutsModal.classList.add("hidden");
    return;
  }

  if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
    if (!e.repeat) shortcutsModal.classList.toggle("hidden");
    return;
  }

  if (!shortcutsModal.classList.contains("hidden")) return;

  switch (e.key) {
    case " ":
    case "k":
    case "K":
      e.preventDefault();
      togglePlay();
      break;
    case "ArrowLeft":
      e.preventDefault();
      seekBy(-5);
      break;
    case "ArrowRight":
      e.preventDefault();
      seekBy(5);
      break;
    case "j":
    case "J":
      seekBy(-10);
      break;
    case "l":
    case "L":
      seekBy(10);
      break;
    case "ArrowUp":
      e.preventDefault();
      changeVolume(0.05);
      break;
    case "ArrowDown":
      e.preventDefault();
      changeVolume(-0.05);
      break;
    case "m":
    case "M":
      if (!e.repeat) toggleMute();
      break;
    case "f":
    case "F":
      if (!e.repeat) toggleFullscreen();
      break;
    case "p":
    case "P":
      if (!e.repeat) togglePiP();
      break;
    case "s":
    case "S":
      if (!e.repeat) takeSnapshot();
      break;
    case "n":
    case "N":
    case "PageDown":
      e.preventDefault();
      nextTrack(true);
      break;
    case "b":
    case "B":
    case "PageUp":
      e.preventDefault();
      prevTrack();
      break;
    case "r":
    case "R":
      if (!e.repeat) cycleMode();
      break;
    case "[":
      bumpRate(-1);
      break;
    case "]":
      bumpRate(1);
      break;
  }
});

/* ---------------- UI wiring ---------------- */

$("btn-open-file").addEventListener("click", pickFiles);
$("empty-open-file").addEventListener("click", pickFiles);
$("btn-open-folder").addEventListener("click", pickFolder);
$("empty-open-folder").addEventListener("click", pickFolder);

$("btn-play").addEventListener("click", togglePlay);
$("btn-prev").addEventListener("click", prevTrack);
$("btn-next").addEventListener("click", () => nextTrack(true));
$("btn-rewind").addEventListener("click", () => seekBy(-10));
$("btn-forward").addEventListener("click", () => seekBy(10));
$("btn-mute").addEventListener("click", toggleMute);
$("btn-mode").addEventListener("click", cycleMode);
$("btn-snapshot").addEventListener("click", takeSnapshot);
$("btn-pip").addEventListener("click", togglePiP);
$("btn-fullscreen").addEventListener("click", toggleFullscreen);

$("volume").addEventListener("input", (e) => {
  settings.volume = Number(e.target.value) / 100;
  settings.muted = settings.volume === 0;
  applyVolume();
  saveSettings();
});

/* Speed menu */
const speedMenu = $("speed-menu");
const speedWrap = $("speed-wrap");
$("btn-speed").addEventListener("click", (e) => {
  e.stopPropagation();
  speedMenu.classList.toggle("open");
});
speedMenu.querySelectorAll("button").forEach((b) =>
  b.addEventListener("click", () => {
    setRate(Number(b.dataset.rate));
    speedMenu.classList.remove("open");
  })
);
document.addEventListener("click", (e) => {
  if (!speedWrap.contains(e.target)) speedMenu.classList.remove("open");
});

/* Playlist panel */
function togglePlaylist() {
  playlistEl.classList.toggle("collapsed");
}
$("btn-toggle-playlist").addEventListener("click", togglePlaylist);
$("btn-playlist-close").addEventListener("click", () => playlistEl.classList.add("collapsed"));
$("playlist-clear").addEventListener("click", () => {
  if (state.items.length === 0) return;
  state.items = [];
  resetPlayer();
  renderPlaylist();
  updateEmptyState();
});

/* Shortcuts modal */
$("btn-shortcuts").addEventListener("click", () => shortcutsModal.classList.remove("hidden"));
$("shortcuts-close").addEventListener("click", () => shortcutsModal.classList.add("hidden"));
shortcutsModal.addEventListener("click", (e) => {
  if (e.target === shortcutsModal) shortcutsModal.classList.add("hidden");
});

function updateEmptyState() {
  $("empty-state").style.display = state.items.length === 0 ? "flex" : "none";
}

/* Save progress when leaving / hiding */
window.addEventListener("beforeunload", () => savePosition(true));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) savePosition(true);
});

/* ---------------- Init ---------------- */

setRate(settings.rate);
setMode(mode);
applyVolume();
renderPlaylist();
updateEmptyState();
playlistEl.classList.add("collapsed");
stage.classList.add("paused");
