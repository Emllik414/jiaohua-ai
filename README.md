# 饺划-AI划词助手 (JiaoHua AI Selection Assistant)

划词即用 AI 的工具 —— 选中文本即调用 AI 翻译、解释、总结。

## 项目结构

```
D:\项目管理\JiaoHua AI
├── electron/
│   ├── main.cjs                 # 主进程：IPC、LLM 调用、窗口管理、生命周期
│   ├── preload.cjs              # 预加载脚本：IPC 桥接
│   ├── selection-engine.cjs     # 取词引擎：Browser/UIA/Clipboard/OCR 候选池
│   └── floating-layout.cjs      # 悬浮窗布局计算
├── src/
│   ├── App.tsx                  # 渲染进程：工具条、结果卡片、设置、历史
│   └── toolbar/
│       ├── Toolbar.tsx          # 工具条组件
│       ├── ResultCardChrome.tsx # 结果卡片外壳
│       └── toolbar.css          # 工具条样式
├── browser-extension/
│   ├── manifest.json            # Chrome 扩展清单
│   ├── content.js               # 网页内容脚本：selection 捕获
│   └── background.js            # Service Worker：心跳 + 自动重注入
├── tools/
│   └── uia-selection-provider.ps1  # UIA 取词 PowerShell 脚本
├── scripts/
│   ├── check-and-launch.ps1        # 启动检查脚本
│   └── start-jiaohua-dev-hidden.vbs # 无窗口启动器
├── assets/                         # 图标资源
├── data/                           # 运行时数据（.gitignore）
└── docs/
    └── MIGRATION.md              # 用户数据迁移指南
```

## 启动方式

### 开发启动（推荐）

双击桌面 `饺划-AI划词助手 开发启动器` 快捷方式，或：

```cmd
cd /d "D:\项目管理\JiaoHua AI"
npx electron .
```

### 构建

```cmd
npm run build
```

### 取词引擎测试

```cmd
node selection_engine_fusion_tests.cjs
```

## Git 历史

```
d827855 fix extension metadata encoding and gitignore
a9c28ba fix result card lifecycle and logging
53a819a optimize selection capture
78b4532 fix llm abort signal propagation
a8e796b add user data migration after app rename
c8ddab1 Initial commit: 饺划-AI划词助手 v0.1.0
```

## 近期修复（2026-07-07）

| 问题 | 修复 | 文件 |
|------|------|------|
| P0: LLM AbortController signal 未传递 | dispatchByApiType 关联外部 signal | main.cjs |
| P1: 结果卡片 resize 高频触发 | 100ms throttle + rAF 单次 pending | App.tsx |
| P1: manifest.json 中文乱码 | UTF-8 + short_name | manifest.json |
| P1: data/ 配置未在 .gitignore 中 | 添加 provider/store/hotkey/release | .gitignore |
| P2: 桌面取词慢 200ms | BrowserProvider 跳过非浏览器进程 | selection-engine.cjs |
| P2: captureViaEngine 无超时 | 2000ms / 3000ms 超时保护 | main.cjs |
| P2: overlayState 阻止新划词 | 新 selection 先 reset 旧状态再显示 | main.cjs, App.tsx |
| Obsidian 导入失败 | vaultPath 应为目录路径（已在设置页修复） | — |
| Obsidian 重复导入 | saveToObsidianNote 增加 savedToObsidian 检查 | main.cjs |

## 已知问题

- Obsidian 划词偶尔不精准（候选池仲裁边界情况）
- 无 electron-builder 打包配置（当前只有 frontend build）
- 浏览器扩展需手动加载（Chrome → 扩展程序 → 加载已解压的扩展程序）
- 无自动清理旧 Electron 进程机制（启动器只检测不杀进程）

## 数据迁移

见 `docs/MIGRATION.md`。

## 浏览器扩展

- 目录：`browser-extension/`
- Chrome Web Store 上架前需修复 manifest.json 编码（已修）
- content.js 支持：普通网页、YouTube 字幕、Trancy 双语字幕
- 通信方式：POST `http://127.0.0.1:17321/selection`

## 配置文件位置

```
%APPDATA%\jiaohua-ai-selection-assistant\data\
├── store.json            # 应用设置 + 技能 + 历史记录
├── provider-config.json  # Provider + API Key（加密存储）
└── hotkey-config.json    # 快捷键配置
```

## 日志

- 启动日志：`D:\项目管理\JiaoHua AI\logs\launcher.log`

## 取词引擎架构

```
BrowserProvider (10)   ← 浏览器 content script HTTP payload
WindowsUIAProvider (30) ← PowerShell UIA TextPattern
OCRProvider (50)       ← 图片/视频 OCR
ClipboardProvider (90) ← Ctrl+C 兜底，自适应等待 120-400ms
ManualFallbackProvider (99) ← 词块选择卡片
```