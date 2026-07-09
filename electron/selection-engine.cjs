/**
 * SelectionEngine — 统一取词入口
 *
 * 设计原则：
 * 1. 所有业务层取词必须经过 SelectionEngine.getPickedInfo()
 * 2. 禁止业务层直接调用 ClipboardProvider / simulateCopy()
 * 3. Provider 按优先级链式尝试
 * 4. Clipboard 只能作为最后兜底
 * 5. 词块选择卡片只作为 ManualFallback
 *
 * 豆包黑盒分析结论（参考）：
 *   L1: Browser content script (neotix.textPicker.getPickedInfo)
 *   L2: Windows UI Automation (TextPattern::GetSelection)
 *   L3: OCR engine (内嵌 256MB Doubao.dll)
 *   L4: Clipboard fallback (最后兜底)
 */

const { clipboard } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const PERF_LOGGING = true;  // toggle all [PERF] logs; set false for production

const ENABLE_CLIPBOARD_HARD_WINNER = true;  // allow Clipboard to be hard winner in desktop race

// Clipboard V2 uses a native Win32 helper instead of PowerShell SendKeys.
// Set to false only for emergency rollback.
const USE_CLIPBOARD_V2 = true;
const CLIPBOARD_V2_TIMEOUT_MS = 650;
// Stopgap UIA timeout: PowerShell UIA is only a secondary helper now.
// Keep it short so it cannot drag Clipboard V2 selections to ~700ms.
const WINDOWS_UIA_TIMEOUT_MS = 320;

// ─── Types ────────────────────────────────────────────

/**
 * @typedef {Object} PickedInfo
 * @property {string} text — 规范化的选中文本
 * @property {string} [fullText] — 源端返回的完整文本（用于 clipboard fallback 对比）
 * @property {'browser'|'windows-uia'|'ocr'|'clipboard'|'manual'} source — 取词来源
 * @property {number} confidence — 置信度 0-1
 * @property {{x:number,y:number,width:number,height:number}} [rect] — 选区坐标
 * @property {string} [appName] — 源应用名
 * @property {string} [windowTitle] — 源窗口标题
 * @property {string} [url] — 浏览器 URL
 * @property {number} [latency] — 取词耗时 ms
 * @property {Object<string,*>} [metadata] — 附加信息
 */

/**
 * @typedef {Object} SelectionContext
 * @property {{x:number,y:number}} [cursorStart] — 划选起点（逻辑坐标）
 * @property {{x:number,y:number}} [cursorEnd] — 划选终点（逻辑坐标）
 * @property {number} [dragDistance] — 划选距离 px
 * @property {number} [dragDuration] — 划选时长 ms
 * @property {string} [foregroundWindowTitle] — 前台窗口标题
 * @property {string} [foregroundProcessName] — 前台进程名
 * @property {boolean} [isBrowser] — 是否浏览器环境
 * @property {string} [url] — 浏览器当前 URL
 * @property {Object<string,*>} [extra] — 扩展上下文
 */

// ─── SelectionProvider 接口 ──────────────────────────

class SelectionProvider {
  /**
   * 提供商标识（用于日志和调试）
   * @returns {string}
   */
  get name() {
    throw new Error('SelectionProvider.name must be implemented');
  }

  /**
   * 优先级（数字越小优先级越高）
   *  10 = browser (web 内容脚本直接取 selection)
   *  30 = windows-uia (桌面应用无障碍)
   *  50 = ocr (图片/视频)
   *  90 = clipboard (Ctrl+C 兜底)
   *  99 = manual (手动输入/词块选择)
   * @returns {number}
   */
  get priority() {
    throw new Error('SelectionProvider.priority must be implemented');
  }

  /**
   * 判断当前上下文是否可使用此 Provider
   * @param {SelectionContext} context
   * @returns {boolean}
   */
  canHandle(context) {
    return true; // 默认总是可以尝试
  }

  /**
   * 执行取词
   * @param {SelectionContext} context
   * @returns {Promise<PickedInfo|null>}
   */
  async pick(context) {
    throw new Error('SelectionProvider.pick must be implemented');
  }
}

// ─── BrowserProvider ──────────────────────────────────

/**
 * BrowserProvider — 从浏览器插件获取精准选区
 *
 * priority 最高（10），因为 content script 的 getSelection()
 * 和 token-hit-test 能拿到最精准的用户选区。
 *
 * 数据流：
 *   浏览器插件 content.js → POST http://127.0.0.1:17321/selection
 *   → main.cjs HTTP server 缓存 payload
 *   → BrowserProvider.pick() 读取缓存
 */
class BrowserProvider extends SelectionProvider {
  get name() { return 'browser'; }
  get priority() { return 10; }

  constructor(getPayloadFn) {
    super();
    this._getPayload = getPayloadFn || (() => null);
  }

  /**
   * Always returns true — the actual payload check happens in pick()
   * with a 200ms poll-wait. This is critical because the browser extension's
   * POST may not have arrived yet when canHandle is first called.
   */
  canHandle(context) {
    // Non-browser apps: skip BrowserProvider to save ~200ms polling wait.
    // The browser extension's HTTP POST never arrives for Obsidian/Notepad/Codex.
    const pn = String(context?.foregroundProcessName || '').toLowerCase();
    if (pn && !/(chrome|msedge|firefox|brave|opera|browser)/.test(pn)) {
      return false;
    }
    return true;
  }

  async pick(context) {
    const start = Date.now();

    // ⚡ Timing fix: wait up to 200ms for browser payload to arrive.
    // The browser extension sends a POST, but the mouse hook may trigger
    // SelectionEngine before the HTTP request lands. Poll-wait here.
    let p = this._getPayload();
    if (!p || !p.text) {
      await sleep(50);
      p = this._getPayload();
    }
    if (!p || !p.text) {
      await sleep(80);
      p = this._getPayload();
    }
    if (!p || !p.text) {
      await sleep(70);
      p = this._getPayload();
    }
    if (!p) return null;

    const metadata = {
      site: p.metadata?.site || '',
      method: p.metadata?.method || '',
      adapter: p.metadata?.adapter || '',
      tokens: p.metadata?.tokens || [],
      selectedTokens: p.metadata?.selectedTokens || [],
      subtitleOverlayDetected: Boolean(p.metadata?.subtitleOverlayDetected),
      needsManualSelection: Boolean(p.metadata?.needsManualSelection),
      error: p.metadata?.error || p.error || '',
      _perfReceivedAt: p._perfReceivedAt || 0,
    };

    // Keep low-confidence browser markers. Third-party subtitle overlays can be
    // visible to hit-testing but unreadable because of extension isolation.
    // Dropping this marker lets ClipboardProvider win with a copied full line.
    if (!p.text && (metadata.subtitleOverlayDetected || metadata.error)) {
      return {
        text: '',
        fullText: p.fullText || '',
        source: 'browser',
        confidence: typeof p.confidence === 'number' ? p.confidence : 0.2,
        rect: p.rect || undefined,
        appName: 'chrome.exe',
        windowTitle: p.title || '',
        url: p.url || '',
        latency: Date.now() - start,
        error: metadata.error,
        metadata,
      };
    }

    if (!p.text) return null;

    return {
      text: p.text,
      fullText: p.fullText || p.text,
      source: 'browser',
      confidence: p.confidence || 0.85,
      rect: p.rect || undefined,
      appName: 'chrome.exe',
      windowTitle: p.title || '',
      url: p.url || '',
      latency: Date.now() - start,
      metadata,
    };
  }
}

// ─── WindowsUIAProvider ───────────────────────────────

/**
 * WindowsUIAProvider — 通过 UIA TextPattern 获取选中文字
 *
 * 调用外部 Python 脚本 (uia_selection_poc.py) 实现。
 * 只在 Windows 平台启用。
 *
 * 超时：500ms — 如果 Python 脚本在 500ms 内未返回，自动 fallback。
 */
class WindowsUIAProvider extends SelectionProvider {
  get name() { return 'windows-uia'; }
  get priority() { return 30; }

  constructor(scriptPath) {
    super();
    this._scriptPath = scriptPath || (() => {
  const packagedPath = path.join(typeof process !== 'undefined' && process.resourcesPath ? process.resourcesPath : '', 'tools', 'uia-selection-provider.ps1');
  try { if (require('fs').existsSync(packagedPath)) return packagedPath; } catch (_) {}
  return path.join(__dirname, '..', 'tools', 'uia-selection-provider.ps1');
})();
    this._enabled = process.platform === 'win32';
  }

  canHandle(context) {
    const _aid = context?._perfAttemptId || '';
    const pn = String(context?.foregroundProcessName || "").toLowerCase();
    const title = String(context?.foregroundWindowTitle || "").toLowerCase();

    if (!this._enabled) {
      console.log('[UIACanHandleDebug]', JSON.stringify({ attemptId: _aid, processName: pn, windowTitle: title, result: false, reason: 'disabled' }));
      return false;
    }

    // Terminal safety: never start a UIA+Clipboard race for terminal windows.
    // In a terminal, Clipboard V2 must not send Ctrl+C because it can interrupt npm/electron.
    if (isTerminalLikeContext(context)) {
      console.log('[UIACanHandleDebug]', JSON.stringify({ attemptId: _aid, processName: pn, windowTitle: title, result: false, reason: 'terminal_skipped' }));
      return false;
    }

    // These apps are better handled by BrowserProvider or Clipboard V2.
    // The current PowerShell UIA path is slow to cold-start and usually returns invalid here.
    if (isFastClipboardPreferredContext(context)) {
      console.log('[UIACanHandleDebug]', JSON.stringify({ attemptId: _aid, processName: pn, windowTitle: title, result: false, reason: 'clipboard_v2_preferred' }));
      return false;
    }

    console.log('[UIACanHandleDebug]', JSON.stringify({ attemptId: _aid, processName: pn, windowTitle: title, result: true, reason: 'allowed' }));
    return true;
  }

  async pick(context) {
    const startTime = Date.now();
    const timeout = WINDOWS_UIA_TIMEOUT_MS;

    try {
      const start = context.rawCursorStart || context.cursorStart || {};
      const end = context.rawCursorEnd || context.cursorEnd || {};
      if (!Number.isFinite(Number(start.x)) || !Number.isFinite(Number(start.y)) ||
          !Number.isFinite(Number(end.x)) || !Number.isFinite(Number(end.y))) {
        return null;
      }

      const args = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', this._scriptPath,
        '-StartX', String(start.x),
        '-StartY', String(start.y),
        '-EndX', String(end.x),
        '-EndY', String(end.y),
        '-ForegroundProcess', String(context.foregroundProcessName || ''),
        '-ForegroundTitle', String(context.foregroundWindowTitle || ''),
      ];

      const raw = await this._execPowerShell(args, timeout);
      if (!raw) return null;

      const parsed = this._parseOutput(raw);
      if (!parsed || !parsed.text) return null;

     const _duration = Date.now() - startTime;
     const _uiaResult = {
       text: parsed.text,
       fullText: parsed.text,
       source: 'windows-uia',
       confidence: parsed.confidence || 0.8,
       rect: parsed.rect || undefined,
       appName: parsed.appName || undefined,
       windowTitle: parsed.windowTitle || undefined,
       latency: _duration,
       metadata: {
         method: parsed.method || '',
         uiaConfidence: parsed.confidence || 0,
         fullTextPreview: (parsed.fullText || '').slice(0, 120),
         error: parsed.error || '',
       },
     };
     console.log('[UIAResultDebug]', JSON.stringify({
       attemptId: context?._perfAttemptId || '',
       processName: context?.foregroundProcessName || '',
       windowTitle: context?.foregroundWindowTitle || '',
       hasResult: true,
       textLen: (_uiaResult.text || '').length,
       textPreview: String(_uiaResult.text || '').slice(0, 80),
       confidence: _uiaResult.confidence,
       conf: parsed.confidence,
       source: _uiaResult.source,
       method: parsed.method || '',
       metadataMethod: _uiaResult.metadata.method,
       error: parsed.error || '',
       rawKeys: Object.keys(_uiaResult),
       metadataKeys: Object.keys(_uiaResult.metadata)
     }));
     return _uiaResult;
    } catch (err) {
      return null;
    }
  }

  _execPowerShell(args, timeoutMs) {
    return new Promise((resolve) => {
      const child = execFile(
        'powershell.exe', args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            if (stderr) console.warn('[WindowsUIAProvider] helper error:', String(stderr).slice(0, 300));
            resolve(null);
            return;
          }
          resolve(stdout || null);
        }
      );
      const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve(null); }, timeoutMs + 100);
      child.on('close', () => clearTimeout(timer));
    });
  }

  _parseOutput(raw) {
    try {
      const data = JSON.parse(raw.trim());
      if (!data || typeof data !== 'object') return null;
      return {
        text: (data.text || '').trim(),
        fullText: (data.fullText || data.text || '').trim(),
        confidence: typeof data.confidence === 'number' ? data.confidence : 0,
        rect: data.rect || null,
        appName: data.appName || '',
        windowTitle: data.windowTitle || '',
        method: data.method || data.strategy || '',
        error: data.error || '',
      };
    } catch (_) { return null; }
  }
}

// ─── ClipboardProvider ────────────────────────────────

class OCRProvider extends SelectionProvider {
  get name() { return 'ocr'; }
  get priority() { return 50; }

  constructor() {
    super();
    this._enabled = process.platform === 'win32';
  }

  canHandle(context) {
    return this._enabled && context && context.cursorStart && context.cursorEnd;
  }

  async pick(context) {
    const startTime = Date.now();
    const rect = this._captureRect(context);
    if (!rect || rect.width < 8 || rect.height < 8) return null;

    try {
      const raw = await this._runWindowsOcr(rect, 1600);
      if (!raw) return null;
      const parsed = this._parseOutput(raw);
      if (!parsed || !parsed.text) return null;
      const selectedText = this._selectWords(parsed.words, rect, context) || parsed.text;
      return {
        text: selectedText,
        fullText: parsed.text,
        source: 'ocr',
        confidence: selectedText !== parsed.text ? Math.max(parsed.confidence || 0.78, 0.84) : (parsed.confidence || 0.78),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        latency: Date.now() - startTime,
        metadata: {
          method: 'windows-media-ocr-screen-crop',
          language: parsed.language || '',
          ocrWordFiltered: selectedText !== parsed.text,
        },
      };
    } catch (_) {
      return null;
    }
  }

  _captureRect(context) {
    const startPoint = context.rawCursorStart || context.cursorStart;
    const endPoint = context.rawCursorEnd || context.cursorEnd;
    const sx = Number(startPoint.x);
    const sy = Number(startPoint.y);
    const ex = Number(endPoint.x);
    const ey = Number(endPoint.y);
    if (![sx, sy, ex, ey].every(Number.isFinite)) return null;

    const left = Math.min(sx, ex);
    const right = Math.max(sx, ex);
    const top = Math.min(sy, ey);
    const bottom = Math.max(sy, ey);
    const dragW = Math.max(1, right - left);
    const dragH = Math.max(1, bottom - top);
    const padX = Math.max(14, Math.min(50, dragW * 0.22));
    const padY = Math.max(24, Math.min(56, dragH * 2.2));

    return {
      x: Math.max(0, Math.round(left - padX)),
      y: Math.max(0, Math.round(top - padY)),
      width: Math.max(28, Math.round(dragW + padX * 2)),
      height: Math.max(34, Math.round(dragH + padY * 2)),
    };
  }

  _runWindowsOcr(rect, timeoutMs) {
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 })[0]
function Await($op, [Type]$type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  return $task.GetAwaiter().GetResult()
}
$x = ${rect.x}
$y = ${rect.y}
$w = ${rect.width}
$h = ${rect.height}
$path = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), ('aisel-ocr-' + [Guid]::NewGuid().ToString('N') + '.png'))
$bitmap = New-Object System.Drawing.Bitmap($w, $h)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($x, $y, 0, 0, [System.Drawing.Size]::new($w, $h))
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $softwareBitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { throw 'Windows OCR engine unavailable' }
  $result = Await ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
  $text = (($result.Text -replace '\\s+', ' ').Trim())
  $words = @()
  foreach ($line in $result.Lines) {
    foreach ($word in $line.Words) {
      $words += [PSCustomObject]@{
        text = $word.Text
        x = [double]$word.BoundingRect.X
        y = [double]$word.BoundingRect.Y
        width = [double]$word.BoundingRect.Width
        height = [double]$word.BoundingRect.Height
      }
    }
  }
  $confidence = 0.72
  if ($text.Length -gt 0 -and $text.Length -le 60) { $confidence = 0.82 }
  [PSCustomObject]@{
    text = $text
    words = $words
    confidence = $confidence
    language = $engine.RecognizerLanguage.LanguageTag
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}
`;

    return new Promise((resolve) => {
      const child = execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 512 * 1024 },
        (error, stdout) => {
          if (error) { resolve(null); return; }
          resolve(stdout || null);
        }
      );
      const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve(null); }, timeoutMs + 150);
      child.on('close', () => clearTimeout(timer));
    });
  }

  _parseOutput(raw) {
    try {
      const data = JSON.parse(String(raw || '').trim());
      const text = String(data.text || '').replace(/\s+/g, ' ').trim();
      if (!text) return null;
      return {
        text,
        confidence: typeof data.confidence === 'number' ? data.confidence : 0.78,
        language: data.language || '',
        words: Array.isArray(data.words) ? data.words : [],
      };
    } catch (_) {
      return null;
    }
  }

  _selectWords(words, cropRect, context = {}) {
    if (!Array.isArray(words) || !words.length || !cropRect || !context) return '';
    const startPoint = context.rawCursorStart || context.cursorStart;
    const endPoint = context.rawCursorEnd || context.cursorEnd;
    if (!startPoint || !endPoint) return '';
    const sx = Number(startPoint.x);
    const sy = Number(startPoint.y);
    const ex = Number(endPoint.x);
    const ey = Number(endPoint.y);
    if (![sx, sy, ex, ey].every(Number.isFinite)) return '';

    const drag = {
      left: Math.min(sx, ex) - 3,
      right: Math.max(sx, ex) + 3,
      top: Math.min(sy, ey) - 10,
      bottom: Math.max(sy, ey) + 10,
    };

    const ranked = words
      .map((word, index) => {
        const text = String(word.text || '').trim();
        const rect = {
          left: cropRect.x + Number(word.x || 0),
          top: cropRect.y + Number(word.y || 0),
          right: cropRect.x + Number(word.x || 0) + Number(word.width || 0),
          bottom: cropRect.y + Number(word.y || 0) + Number(word.height || 0),
          width: Number(word.width || 0),
          height: Number(word.height || 0),
        };
        const overlapX = Math.max(0, Math.min(rect.right, drag.right) - Math.max(rect.left, drag.left));
        const overlapY = Math.max(0, Math.min(rect.bottom, drag.bottom) - Math.max(rect.top, drag.top));
        const overlapArea = overlapX * overlapY;
        const overlapRatioX = overlapX / Math.max(1, rect.width);
        const overlapRatioArea = overlapArea / Math.max(1, rect.width * rect.height);
        const cx = (rect.left + rect.right) / 2;
        const cy = (rect.top + rect.bottom) / 2;
        const centerInside = cx >= drag.left && cx <= drag.right && cy >= drag.top && cy <= drag.bottom;
        const selected = text && rect.width > 0 && rect.height > 0 && (centerInside || overlapRatioX >= 0.35 || overlapRatioArea >= 0.22);
        return { index, text, rect, selected, overlapArea, overlapRatioX };
      })
      .filter((item) => item.text);

    let selected = ranked.filter((item) => item.selected);
    if (!selected.length) {
      const best = [...ranked].sort((a, b) => b.overlapArea - a.overlapArea)[0];
      if (best && best.overlapArea > 0) selected = [best];
    }
    if (!selected.length) return '';

    selected.sort((a, b) => a.index - b.index);
    return selected.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim();
  }
}


class ClipboardProviderV2 extends SelectionProvider {
  get name() { return 'clipboard-v2'; }
  get priority() { return 89; }

  constructor(helperPath) {
    super();
    this._helperPath = helperPath || resolveClipboardHelperPath();
    this._enabled = process.platform === 'win32';
  }

  canHandle(context) {
    if (!this._enabled) return false;

    // Safety: do not send Ctrl+C into terminals. In Windows Terminal / cmd /
    // PowerShell, Ctrl+C means "interrupt process", not "copy selection".
    if (isTerminalLikeContext(context)) {
      const attemptId = context?._perfAttemptId || '';
      console.log('[ClipboardV2] skip_terminal', JSON.stringify({
        attemptId,
        processName: context?.foregroundProcessName || '',
        windowTitle: context?.foregroundWindowTitle || ''
      }));
      return false;
    }

    return true;
  }

  async pick(context = {}) {
    const attemptId = context?._perfAttemptId || '';
    const startedAt = Date.now();
    console.log('[ClipboardV2] request_start', JSON.stringify({ attemptId, at: startedAt }));

    const helperPath = this._helperPath;
    const helperExists = safeExists(helperPath);
    console.log('[ClipboardV2] sequence_before', JSON.stringify({ attemptId, at: Date.now(), helperPath, exists: helperExists }));

    if (!helperExists) {
      const latency = Date.now() - startedAt;
      console.log('[ClipboardV2] helper_failed', JSON.stringify({
        attemptId,
        helperPath,
        exists: false,
        cwd: process.cwd(),
        duration: latency,
        errorMessage: 'clipboard-helper.exe not found',
        stdoutPreview: '',
        stderrPreview: '',
        parseError: ''
      }));
      return makeInvalidClipboardV2Result('helper_not_found', latency, { helperPath, exists: false });
    }

    let stdout = '';
    let stderr = '';
    let execError = null;
    try {
      const out = await execFileCapture(helperPath, [], CLIPBOARD_V2_TIMEOUT_MS);
      stdout = out.stdout || '';
      stderr = out.stderr || '';
      execError = out.error || null;
    } catch (err) {
      execError = err;
      stdout = err?.stdout || '';
      stderr = err?.stderr || '';
    }

    const duration = Date.now() - startedAt;

    let data = null;
    let parseError = null;
    const rawStdout = String(stdout || '').trim();
    try {
      if (rawStdout) data = JSON.parse(rawStdout);
    } catch (err) {
      parseError = err;
    }

    // Important: execFile reports an error when the helper exits with a non-zero code,
    // even if stdout already contains valid JSON. Prefer valid JSON because it is the
    // helper's structured result. Only treat execError as fatal when JSON is absent.
    if (!data && execError) {
      console.log('[ClipboardV2] helper_failed', JSON.stringify({
        attemptId,
        helperPath,
        exists: helperExists,
        cwd: process.cwd(),
        duration,
        errorMessage: execError?.message || '',
        errorCode: execError?.code || '',
        signal: execError?.signal || '',
        stdoutPreview: String(stdout || '').slice(0, 1000),
        stderrPreview: String(stderr || '').slice(0, 1000),
        parseError: parseError?.message || ''
      }));
      return makeInvalidClipboardV2Result('helper_exec_failed', duration, { helperPath, stdout, stderr, execError: execError?.message || '' });
    }

    if (!data || parseError) {
      console.log('[ClipboardV2] helper_failed', JSON.stringify({
        attemptId,
        helperPath,
        exists: helperExists,
        cwd: process.cwd(),
        duration,
        errorMessage: execError?.message || '',
        errorCode: execError?.code || '',
        signal: execError?.signal || '',
        stdoutPreview: String(stdout || '').slice(0, 1000),
        stderrPreview: String(stderr || '').slice(0, 1000),
        parseError: parseError?.message || 'empty helper output'
      }));
      return makeInvalidClipboardV2Result('helper_json_parse_failed', duration, { helperPath, stdout, stderr, parseError: parseError?.message || '' });
    }

    const text = String(data.text || '').trim();
    const changed = data.changed === true;
    const previousText = String(data.previousText || '');
    const sequenceBefore = Number(data.sequenceBefore || 0);
    const sequenceAfter = Number(data.sequenceAfter || 0);
    const helperDuration = Number(data.durationMs || data.latency || duration);
    const timings = data.timings || {};
    const pollTimeMs = Number(data.pollTimeMs || timings.pollMs || 0);

    console.log('[ClipboardV2] sendinput_done', JSON.stringify({
      attemptId,
      changed,
      pollTimeMs,
      textLen: text.length,
      sequenceBefore,
      sequenceAfter,
      durationMs: helperDuration,
      error: data.error || ''
    }));

    if (!data.ok || !changed) {
      console.log('[ClipboardV2] clipboard_not_changed', JSON.stringify({
        attemptId,
        changed,
        sequenceBefore,
        sequenceAfter,
        pollTimeMs,
        durationMs: helperDuration,
        error: data.error || 'clipboard_not_changed'
      }));
      return makeInvalidClipboardV2Result(data.error || 'clipboard_not_changed', duration, { data });
    }

    if (!text) {
      console.log('[ClipboardV2] invalid_result', JSON.stringify({ attemptId, reason: 'empty_text', durationMs: helperDuration }));
      return makeInvalidClipboardV2Result('empty_text', duration, { data });
    }

    const sameAsPrevious = !!(previousText && text === previousText.trim());
    const previousFragment = isLikelyPreviousClipboardFragment(text, previousText);
    if (sameAsPrevious || previousFragment) {
      // Do not hard-block this when the OS sequence number changed. The user may
      // legitimately select the same text twice. Keep the flags for scoring/debug.
      console.log('[ClipboardV2] previous_text_match', JSON.stringify({
        attemptId,
        sameAsPrevious,
        previousFragment,
        durationMs: helperDuration,
        textLen: text.length
      }));
    }

    if (text.length > 3000) {
      console.log('[ClipboardV2] invalid_result', JSON.stringify({ attemptId, reason: 'too_long_without_rect', durationMs: helperDuration, textLen: text.length }));
      return makeInvalidClipboardV2Result('too_long_without_rect', duration, { data });
    }

    const confidence = calculateClipboardV2Confidence(text, context);
    if (confidence < 0.5) {
      console.log('[ClipboardV2] invalid_result', JSON.stringify({ attemptId, reason: 'low_confidence', confidence, durationMs: helperDuration, textLen: text.length }));
      return makeInvalidClipboardV2Result('low_confidence', duration, { data, confidence });
    }

    console.log('[ClipboardV2] valid_result', JSON.stringify({
      attemptId,
      textLen: text.length,
      confidence,
      pollTimeMs,
      durationMs: helperDuration,
      sequenceBefore,
      sequenceAfter
    }));

    return {
      text,
      fullText: text,
      // Keep source as clipboard so existing scoring / toolbar code remains compatible.
      source: 'clipboard',
      confidence,
      rect: null,
      latency: duration,
      metadata: {
        method: 'clipboard-v2-sendinput-sequence',
        clipboardProvider: 'clipboard-v2',
        clipboardChanged: true,
        changed: true,
        sequenceBefore,
        sequenceAfter,
        pollTimeMs,
        durationMs: helperDuration,
        timings,
        previousTextPreview: String(previousText || '').slice(0, 80),
        sameAsPrevious,
        previousFragment,
        error: ''
      }
    };
  }
}

class ClipboardProvider extends SelectionProvider {
  get name() { return 'clipboard'; }
  get priority() { return 90; }

  canHandle(context) {
    // clipboard provider 始终可用（作为最后兜底）
    return true;
  }

  async pick(context) {
    const startTime = Date.now();
    const _aid = (context && context._perfAttemptId) || '';

    // 1. 保存剪贴板原始内容
    const _backupStart = Date.now();
    console.log('[ClipboardTiming]', JSON.stringify({ stage: 'clipboard_backup_start', attemptId: _aid, duration: 0, textLen: 0, changed: false, error: '' }));
    let previous = '';
    try {
      previous = clipboard.readText() || '';
    } catch (_) { /* ignore */ }
    console.log('[ClipboardTiming]', JSON.stringify({ stage: 'clipboard_backup_end', attemptId: _aid, duration: Date.now() - _backupStart, textLen: previous.length, changed: false, error: '' }));

    // 2. 模拟 Ctrl+C
    const _ctrlCStart = Date.now();
    console.log('[ClipboardTiming]', JSON.stringify({ stage: 'send_ctrl_c_start', attemptId: _aid, duration: 0, textLen: 0, changed: false, error: '' }));
    await simulateCtrlC();
    console.log('[ClipboardTiming]', JSON.stringify({ stage: 'send_ctrl_c_end', attemptId: _aid, duration: Date.now() - _ctrlCStart, textLen: 0, changed: false, error: '' }));

    // 3. 等待剪贴板更新
    const dragDist = context?.dragDistance || 0;
    const waitTime = dragDist < 50 ? 120 : dragDist < 200 ? 180 : dragDist < 500 ? 280 : 400;
    const _waitStart = Date.now();
    console.log('[ClipboardTiming]', JSON.stringify({ stage: 'wait_clipboard_changed_start', attemptId: _aid, duration: 0, textLen: 0, changed: false, error: '' }));
    await sleep(waitTime);
    console.log('[ClipboardTiming]', JSON.stringify({ stage: 'wait_clipboard_changed_end', attemptId: _aid, duration: Date.now() - _waitStart, textLen: 0, changed: false, error: '' }));

    // 4. 读取剪贴板
    const _readStart = Date.now();
    console.log('[ClipboardTiming]', JSON.stringify({ stage: 'read_clipboard_start', attemptId: _aid, duration: 0, textLen: 0, changed: false, error: '' }));
    let selected = '';
    try {
      selected = (clipboard.readText() || '').trim();
    } catch (_) { /* ignore */ }
    console.log('[ClipboardTiming]', JSON.stringify({ stage: 'read_clipboard_end', attemptId: _aid, duration: Date.now() - _readStart, textLen: selected.length, changed: false, error: '' }));

    // 5. 恢复原始剪贴板
    const _restoreStart = Date.now();
    console.log('[ClipboardTiming]', JSON.stringify({ stage: 'restore_clipboard_start', attemptId: _aid, duration: 0, textLen: 0, changed: false, error: '' }));
    try {
      clipboard.writeText(previous || '');
    } catch (_) { /* ignore */ }
    console.log('[ClipboardTiming]', JSON.stringify({ stage: 'restore_clipboard_end', attemptId: _aid, duration: Date.now() - _restoreStart, textLen: 0, changed: false, error: '' }));

    const latency = Date.now() - startTime;
    console.log('[ClipboardTiming]', JSON.stringify({ stage: 'clipboard_total', attemptId: _aid, duration: latency, textLen: selected.length, changed: false, error: '' }));

    // 6. 校验
    if (!selected) {
      return null;
    }
    const isSameText = selected === (previous || '').trim();
    const confidence = isSameText
      ? Math.min(calculateClipboardConfidence(selected, context), 0.45)
      : calculateClipboardConfidence(selected, context);

    return {
      text: selected,
      fullText: selected,
      source: 'clipboard',
      confidence,
      latency,
      metadata: {
        method: 'clipboard-simulate-ctrl-c',
        clipboardChanged: !isSameText,
        previousTextPreview: String(previous || '').slice(0, 40),
      },
    };
  }
}

// ─── ManualFallbackProvider ──────────────────────────

class ManualFallbackProvider extends SelectionProvider {
  get name() { return 'manual'; }
  get priority() { return 99; }

  canHandle(context) {
    // manual fallback 始终可用（最低优先级）
    return true;
  }

  async pick(context) {
    // 此 Provider 不执行实际取词，而是返回一个信号
    // 告诉上层需要触发词块选择卡片
    return {
      text: '',
      source: 'manual',
      confidence: 0,
      metadata: { needsManualSelection: true },
    };
  }
}

// ─── 辅助函数 ─────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function simulateCtrlC() {
  return new Promise((resolve) => {
    const script =
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
      () => resolve()
    );
  });
}

function resolveClipboardHelperPath() {
  const candidates = [];
  try {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'tools', 'clipboard-helper.exe'));
      candidates.push(path.join(process.resourcesPath, 'clipboard-helper.exe'));
    }
  } catch (_) {}
  candidates.push(path.join(__dirname, '..', 'tools', 'clipboard-helper.exe'));
  candidates.push(path.join(process.cwd(), 'tools', 'clipboard-helper.exe'));
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) {}
  }
  return candidates[candidates.length - 1];
}

function safeExists(filePath) {
  try { return !!filePath && fs.existsSync(filePath); } catch (_) { return false; }
}

function isTerminalLikeContext(context) {
  const pn = String(context?.foregroundProcessName || '').toLowerCase();
  const title = String(context?.foregroundWindowTitle || '').toLowerCase();
  const app = String(context?.appName || '').toLowerCase();
  const joined = `${pn} ${title} ${app}`;

  return (
    pn.includes('windowsterminal') ||
    pn === 'cmd' ||
    pn === 'cmd.exe' ||
    pn.includes('powershell') ||
    pn === 'pwsh' ||
    pn === 'pwsh.exe' ||
    pn.includes('conhost') ||
    joined.includes('cmd.exe') ||
    joined.includes('powershell') ||
    joined.includes('windows powershell') ||
    joined.includes('terminal')
  );
}

function isFastClipboardPreferredContext(context) {
  const pn = String(context?.foregroundProcessName || '').toLowerCase();
  const title = String(context?.foregroundWindowTitle || '').toLowerCase();
  const app = String(context?.appName || '').toLowerCase();
  const joined = `${pn} ${title} ${app}`;

  // Browser/web content should remain on BrowserProvider; desktop browser edge cases use Clipboard V2.
  if (/(chrome|msedge|firefox|brave|opera|browser)/.test(joined)) return true;

  // Electron / code-editor apps: UIA usually cannot access real selected text and only delays the result.
  if (/(obsidian|codex|electron|visual studio code|vscode|\bcode\b|notion|slack|discord)/.test(joined)) return true;

  // Notepad selection is very reliable through Clipboard V2 and the current UIA helper often cold-starts slowly.
  if (/(notepad|记事本)/.test(joined)) return true;

  return false;
}


function execFileCapture(filePath, args = [], timeoutMs = 650) {
  return new Promise((resolve) => {
    execFile(
      filePath,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 512 * 1024 },
      (error, stdout, stderr) => {
        resolve({ error, stdout: stdout || '', stderr: stderr || '' });
      }
    );
  });
}

function makeInvalidClipboardV2Result(error, latency, extra = {}) {
  return {
    text: '',
    fullText: '',
    source: 'clipboard',
    confidence: 0,
    rect: null,
    latency: latency || 0,
    metadata: {
      method: 'clipboard-v2-sendinput-sequence',
      clipboardProvider: 'clipboard-v2',
      clipboardChanged: false,
      changed: false,
      error: error || 'clipboard_v2_invalid',
      ...extra,
    },
  };
}

function isLikelyPreviousClipboardFragment(text, previousText) {
  const t = String(text || '').trim();
  const p = String(previousText || '').trim();
  if (!t || !p || t.length < 4) return false;
  if (p.includes(t) && p.length > t.length) return true;
  // Block common stale terminal / project-path fragments seen in logs.
  if (/^(cd\s+|npm\s+|npx\s+|[A-Za-z]:\\|\\项目管理|项目管理\\|run\s+start)/i.test(t)) return true;
  return false;
}

function calculateClipboardV2Confidence(text, context) {
  const value = String(text || '').trim();
  const len = value.length;
  const lines = value.split(/\r?\n/).filter(Boolean).length;
  const words = value.split(/\s+/).filter(Boolean).length;
  if (!value) return 0;
  if (len > 3000) return 0;
  if (lines > 6) return 0.5;
  if (len <= 30 && words <= 6) return 0.85;
  if (len <= 120 && lines <= 2) return 0.75;
  if (len <= 300) return 0.65;
  if (len <= 3000) return 0.5;
  return 0;
}

function isClipboardLikeProvider(provider) {
  return provider && (provider.name === 'clipboard' || provider.name === 'clipboard-v2');
}


/**
 * 计算 clipboard 取词的置信度
 *
 * 原理：clipboard 的局限是 Ctrl+C 可能拿到整句而非划选的几个词。
 * 根据上下文特征降低置信度：
 * - 文本很短（<20字符）→ 高置信度（大概率就是划选的）
 * - 文本很长且是多行 → 低置信度（可能拿到整段）
 * - 文本有换行 → 可能是整句复制
 */
function calculateClipboardConfidence(text, context) {
  const len = (text || '').length;
  const lines = (text || '').split(/\r?\n/).filter(Boolean).length;
  const words = (text || '').trim().split(/\s+/).length;

  if (context && context.subtitleOverlayDetected) {
    if (words > 3 || len > 24) return 0.3;
    return 0.4;
  }

  // 划选距离很小 + 文本很短 → 很可能是精准选区
  if (len <= 20 && words <= 3) return 0.85;

  // 划选距离较大但文本不长 → 合理
  if (len <= 60 && words <= 8 && lines === 1) return 0.7;

  // 单行中等长度
  if (len <= 120 && lines === 1) return 0.55;

  // 多行或长文本 → 大概率不是精确选区
  if (lines > 1) return 0.5;
  if (len > 120) return 0.45;

  return 0.5;
}

// ─── 融合评分系统 ─────────────────────────────────────

/**
 * Provider 基础权重
 */
const SOURCE_WEIGHT = {
  'browser': 90,
  'windows-uia': 80,
  'ocr': 70,
  'clipboard': 45,
  'manual': 20,
};

/**
 * 场景 → 主 Provider 路由表
 */
const PROVIDER_STRATEGY = {
  youtube:    { primary: 'browser',    boost: 20 },
  webpage:    { primary: 'browser',    boost: 15 },
  qq:         { primary: 'windows-uia', boost: 15 },
  word:       { primary: 'windows-uia', boost: 15 },
  pdf:        { primary: 'windows-uia', boost: 10 },
  notepad:    { primary: 'windows-uia', boost: 10 },
  image:      { primary: 'ocr',        boost: 25 },
  game:       { primary: 'ocr',        boost: 25 },
  video:      { primary: 'ocr',        boost: 25 },
  unknown:    { primary: null,         boost: 0 },
};

function detectContext(candidates, context) {
  // Heuristic: detect scenario from candidate app names and window titles
  const titles = candidates.map(c => (c.windowTitle || '').toLowerCase()).join(' ');
  const apps = candidates.map(c => (c.appName || '').toLowerCase()).join(' ');
  const urls = candidates.map(c => (c.url || '').toLowerCase()).join(' ');

  if (urls.includes('youtube.com') || titles.includes('youtube')) return 'youtube';
  if (apps.includes('chrome') || apps.includes('msedge') || apps.includes('firefox')) return 'webpage';
  if (apps.includes('qq') || titles.includes('qq') || titles.includes('腾讯')) return 'qq';
  if (apps.includes('winword') || titles.includes('word') || titles.includes('docx')) return 'word';
  if (apps.includes('acrobat') || titles.includes('pdf') || titles.includes('adobe')) return 'pdf';
  if (apps.includes('notepad') || titles.includes('记事本')) return 'notepad';
  if (apps.includes('photos') || titles.includes('图片') || titles.includes('照片')) return 'image';
  if (apps.includes('game') || titles.includes('game')) return 'game';
  if (apps.includes('player') || titles.includes('播放')) return 'video';
  if (apps.includes('obsidian') || titles.includes('obsidian')) return 'obsidian';
  if (apps.includes('electron') || titles.includes('electron')) return 'electron';
  return 'unknown';
}

function scoreCandidate(c, context, allCandidates) {
  let s = SOURCE_WEIGHT[c.source] || 30;
  const subtitleOverlayDetected = hasSubtitleOverlayMarker(allCandidates);

  // Text non-empty
  if (c.text && c.text.trim()) s += 10;

  // High confidence
  if ((c.confidence || 0) >= 0.75) s += 20;

  // Has rect
  if (c.rect) s += 10;

  // Substring of longer clipboard result → boost
  const clip = allCandidates.find(r => r.source === 'clipboard' && r.text);
  if (clip && c.source !== 'clipboard' && c.text && clip.text.includes(c.text) && c.text.length > 0) {
    s += 20;
  }

  // Multiple providers agree on same text
  const sameText = allCandidates.filter(r => r.text === c.text && r.text).length;
  if (sameText >= 2) s += 20;

  // Scenario boost
  const scenario = detectContext(allCandidates, context);
  const strategy = PROVIDER_STRATEGY[scenario] || PROVIDER_STRATEGY.unknown;
  if (c.source === strategy.primary) s += strategy.boost;

  // Penalties
  if (!c.text || !c.text.trim()) s -= 100;
  if (c.source === 'windows-uia' && c.metadata?.method === 'uia-name-estimated-word-hit-test') {
    s -= 50;
  }
  // Low-confidence generic subtitle overlay: don't dominate scoring
  if (c.source === 'browser' && c.metadata?.adapter === 'generic-subtitle-overlay' && (c.confidence || 0) < 0.5) {
    s -= 100;
  }
  if (isLikelyGarbledText(c.text)) s -= 180;
  if (c.text && c.text.length > 200) s -= 25;
  if (c.source === 'clipboard' && c.text && c.text.length > 80) s -= 25;
  if (c.source === 'clipboard' && allCandidates.some(
    r => r.source !== 'clipboard' && r.text && c.text && c.text.includes(r.text)
  )) s -= 40;
  if ((c.latency || 0) > 1500) s -= 25;
  else if ((c.latency || 0) > 800) s -= 10;
  if ((c.confidence || 0) < 0.4) s -= 30;
  if (c.source === 'clipboard' && subtitleOverlayDetected) {
    s -= 90;
    const words = String(c.text || '').trim().split(/\s+/).filter(Boolean).length;
    if (words > 3 || String(c.text || '').length > 24) s -= 30;
  }

  return s;
}

function isLikelyGarbledText(text) {
  const value = String(text || '');
  if (!value) return false;
  const replacementCount = (value.match(/\uFFFD/g) || []).length;
  if (replacementCount >= 2) return true;
  if (replacementCount === 1 && value.length <= 12) return true;
  return false;
}
function scoringBreakdown(c, context, allCandidates) {
  if (!PERF_LOGGING) return null;
  const b = {};
  b.source = c.source;
  b.baseScore = (SOURCE_WEIGHT[c.source] || 30) + (c.text && c.text.trim() ? 10 : 0) + ((c.confidence || 0) >= 0.75 ? 20 : 0) + (c.rect ? 10 : 0);
  b.rawTextLen = c.text ? c.text.length : 0;
  b.rawConfidence = c.confidence || 0;
  b.hasRect = !!c.rect;
  b.latency = c.latency || 0;
  b.penaltyLongText = (c.text && c.text.length > 200) ? -25 : 0;
  b.penaltyClipLongText = (c.source === 'clipboard' && c.text && c.text.length > 80) ? -25 : 0;
  b.penaltyGarbled = (c.text && isLikelyGarbledText(c.text)) ? -180 : 0;
  b.penaltyLatency = (c.latency || 0) > 1500 ? -25 : (c.latency || 0) > 800 ? -10 : 0;
  b.penaltyLowConf = (c.confidence || 0) < 0.4 ? -30 : 0;
  const clip = allCandidates.find(r => r.source === 'clipboard' && r.text);
  b.bonusClipSubstr = (clip && c.source !== 'clipboard' && c.text && clip.text.includes(c.text) && c.text.length > 0) ? 20 : 0;
  const sameTextCount = allCandidates.filter(r => r.text === c.text && r.text).length;
  b.bonusConsensus = (sameTextCount >= 2) ? 20 : 0;
  b.finalScore = b.baseScore + b.bonusClipSubstr + b.bonusConsensus + b.penaltyLongText + b.penaltyClipLongText + b.penaltyGarbled + b.penaltyLatency + b.penaltyLowConf;
  return b;
}

function isBrowserWebContext(context = {}, candidates = []) {
  const processName = String(context.foregroundProcessName || '').toLowerCase();
  const appNames = candidates.map((candidate) => String(candidate.appName || '').toLowerCase()).join(' ');
  const urls = candidates.map((candidate) => String(candidate.url || '').toLowerCase()).join(' ');
  return /(chrome|msedge|firefox|browser)/.test(`${processName} ${appNames}`) || /^https?:\/\//.test(urls) || urls.includes('x.com') || urls.includes('twitter.com');
}

function isUsefulClipboardSelection(candidate) {
  const text = String(candidate?.text || '').trim();
  if (!text || isLikelyGarbledText(text)) return false;
  if ((candidate.confidence || 0) < 0.45) return false;
  return text.length >= 12 || /\s/.test(text);
}

function isGenericSubtitleOverlayResult(candidate) {
  return candidate?.source === 'browser' &&
    candidate?.metadata?.adapter === 'generic-subtitle-overlay';
}

function hasSubtitleOverlayMarker(candidates) {
  return candidates.some((r) => Boolean(
    r &&
    (r.metadata?.subtitleOverlayDetected ||
      r.metadata?.error === 'third_party_extension_dom_not_accessible' ||
      r.metadata?.error === 'subtitle_overlay_precise_selection_failed' ||
      r.metadata?.error === 'subtitle_window_selection_full_line_blocked' ||
      r.error === 'third_party_extension_dom_not_accessible' ||
      r.error === 'subtitle_overlay_precise_selection_failed' ||
      r.error === 'subtitle_window_selection_full_line_blocked')
  ));
}

function isPrecisionFastPath(result, context = {}) {
  if (!result || result.source !== 'browser') return false;
  if (!result.text) {
    if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'short_circuit_skipped', reason: 'empty_text', attemptId: (context && context._perfAttemptId) || '' }));
    return false;
  }
  if (result.metadata?.error) {
    if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'short_circuit_skipped', reason: 'metadata_error', error: result.metadata.error, attemptId: (context && context._perfAttemptId) || '' }));
    return false;
  }

  const adapter = result.metadata?.adapter || '';
  const method = result.metadata?.method || '';
  const precisionAdapters = ['youtube-native-caption', 'trancy-caption'];
  const precisionMethods = ['youtube-native-token-hit-test', 'trancy-subtitle-token-hit-test', 'window-selection'];

  const isPrecisionAdapter = precisionAdapters.includes(adapter);
  const isPrecisionMethod = precisionMethods.includes(method);
  if (!isPrecisionAdapter && !isPrecisionMethod) return false;

  // Confidence threshold: subtitle adapters keep 0.86, window-selection accepts 0.82
  const isWindowSel = method === 'window-selection';
  const minConfidence = isWindowSel ? 0.82 : 0.86;
  if ((result.confidence || 0) < minConfidence) {
    if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'short_circuit_skipped', reason: 'confidence_low', confidence: result.confidence, minConfidence, method, attemptId: (context && context._perfAttemptId) || '' }));
    return false;
  }

  // Rect proximity check — reject payload whose rect is far from the drag area
  if (result.rect && context.cursorStart && context.cursorEnd) {
    const dragLeft = Math.min(context.cursorStart.x, context.cursorEnd.x);
    const dragRight = Math.max(context.cursorStart.x, context.cursorEnd.x);
    const dragTop = Math.min(context.cursorStart.y, context.cursorEnd.y);
    const dragBottom = Math.max(context.cursorStart.y, context.cursorEnd.y);
    const rectCx = result.rect.x + result.rect.width / 2;
    const rectCy = result.rect.y + result.rect.height / 2;
    const dragCx = (dragLeft + dragRight) / 2;
    const dragCy = (dragTop + dragBottom) / 2;
    const dist = Math.hypot(rectCx - dragCx, rectCy - dragCy);
    const dragDiag = Math.hypot(dragRight - dragLeft, dragBottom - dragTop);
    if (dist > Math.max(200, dragDiag * 1.5)) {
      if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'short_circuit_skipped', reason: 'rect_mismatch', dist, threshold: Math.max(200, dragDiag * 1.5), attemptId: (context && context._perfAttemptId) || '' }));
      return false;
    }
  }

  // Time-based freshness check: payload must not be significantly older than selection
  const payloadAt = result.metadata?._perfReceivedAt || 0;
  const selectionAt = context?._at || 0;
  if (selectionAt > 0 && payloadAt > 0 && payloadAt < selectionAt - 200) {
    if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'short_circuit_skipped', reason: 'payload_stale', payloadAt, selectionAt, gapMs: selectionAt - payloadAt, attemptId: (context && context._perfAttemptId) || '' }));
    return false;
  }

  if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'short_circuit_browser_window_selection', textLen: result.text.length, confidence: result.confidence, payloadAt, selectionAt, rectMatched: !!result.rect, method, adapter, attemptId: (context && context._perfAttemptId) || '' }));
  return true;
}

function createManualDecision(all, scores, reason, extraMetadata = {}) {
  return {
    text: '',
    source: 'manual',
    confidence: 0,
    candidates: all,
    reason,
    scoreBreakdown: scores || {},
    fallbackUsed: true,
    needsManualSelection: true,
    metadata: { needsManualSelection: true, ...extraMetadata },
  };
}

function cloneWithClipboardDowngrade(candidate, confidence) {
  return {
    ...candidate,
    confidence: Math.min(candidate.confidence || 0, confidence),
    metadata: {
      ...(candidate.metadata || {}),
      downgradedBecause: 'subtitle_overlay_detected',
    },
  };
}

function shouldTryOcrProvider(results, context = {}) {
  if (context.forceOcr || context.preferOcr) return true;
  if (hasSubtitleOverlayMarker(results.filter(Boolean))) return true;
  const processName = String(context.foregroundProcessName || '').toLowerCase();
  const title = String(context.foregroundWindowTitle || '').toLowerCase();
  if (/(player|game|photo|image|video|chrome|msedge|firefox)/.test(processName) && /(youtube|bilibili|netflix|trancy|tracy|字幕|视频|播放器|哔哩|b站)/.test(title)) {
    return true;
  }
  if (/(player|game|photo|image|video)/.test(processName) || /(youtube|bilibili|netflix|视频|播放器|图片|照片)/.test(title)) {
    return true;
  }
  return false;
}

function shouldAvoidClipboardProvider(results, context = {}) {
  if (hasSubtitleOverlayMarker(results.filter(Boolean))) return true;
  const processName = String(context.foregroundProcessName || '').toLowerCase();
  const title = String(context.foregroundWindowTitle || '').toLowerCase();
  if (/(chrome|msedge|firefox)/.test(processName) && /(youtube|bilibili|netflix|trancy|tracy|字幕|视频|播放器|哔哩|b站)/.test(title)) {
    return true;
  }
  return false;
}

function chooseBestPickedInfo(results, context = {}) {
  const valid = results.filter(r => r && r.text);
  const all = results.filter(Boolean);
  const subtitleOverlayDetected = hasSubtitleOverlayMarker(all);
  const decisionContext = { ...context, subtitleOverlayDetected };

  if (valid.length === 0) {
    return createManualDecision(all, {}, subtitleOverlayDetected
      ? 'subtitle_overlay_detected_no_precise_text'
      : 'no_valid_text', {
        subtitleOverlayDetected,
        error: all.find((r) => r.metadata?.error || r.error)?.metadata?.error || all.find((r) => r.error)?.error || '',
      });
  }

  if (subtitleOverlayDetected) {
    for (let i = 0; i < all.length; i += 1) {
      const r = all[i];
      if (r && r.source === 'clipboard') {
        const words = String(r.text || '').trim().split(/\s+/).filter(Boolean).length;
        all[i] = cloneWithClipboardDowngrade(r, words > 3 || String(r.text || '').length > 24 ? 0.3 : 0.4);
      }
    }
  }

  const scores = {};
  for (const c of all) {
    scores[c.source] = scoreCandidate(c, decisionContext, all);
  }

  if (subtitleOverlayDetected) {
    const hasHighConfNonClipboard = valid.some((r) =>
      r.source !== 'clipboard' &&
      r.text &&
      (r.confidence || 0) >= 0.5
    );
    if (!hasHighConfNonClipboard) {
      // Block clipboard only when non-clipboard results are explicitly empty (block marker)
      const allNonClipboardEmpty = all
        .filter((r) => r.source !== 'clipboard')
        .every((r) => !r.text);
      if (allNonClipboardEmpty) {
        return createManualDecision(all, scores, 'subtitle_overlay_clipboard_blocked', {
          subtitleOverlayDetected: true,
          error: all.find((r) => r.metadata?.error || r.error)?.metadata?.error || all.find((r) => r.error)?.error || '',
        });
      }
      // Not blocking: clear subtitle overlay marker so scoring treats this normally
      for (const r of all) {
        if (r.metadata) r.metadata.subtitleOverlayDetected = false;
      }
    }
  }

  const sorted = [...all].sort((a, b) => (scores[b.source] || 0) - (scores[a.source] || 0));
  const best = sorted[0];
  const reasonParts = [];

  if (best && isLikelyGarbledText(best.text)) {
    return createManualDecision(all, scores, 'garbled_text_blocked', {
      subtitleOverlayDetected,
      needsManualSelection: true,
      error: 'garbled_text_blocked',
    });
  }

  const clipResult = valid.find(r => r.source === 'clipboard');
  const genericBrowser = valid.find((r) => isGenericSubtitleOverlayResult(r) && (r.confidence || 0) >= 0.7);
  if (
    clipResult &&
    genericBrowser &&
    isBrowserWebContext(context, all) &&
    isUsefulClipboardSelection(clipResult) &&
    genericBrowser.text &&
    !String(clipResult.text).includes(String(genericBrowser.text)) &&
    !String(genericBrowser.text).includes(String(clipResult.text))
  ) {
    reasonParts.push('web_clipboard_over_generic_subtitle_overlay');
    return buildDecision(clipResult, all, scores, reasonParts.join(';'));
  }

  if (
    clipResult &&
    isBrowserWebContext(context, all) &&
    isUsefulClipboardSelection(clipResult) &&
    best &&
    (best.source === 'windows-uia' || best.source === 'ocr') &&
    best.text &&
    !String(clipResult.text).includes(String(best.text)) &&
    !String(best.text).includes(String(clipResult.text))
  ) {
    reasonParts.push('web_clipboard_over_inconsistent_uia_ocr');
    return buildDecision(clipResult, all, scores, reasonParts.join(';'));
  }

  // Rule 1: Browser high-confidence → lock
  const browser = valid.find(r => r.source === 'browser' && (r.confidence || 0) >= 0.7);
  if (browser && best.source !== 'browser') {
    reasonParts.push('browser_override_others');
    return buildDecision(browser, all, scores, reasonParts.join(';'));
  }

  // Rule 2: UIA high-confidence → lock against clipboard
  const uia = valid.find(r => r.source === 'windows-uia' && (r.confidence || 0) >= 0.7);
  if (uia && best.source === 'clipboard') {
    reasonParts.push('uia_override_clipboard');
    return buildDecision(uia, all, scores, reasonParts.join(';'));
  }

  // Rule 3: OCR high-confidence when Browser/UIA both failed
  const browserOrUiaOk = valid.some(r =>
    (r.source === 'browser' || r.source === 'windows-uia') && (r.confidence || 0) >= 0.5
  );
  const ocr = valid.find(r => r.source === 'ocr' && (r.confidence || 0) >= 0.7);
  if (ocr && !browserOrUiaOk && best.source === 'clipboard') {
    reasonParts.push('ocr_override_clipboard_no_browser_uia');
    return buildDecision(ocr, all, scores, reasonParts.join(';'));
  }

  // Rule 4-6: Clipboard superset → prefer non-clipboard subtext
  if (clipResult && best.source === 'clipboard') {
    for (const r of sorted) {
      if (r.source !== 'clipboard' && r.text && clipResult.text.includes(r.text)) {
        reasonParts.push(`${r.source}_substring_of_clipboard`);
        return buildDecision(r, all, scores, reasonParts.join(';'));
      }
    }
  }

  // Rule 7: All low confidence → manual
  const anyGood = valid.some(r => (r.confidence || 0) >= 0.4);
  if (!anyGood) {
    reasonParts.push('all_low_confidence');
    const decision = buildDecision(best, all, scores, reasonParts.join(';'));
    decision.metadata = { ...decision.metadata, needsManualSelection: true };
    decision.needsManualSelection = true;
    return decision;
  }

  reasonParts.push(`best_score:${best.source}`);
  return buildDecision(best, all, scores, reasonParts.join(';'));
}

function buildDecision(picked, all, scores, reason) {
  return {
    ...picked,
    candidates: all,
    reason,
    scoreBreakdown: scores,
    fallbackUsed: all.length > 1 && picked.source !== all[0].source,
    needsManualSelection: false,
  };
}

// ─── SelectionEngine ─────────────────────────────────

// ─── Session Management ──────────────────────────

let currentSession = null;

function createSession(context) {
  if (currentSession) {
    currentSession.state = 'expired';
    console.log('[Session] expired', currentSession.sessionId);
  }
  const session = {
    sessionId: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    state: 'capturing',
    isBrowser: /(chrome|msedge|firefox|brave|opera|browser)/.test(String(context?.foregroundProcessName || '')),
    processName: context?.foregroundProcessName || '',
  };
  currentSession = session;
  console.log('[Session] start', session.sessionId, 'browser:', session.isBrowser);
  return session;
}

function isSessionActive(session) {
  return currentSession === session;
}

function isSessionActiveId(sessionId) {
  return !!currentSession && currentSession.sessionId === sessionId;
}

function markSessionAsShown(sessionId) {
  if (currentSession && currentSession.sessionId === sessionId && currentSession.state === 'resolved') {
    currentSession.state = 'shown';
    console.log('[Session] shown', sessionId);
  }
}

// ─── Result Grading ──────────────────────────────


function gradeResult(source, result, context) {
  if (!result || !result.text) return 'invalid';
  if (result.metadata?.error && !result.metadata?.error.includes('subtitle_overlay')) return 'invalid';
  if (isLikelyGarbledText(result.text)) return 'invalid';

  const conf = result.confidence || 0;
  const textLen = result.text.length;

  const isClipboardSource = source === 'clipboard' || source === 'clipboard-v2' || result.source === 'clipboard' || result.source === 'clipboard-v2';

  // Safety: low-confidence clipboard should not enter candidates.
  if (isClipboardSource && conf < 0.5) return 'invalid';
  // Safety: long clipboard text without rect should not be shown.
  if (isClipboardSource && textLen > 3000 && !result.rect) return 'invalid';
  // Clipboard V2 must prove that this Ctrl+C changed the clipboard.
  if (isClipboardSource && result.metadata?.method === 'clipboard-v2-sendinput-sequence' && result.metadata?.clipboardChanged !== true) return 'invalid';

  if (source === 'windows-uia') {
    if (conf >= 0.88 &&
        result.metadata?.method === 'uia-textpattern-rangefrompoint' &&
        textLen >= 2 && textLen <= 1000 &&
        !result.metadata?.error) {
      return 'hard_winner';
    }
    if (conf >= 0.5 && textLen >= 1) return 'candidate';
    return 'invalid';
  }

  if (isClipboardSource) {
    const isClipboardV2Result =
      result.metadata?.method === 'clipboard-v2-sendinput-sequence' ||
      result.metadata?.clipboardProvider === 'clipboard-v2';
    const textPreview = (result.text || '').trim();
    const looksLikePathOrCommand = /^(?:[A-Za-z]:)?[\\\/]/.test(textPreview) || /^(cd\s+|npm\s+|npx\s+|pnpm\s+|yarn\s+)/i.test(textPreview);

    // Clipboard V2 has already proven this selection by sequence-number change.
    // For reasonable desktop selections, accept it immediately instead of waiting
    // for the old UIA provider to spend ~650ms failing. This mainly speeds up
    // medium/long selections where V2 confidence can be 0.75/0.65.
    if (ENABLE_CLIPBOARD_HARD_WINNER &&
        isClipboardV2Result &&
        result.metadata?.clipboardChanged === true &&
        conf >= 0.5 &&
        textLen >= 2 && textLen <= 3000 &&
        !result.metadata?.error &&
        !looksLikePathOrCommand) {
      return 'hard_winner';
    }

    // Keep the older stricter rule for any non-V2 clipboard result.
    if (ENABLE_CLIPBOARD_HARD_WINNER &&
        !isClipboardV2Result &&
        conf >= 0.85 &&
        result.metadata?.clipboardChanged === true &&
        textLen >= 2 && textLen <= 300 &&
        !result.metadata?.error &&
        !looksLikePathOrCommand) {
      return 'hard_winner';
    }
    if (conf >= 0.5 && textLen >= 1) return 'candidate';
    return 'invalid';
  }

  if (conf >= 0.5 && textLen >= 1) return 'candidate';
  return 'invalid';
}

// ─── Primary Race ────────────────────────────────

async function primaryRace(session, uiaPromise, clipPromise, context) {
  let uiaDone = false;
  let clipDone = false;
  let uiaCandidate = null;
  let clipCandidate = null;
  let completed = false;
  const _uiaStart = Date.now();
  const _clipStart = Date.now();
  const _sid = session.sessionId;
  const _aid = context?._perfAttemptId;

  console.log('[RaceTiming] provider_start', JSON.stringify({ source: 'windows-uia', sessionId: _sid, attemptId: _aid, at: _uiaStart }));
  console.log('[RaceTiming] provider_start', JSON.stringify({ source: 'clipboard', sessionId: _sid, attemptId: _aid, at: _clipStart }));

  function onComplete(source, result, resolve) {
    if (!isSessionActive(session)) {
      if (!completed) {
        completed = true;
        console.log('[Session] expired_result_ignored', session.sessionId);
        resolve({ status: 'expired' });
      }
      return;
    }
    if (completed) {
      console.log('[Race] late_result_ignored', source, 'session:', session.sessionId);
      return;
    }

    if (source === 'windows-uia') uiaDone = true;
    else clipDone = true;

    const grade = gradeResult(source, result, context);
    console.log('[Race] provider_returned', source, 'grade:', grade, 'conf:', result?.confidence, 'session:', session.sessionId);
    const _start = source === 'windows-uia' ? _uiaStart : _clipStart;
    console.log('[RaceTiming] provider_end', JSON.stringify({
      source, sessionId: _sid, attemptId: _aid,
      duration: Date.now() - _start,
      textLen: (result && result.text) ? result.text.length : 0,
      confidence: result && result.confidence,
      method: (result && result.metadata && result.metadata.method) || '',
      error: (result && (result.metadata?.error || result.error)) || '',
      grade
    }));

    if (grade === 'hard_winner') {
      completed = true;
      session.state = 'resolved';
      session.pickedResult = result;
      console.log('[Race] hard_winner', source, 'session:', session.sessionId);
      resolve({ status: 'winner', result, source: 'hard_winner' });
      return;
    }

    if (grade === 'candidate') {
      console.log('[Race] candidate_stored', source, 'session:', session.sessionId);
      if (source === 'windows-uia') uiaCandidate = result;
      else clipCandidate = result;
    }

    if (uiaDone && clipDone) {
      completed = true;
      const candidates = [uiaCandidate, clipCandidate].filter(r => r !== null);
      if (candidates.length >= 1) {
        const best = chooseBestPickedInfo(candidates, context);
        session.state = 'resolved';
        session.pickedResult = best;
        console.log('[Race] both_candidates_choose_best', 'source:', best.source, 'session:', session.sessionId);
        resolve({ status: 'winner', result: best, source: 'choose_best' });
      } else {
        console.log('[Race] both_invalid', 'session:', session.sessionId);
        resolve({ status: 'no_candidate' });
      }
    }
  }

  return new Promise((resolve) => {
    uiaPromise.then(r => onComplete('windows-uia', r, resolve)).catch(() => onComplete('windows-uia', null, resolve));
    clipPromise.then(r => onComplete('clipboard', r, resolve)).catch(() => onComplete('clipboard', null, resolve));
  });
}

class SelectionEngine {
  constructor() {
    /** @type {SelectionProvider[]} */
    this.providers = [];
  }
  register(provider) {
    this.providers.push(provider);
    this.providers.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 唯一取词入口
   *
   * 调用方式：
   *   const pickedInfo = await selectionEngine.getPickedInfo(context);
   *   // pickedInfo.text — 可信的选中文本
   *   // pickedInfo.source — 取词来源
   *   // pickedInfo.confidence — 置信度
   *
   * 规则：
   *   - 所有 Provider 依次尝试
   *   - 用 chooseBestPickedInfo() 选最优结果
   *   - 低置信度时附带 metadata.needsManualSelection
   *
   * @param {SelectionContext} context
   * @returns {Promise<PickedInfo>}
   */
  async getPickedInfo(context = {}) {
    const session = createSession(context);
    const sessionId = session.sessionId;
    const overallStart = Date.now();
    let clipboardHandled = false;
    const results = [];

    for (const provider of this.providers) {
      const providerStart = Date.now();
      const reason = provider.canHandle(context);
      if (PERF_LOGGING) console.log('[Provider]', JSON.stringify({ event: 'canHandle', provider: provider.name, result: !!reason, attemptId: context._perfAttemptId || '' }));
      if (!reason) continue;
      if (provider.name === 'ocr' && !shouldTryOcrProvider(results, context)) {
        if (PERF_LOGGING) console.log('[Provider]', JSON.stringify({ event: 'skip_conditional', provider: 'ocr', reason: 'shouldTryOcrProvider_false', attemptId: context._perfAttemptId || '' }));
        continue;
      }
      if (isClipboardLikeProvider(provider) && clipboardHandled) {
        if (PERF_LOGGING) console.log('[Provider]', JSON.stringify({ event: 'skip_conditional', provider: provider.name, reason: 'already_raced_with_uia', session: sessionId }));
        continue;
      }
      if (isClipboardLikeProvider(provider) && shouldAvoidClipboardProvider(results, context)) {
        if (PERF_LOGGING) console.log('[Provider]', JSON.stringify({ event: 'skip_conditional', provider: provider.name, reason: 'shouldAvoidClipboardProvider_true', attemptId: context._perfAttemptId || '' }));
        continue;
      }

      try {
        if (PERF_LOGGING) console.log('[Provider]', JSON.stringify({ event: 'pick_start', provider: provider.name, attemptId: context._perfAttemptId || '' }));
        const pickStart = Date.now();

        if (provider.name === 'windows-uia') {
          const clipProvider = this.providers.find(p => USE_CLIPBOARD_V2 ? p.name === 'clipboard-v2' : p.name === 'clipboard');
          const clipCanHandle = clipProvider && clipProvider.canHandle(context);
          if (clipProvider && clipCanHandle) {
            clipboardHandled = true;
            const race = await primaryRace(
              session,
              provider.pick(context),
              clipProvider.pick(context),
              context
            );
            if (race.status === 'expired') {
              console.log('[Session] expired_during_race', sessionId);
              return { text: '', confidence: 0, source: 'expired-session', _expired: true, _sessionId: sessionId };
            }
            if (race.status === 'winner') {
              race.result._sessionId = sessionId;
              console.log('[Session] resolved', race.source, 'session:', sessionId);
              return race.result;
            }
            console.log('[Session] ocr_fallback_start', sessionId);
            continue;
          }
        }

        const result = await provider.pick(context);
        const pickDuration = Date.now() - pickStart;
        if (PERF_LOGGING) console.log('[Provider]', JSON.stringify({ event: 'pick_end', provider: provider.name, duration: pickDuration, textLen: (result && result.text) ? result.text.length : 0, confidence: (result && result.confidence) || 0, hasRect: !!(result && result.rect), isTimeout: false, source: provider.name, attemptId: context._perfAttemptId || '' }));
        if (result) {
          results.push(result);

          if (isPrecisionFastPath(result, context)) {
            if (PERF_LOGGING) console.log('[Provider]', JSON.stringify({ event: 'short_circuit', provider: provider.name, reason: 'precision_fast_path', attemptId: context._perfAttemptId || '' }));
            break;
          }

          if (result.text && provider.name === 'windows-uia' && (result.confidence || 0) >= 0.75 && !results.some(r => r.source === 'browser')) {
            if (PERF_LOGGING) console.log('[Provider]', JSON.stringify({ event: 'short_circuit', provider: provider.name, reason: 'uia_high_confidence', attemptId: context._perfAttemptId || '' }));
            break;
          }
        }
      } catch (err) {
        if (PERF_LOGGING) console.log('[Provider]', JSON.stringify({ event: 'pick_error', provider: provider.name, error: err.message, attemptId: context._perfAttemptId || '' }));
        console.error('[SelectionEngine] provider error:', err.message);
      }
    }

    // Log all candidate results before scoring
    if (PERF_LOGGING && results.length > 0) {
      results.forEach(function(r) {
        console.log('[Provider:result]', JSON.stringify({ event: 'candidate', source: r.source, textLen: r.text ? r.text.length : 0, confidence: r.confidence || 0, latency: r.latency || 0, hasRect: !!r.rect, method: (r.metadata && r.metadata.method) || '', attemptId: context._perfAttemptId || '' }));
      });
    }

    const best = chooseBestPickedInfo(results, context);
    best.latency = Date.now() - overallStart;
    best._sessionId = sessionId;

    // selection:decision log
    const decisionCandidates = Array.isArray(best.candidates) ? best.candidates : results;
    const logEntry = {
      event: 'selection:decision',
      candidates: decisionCandidates.map((r) => ({
        source: r.source,
        textPreview: (r.text || '').slice(0, 40),
        textLength: r.text ? r.text.length : 0,
        confidence: r.confidence,
        score: (best.scoreBreakdown || {})[r.source] || 0,
        latency: r.latency,
        hasRect: !!r.rect,
        method: r.metadata?.method || '',
        adapter: r.metadata?.adapter || '',
        subtitleOverlayDetected: Boolean(r.metadata?.subtitleOverlayDetected),
        error: r.metadata?.error || r.error || '',
      })),
      pickedSource: best.source,
      pickedTextPreview: (best.text || '').slice(0, 40),
      pickedConfidence: best.confidence || 0,
      pickedScore: (best.scoreBreakdown || {})[best.source] || 0,
      reason: best.reason || '',
      needsManualSelection: !!(best.needsManualSelection || (best.metadata && best.metadata.needsManualSelection)),
      totalLatency: best.latency,
    };
    console.log('[selection:decision]', JSON.stringify(logEntry));
    // [PERF] Detailed scoring breakdown
    if (PERF_LOGGING) {
      const breakdownScores = {};
      const allResults = Array.isArray(best.candidates) ? best.candidates : results;
      const ctx = context || {};
      for (const cand of allResults) {
        if (cand && cand.source) {
          const bd = scoringBreakdown(cand, ctx, allResults);
          if (bd) breakdownScores[cand.source] = bd;
        }
      }
      console.log('[PERF]', JSON.stringify({ event: 'scoring_detail', totalLatency: best.latency, pickedSource: best.source, pickedReason: best.reason || '', scores: breakdownScores, attemptId: (context && context._perfAttemptId) ? context._perfAttemptId : '' }));
    }

    if (best.needsManualSelection || (best.metadata && best.metadata.needsManualSelection)) {
      best.metadata = { ...best.metadata, lowConfidenceWarning: true };
    }

    return best;
  }

  /**
   * 获取所有已注册 Provider 的名称列表（用于调试）
   * @returns {string[]}
   */
  listProviders() {
    return this.providers.map((p) => p.name);
  }
}

// ─── Factory ─────────────────────────────────────────

/**
 * 创建默认配置好的 SelectionEngine
 */
function createDefaultEngine(getBrowserPayload) {
  const engine = new SelectionEngine();

  // L1: Browser content script (10) — highest priority
  // getBrowserPayload: () => cached payload from HTTP receiver
  if (getBrowserPayload) {
    engine.register(new BrowserProvider(getBrowserPayload));
  }

  // L2: Windows UI Automation (30) — native desktop text selection
  engine.register(new WindowsUIAProvider());

  // L3: OCR fallback (50) — image/video/subtitle fallback
  engine.register(new OCRProvider());

  // L4: Clipboard fallback — V2 native helper by default; old provider only for emergency rollback.
  if (USE_CLIPBOARD_V2) {
    engine.register(new ClipboardProviderV2());
  } else {
    engine.register(new ClipboardProvider());
  }

  // L5: Manual fallback (99) — word block selection card
  engine.register(new ManualFallbackProvider());

  return engine;
}

module.exports = {
  SelectionEngine,
  SelectionProvider,
  BrowserProvider,
  WindowsUIAProvider,
  OCRProvider,
  ClipboardProvider,
  ClipboardProviderV2,
  ManualFallbackProvider,
  chooseBestPickedInfo,
  markSessionAsShown,
  isSessionActiveId,
  createDefaultEngine,
};
