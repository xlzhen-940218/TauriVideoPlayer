# 西瓜视频播放器 🍉🎬

<div align="center">

<img src="src/assets/logo.svg" width="120" height="120" alt="西瓜视频播放器 Logo" />

### 西瓜视频播放器 (Xigua Video Player)

一款极简、高颜值、轻量快速的全格式桌面视频播放器。

![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB?style=flat-square&logo=tauri&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?style=flat-square&logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

</div>

---

## 🍉 软件简介

**西瓜视频播放器** 是一款基于现代化桌面技术打造的本地视频播放软件。体积小巧、秒速启动、界面纯粹无广告，致力于为用户提供丝滑、清爽的本地观影体验。

无需繁琐配置第三方解码器，无论是手机拍摄的 MP4、高清电影常用的 MKV，还是 WebM、AVI、MOV、TS、FLV 等格式，拖入即播。

---

## ✨ 主要功能

- 🎬 **全格式流畅播放**：支持 MP4、MKV、WebM、MOV、AVI、FLV、TS 等主流视频格式，开箱即用。
- ⏩ **丝滑进度控制**：支持拖拽进度条平滑快进/快退，画面连贯无闪烁。
- 🖼️ **悬停缩略图预览**：鼠标划过进度条时，浮动时间提示与画面预览缩略图实时跟随。
- ⚡ **倍速与微调**：支持 0.5x 至 3.0x 多档播放速度调节，随时根据节奏调整观影速度。
- 📸 **高清原画截图**：内置一键截图功能（快捷键 `S`），自动保存原尺寸高清画面至系统“图片”目录。
- 📺 **画中画与全屏**：支持独立浮窗画中画（PiP）置顶播放，一边工作一边追剧；全屏沉浸播放时自动隐藏控制面板。
- 📑 **播放列表与记忆续播**：
  - 支持文件与文件夹批量拖拽导入；
  - 提供顺序播放、列表循环、单曲循环、随机播放等多种播放模式；
  - 自动记忆播放进度与音量偏好，下次打开无缝接续。
- 🎨 **极简深色主题**：精致暗黑设计风格，搭配屏幕中央动态状态提示（OSD），交互自然流畅。

---

## ⌨️ 快捷键指南

| 快捷键 | 功能说明 |
| :--- | :--- |
| <kbd>空格</kbd> / <kbd>K</kbd> | 播放 / 暂停 |
| <kbd>←</kbd> / <kbd>→</kbd> | 快退 5 秒 / 快进 5 秒 |
| <kbd>J</kbd> / <kbd>L</kbd> | 快退 10 秒 / 快进 10 秒 |
| <kbd>↑</kbd> / <kbd>↓</kbd> | 音量增加 5% / 音量减少 5% |
| <kbd>M</kbd> | 静音 / 取消静音 |
| <kbd>F</kbd> | 进入 / 退出全屏（亦可双击视频画面） |
| <kbd>P</kbd> | 进入 / 退出画中画（PiP）模式 |
| <kbd>S</kbd> | 截取当前视频画面（自动保存到系统图片文件夹） |
| <kbd>N</kbd> / <kbd>PageDown</kbd> | 切换至下一个视频 |
| <kbd>B</kbd> / <kbd>PageUp</kbd> | 切换至上一个视频 |
| <kbd>R</kbd> | 切换循环模式（顺序播放 / 列表循环 / 单曲循环 / 随机播放） |
| <kbd>[</kbd> / <kbd>]</kbd> | 降低倍速 / 提高倍速（0.5x ~ 3.0x） |
| <kbd>?</kbd> 或 <kbd>Shift + /</kbd> | 显示 / 隐藏快捷键帮助面板 |
| <kbd>Esc</kbd> | 关闭弹窗 / 退出全屏 |

---

## 🚀 安装与运行

### 绿色单文件版（推荐）
直接运行打包生成的单文件绿色版，无需安装、随拷随用：
- 文件路径：`src-tauri/target/release/taurivideoplayer.exe`
- 体积仅约 6.2 MB，拷贝至任意位置双击即可使用。

### 源码运行与构建
如需从源码编译或二次开发：

1. **环境准备**：
   - 安装 [Rust](https://rustup.rs/) (1.77+)
   - 安装 [Node.js](https://nodejs.org/) (18+)

2. **本地调试启动**：
   ```bash
   cd src-tauri
   cargo run
   ```

3. **打包生成单文件版**：
   ```bash
   cd src-tauri
   cargo build --release
   ```

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 授权开源。
