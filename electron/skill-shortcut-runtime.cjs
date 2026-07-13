'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const shortcutUtils = require('./skill-shortcut-utils.cjs');

let installed = false;

function install() {
  if (installed) return;
  installed = true;

  const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
  const registeredKeyboard = new Map();
  let originalSkillRun = null;
  let originalInitialData = null;
  let latestSkills = [];
  let toolbarWindow = null;
  let selectedText = '';
  let shortcutSessionActive = false;
  let triggerLockedUntil = 0;
  let mouseHook = null;
  let pendingMouseCommand = 'SHORTCUT_SESSION|OFF';
  let quitting = false;

  function shortcutFile() {
    return path.join(app.getPath('userData'), 'skill-shortcuts.json');
  }

  function selectionHotkeyFile() {
    return path.join(app.getPath('userData'), 'hotkey-config.json');
  }

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return fallback; }
  }

  function readBindings() {
    const stored = readJson(shortcutFile(), {});
    return stored && typeof stored.bindings === 'object' && stored.bindings ? stored.bindings : {};
  }

  function writeBindings(bindings) {
    const file = shortcutFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, bindings }, null, 2), 'utf8');
  }

  function readSelectionHotkey() {
    const config = readJson(selectionHotkeyFile(), {});
    return String(config.selectionHotkey || 'Alt+Q');
  }

  function normalizeBindings(bindings, skills = latestSkills) {
    const knownSkillIds = new Set((skills || []).map((skill) => String(skill.id)));
    const normalized = {};
    for (const [skillId, input] of Object.entries(bindings || {})) {
      if (knownSkillIds.size > 0 && !knownSkillIds.has(String(skillId))) continue;
      try {
        const shortcut = shortcutUtils.normalizeShortcut(input);
        if (shortcut) normalized[skillId] = shortcut;
      } catch (_) {}
    }
    return normalized;
  }

  function skillsWithBindings(bindings = normalizeBindings(readBindings())) {
    return (latestSkills || []).map((skill) => ({
      ...skill,
      shortcut: bindings[skill.id] || null,
    }));
  }

  async function ensureSkills(event) {
    if (latestSkills.length > 0 || !originalInitialData) return latestSkills;
    try {
      const data = await originalInitialData(event);
      latestSkills = Array.isArray(data?.skills) ? data.skills : [];
    } catch (_) {}
    return latestSkills;
  }

  function skillName(skillId) {
    return latestSkills.find((skill) => String(skill.id) === String(skillId))?.name || '某个技能';
  }

  function sendMouseCommand(command) {
    pendingMouseCommand = command;
    if (!mouseHook?.stdin || mouseHook.stdin.destroyed) return;
    try { mouseHook.stdin.write(command + '\n'); } catch (_) {}
  }

  function deactivate(reason = 'unknown') {
    for (const accelerator of registeredKeyboard.keys()) {
      try { globalShortcut.unregister(accelerator); } catch (_) {}
    }
    registeredKeyboard.clear();
    shortcutSessionActive = false;
    sendMouseCommand('SHORTCUT_SESSION|OFF');
    console.log('[SkillShortcutRuntime] deactivated reason=' + reason);
  }

  async function trigger(skillId, binding) {
    const now = Date.now();
    if (!shortcutSessionActive || now < triggerLockedUntil) return;
    if (!toolbarWindow || toolbarWindow.isDestroyed() || !toolbarWindow.isVisible()) return;
    if (!selectedText || !originalSkillRun) return;

    triggerLockedUntil = now + 350;
    deactivate('trigger:' + binding);
    try {
      await originalSkillRun({ sender: toolbarWindow.webContents }, {
        skillId,
        selection: selectedText,
        source: 'skill-shortcut',
      });
    } catch (error) {
      console.error('[SkillShortcutRuntime] execution failed skillId=' + skillId, error);
    }
  }

  function activate() {
    deactivate('refresh');
    if (!toolbarWindow || toolbarWindow.isDestroyed() || !toolbarWindow.isVisible() || !selectedText) return;

    const bindings = normalizeBindings(readBindings());
    const activeSkills = skillsWithBindings(bindings).filter((skill) => skill.enabled !== false && skill.shortcut);
    let mouseBindingCount = 0;

    for (const skill of activeSkills) {
      const shortcut = skill.shortcut;
      if (shortcut.kind === 'mouse') {
        mouseBindingCount += 1;
        continue;
      }

      let registered = false;
      try {
        registered = globalShortcut.register(shortcut.value, () => {
          void trigger(skill.id, shortcut.value);
        });
      } catch (_) {
        registered = false;
      }
      if (registered) registeredKeyboard.set(shortcut.value, skill.id);
      else console.warn('[SkillShortcutRuntime] could not register', shortcut.value, skill.id);
    }

    if (mouseBindingCount > 0) {
      sendMouseCommand('SHORTCUT_SESSION|' + shortcutUtils.encodeMouseBindings(activeSkills));
    }
    shortcutSessionActive = registeredKeyboard.size > 0 || mouseBindingCount > 0;
    console.log('[SkillShortcutRuntime] activated keyboard=' + registeredKeyboard.size + ' mouse=' + mouseBindingCount);
  }

  function checkKeyboardAvailability(shortcut) {
    if (!shortcut || shortcut.kind !== 'keyboard') return { ok: true };
    if (globalShortcut.isRegistered(shortcut.value)) {
      return { ok: false, error: '该快捷键已被当前应用占用。' };
    }

    let registered = false;
    try { registered = globalShortcut.register(shortcut.value, () => {}); }
    catch (_) { registered = false; }
    if (!registered) return { ok: false, error: '该快捷键已被系统或其他程序占用。' };

    try { globalShortcut.unregister(shortcut.value); } catch (_) {}
    return { ok: true };
  }

  async function validate(event, skillId, input, checkSystem = true) {
    await ensureSkills(event);
    const bindings = normalizeBindings(readBindings());
    const validation = shortcutUtils.validateSkillShortcut(input, {
      skillId,
      skills: skillsWithBindings(bindings),
      selectionHotkey: readSelectionHotkey(),
    });
    if (!validation.ok || !validation.shortcut) return validation;
    if (checkSystem && validation.shortcut.kind === 'keyboard') {
      const availability = checkKeyboardAvailability(validation.shortcut);
      if (!availability.ok) return availability;
    }
    return validation;
  }

  function selectionHotkeyConflict(config) {
    if (!config || config.hotkeyEnabled === false || !config.selectionHotkey) return null;
    let normalized;
    try { normalized = shortcutUtils.normalizeShortcut(config.selectionHotkey); }
    catch (_) { return null; }
    if (!normalized) return null;

    const bindings = normalizeBindings(readBindings());
    for (const [skillId, shortcut] of Object.entries(bindings)) {
      if (shortcut.value === normalized.value) {
        return { ok: false, error: `该组合已被“${skillName(skillId)}”技能使用。` };
      }
    }
    return null;
  }

  function routeFromUrl(url) {
    try { return new URL(String(url)).searchParams.get('route') || ''; }
    catch (_) { return String(url || '').includes('route=toolbar') ? 'toolbar' : ''; }
  }

  function attachToolbar(win) {
    if (!win || win.__skillShortcutsAttached) return;
    win.__skillShortcutsAttached = true;
    toolbarWindow = win;

    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = function sendWithShortcutSession(channel, ...args) {
      if (channel === 'selection:ready') {
        const payload = args[0] || {};
        selectedText = String(payload.selection || payload.pickedInfo?.text || '').trim();
        if (Array.isArray(payload.allSkills)) latestSkills = payload.allSkills;
        else if (latestSkills.length === 0 && Array.isArray(payload.skills)) latestSkills = payload.skills;
        setImmediate(activate);
      } else if (channel === 'toolbar:hide') {
        deactivate('toolbar-hide-message');
      }
      return send(channel, ...args);
    };

    win.on('hide', () => deactivate('toolbar-hide'));
    win.on('closed', () => {
      if (toolbarWindow === win) toolbarWindow = null;
      selectedText = '';
      deactivate('toolbar-closed');
    });
  }

  const loadURL = BrowserWindow.prototype.loadURL;
  BrowserWindow.prototype.loadURL = function loadURLWithShortcutSession(url, ...args) {
    if (routeFromUrl(url) === 'toolbar') attachToolbar(this);
    return loadURL.call(this, url, ...args);
  };

  const registerHandler = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = function handleWithSkillShortcuts(channel, listener) {
    if (channel === 'skill:run') {
      originalSkillRun = listener;
      return registerHandler(channel, listener);
    }

    if (channel === 'app:get-initial-data') {
      originalInitialData = listener;
      return registerHandler(channel, async (...args) => {
        const data = await listener(...args);
        latestSkills = Array.isArray(data?.skills) ? data.skills : latestSkills;
        const bindings = normalizeBindings(readBindings(), latestSkills);
        return {
          ...data,
          skills: (data.skills || []).map((skill) => ({ ...skill, shortcut: bindings[skill.id] || null })),
          toolbarSkills: (data.toolbarSkills || []).map((skill) => ({ ...skill, shortcut: bindings[skill.id] || null })),
        };
      });
    }

    if (channel === 'skills:save') {
      return registerHandler(channel, async (event, skill) => {
        const cleanSkill = { ...(skill || {}) };
        delete cleanSkill.shortcut;
        const result = await listener(event, cleanSkill);
        latestSkills = Array.isArray(result?.skills) ? result.skills : latestSkills;
        return result;
      });
    }

    if (channel === 'skills:reorder') {
      return registerHandler(channel, async (...args) => {
        const result = await listener(...args);
        latestSkills = Array.isArray(result?.skills) ? result.skills : latestSkills;
        return result;
      });
    }

    if (channel === 'skills:delete') {
      return registerHandler(channel, async (event, skillId) => {
        const result = await listener(event, skillId);
        latestSkills = Array.isArray(result?.skills) ? result.skills : latestSkills;
        const bindings = readBindings();
        if (Object.prototype.hasOwnProperty.call(bindings, skillId)) {
          delete bindings[skillId];
          writeBindings(bindings);
        }
        return result;
      });
    }

    if (channel === 'hotkey:save-config') {
      return registerHandler(channel, async (event, config) => {
        const conflict = selectionHotkeyConflict(config);
        if (conflict) return conflict;
        return listener(event, config);
      });
    }

    return registerHandler(channel, listener);
  };

  registerHandler('skill-shortcuts:get-state', async (event) => {
    await ensureSkills(event);
    const bindings = normalizeBindings(readBindings());
    return {
      ok: true,
      bindings,
      skills: latestSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        iconKey: skill.iconKey,
        enabled: skill.enabled !== false,
        sortOrder: Number(skill.sortOrder) || 0,
      })),
    };
  });

  registerHandler('skill-shortcuts:validate', async (event, payload) => {
    const request = payload || {};
    return validate(event, String(request.skillId || ''), request.shortcut, true);
  });

  registerHandler('skill-shortcuts:set', async (event, payload) => {
    const request = payload || {};
    const skillId = String(request.skillId || '');
    await ensureSkills(event);
    if (!latestSkills.some((skill) => String(skill.id) === skillId)) {
      return { ok: false, error: '没有找到技能。' };
    }

    const validation = await validate(event, skillId, request.shortcut, true);
    if (!validation.ok || !validation.shortcut) return validation;

    const bindings = normalizeBindings(readBindings());
    bindings[skillId] = validation.shortcut;
    writeBindings(bindings);
    if (shortcutSessionActive) activate();
    return { ok: true, shortcut: validation.shortcut };
  });

  registerHandler('skill-shortcuts:clear', async (event, payload) => {
    const skillId = String(payload?.skillId || '');
    await ensureSkills(event);
    const bindings = readBindings();
    delete bindings[skillId];
    writeBindings(bindings);
    if (shortcutSessionActive) activate();
    return { ok: true };
  });

  function handleMouseOutput(line) {
    if (!line.startsWith('SKILL_SHORTCUT|')) return;
    const parts = line.split('|');
    const skillId = Buffer.from(parts[1] || '', 'base64').toString('utf8');
    const binding = Buffer.from(parts[2] || '', 'base64').toString('utf8');
    if (skillId && binding) void trigger(skillId, binding);
  }

  function startMouseHook() {
    if (process.platform !== 'win32' || mouseHook || quitting) return;

    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class SkillMouseShortcutHook {
  private const int WH_MOUSE_LL = 14;
  private const int WM_MBUTTONDOWN = 0x0207;
  private const int WM_MOUSEWHEEL = 0x020A;
  private const int WM_XBUTTONDOWN = 0x020B;
  private const int VK_SHIFT = 0x10;
  private const int VK_CONTROL = 0x11;
  private const int VK_MENU = 0x12;
  private const int VK_LWIN = 0x5B;
  private const int VK_RWIN = 0x5C;
  private static IntPtr hookId = IntPtr.Zero;
  private static LowLevelMouseProc callback = HookCallback;
  private static readonly object gate = new object();
  private static readonly Dictionary<string, string> bindings = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
  private static bool active = false;

  public static void Run() {
    Thread inputThread = new Thread(ReadCommands);
    inputThread.IsBackground = true;
    inputThread.Start();
    hookId = InstallHook(callback);
    Application.Run();
    UnhookWindowsHookEx(hookId);
  }

  private static void ReadCommands() {
    try {
      string line;
      while ((line = Console.ReadLine()) != null) {
        if (line == "SHORTCUT_SESSION|OFF") {
          lock (gate) { active = false; bindings.Clear(); }
          continue;
        }
        if (!line.StartsWith("SHORTCUT_SESSION|")) continue;

        string encoded = line.Substring("SHORTCUT_SESSION|".Length);
        string decoded = Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
        Dictionary<string, string> next = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string row in decoded.Split(new[] { (char)10 }, StringSplitOptions.RemoveEmptyEntries)) {
          string[] parts = row.Split(new[] { (char)9 }, 2);
          if (parts.Length == 2 && parts[0].Length > 0 && parts[1].Length > 0) next[parts[0]] = parts[1];
        }
        lock (gate) {
          bindings.Clear();
          foreach (KeyValuePair<string, string> entry in next) bindings[entry.Key] = entry.Value;
          active = bindings.Count > 0;
        }
      }
    } catch {}
  }

  private static bool IsPressed(int virtualKey) {
    return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
  }

  private static string ModifierPrefix() {
    StringBuilder value = new StringBuilder();
    if (IsPressed(VK_CONTROL)) value.Append("Ctrl+");
    if (IsPressed(VK_MENU)) value.Append("Alt+");
    if (IsPressed(VK_SHIFT)) value.Append("Shift+");
    if (IsPressed(VK_LWIN) || IsPressed(VK_RWIN)) value.Append("Meta+");
    return value.ToString();
  }

  private static IntPtr HookCallback(int code, IntPtr messagePointer, IntPtr dataPointer) {
    if (code >= 0) {
      int message = messagePointer.ToInt32();
      string token = "";
      MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(dataPointer, typeof(MSLLHOOKSTRUCT));

      if (message == WM_MBUTTONDOWN) {
        token = "MouseMiddle";
      } else if (message == WM_XBUTTONDOWN) {
        int button = (int)((data.mouseData >> 16) & 0xffff);
        token = button == 1 ? "MouseX1" : button == 2 ? "MouseX2" : "";
      } else if (message == WM_MOUSEWHEEL) {
        short delta = unchecked((short)((data.mouseData >> 16) & 0xffff));
        token = delta > 0 ? "WheelUp" : "WheelDown";
      }

      if (token.Length > 0) {
        string binding = ModifierPrefix() + token;
        string skillId = "";
        lock (gate) {
          if (active && bindings.TryGetValue(binding, out skillId)) {
            active = false;
            bindings.Clear();
          } else {
            skillId = "";
          }
        }

        if (skillId.Length > 0) {
          string encodedSkill = Convert.ToBase64String(Encoding.UTF8.GetBytes(skillId));
          string encodedBinding = Convert.ToBase64String(Encoding.UTF8.GetBytes(binding));
          Console.WriteLine("SKILL_SHORTCUT|" + encodedSkill + "|" + encodedBinding);
          Console.Out.Flush();
          return (IntPtr)1;
        }
      }
    }
    return CallNextHookEx(hookId, code, messagePointer, dataPointer);
  }

  private static IntPtr InstallHook(LowLevelMouseProc procedure) {
    using (Process process = Process.GetCurrentProcess())
    using (ProcessModule module = process.MainModule) {
      return SetWindowsHookEx(WH_MOUSE_LL, procedure, GetModuleHandle(module.ModuleName), 0);
    }
  }

  private delegate IntPtr LowLevelMouseProc(int code, IntPtr message, IntPtr data);

  [StructLayout(LayoutKind.Sequential)]
  private struct POINT { public int x; public int y; }

  [StructLayout(LayoutKind.Sequential)]
  private struct MSLLHOOKSTRUCT {
    public POINT pt;
    public uint mouseData;
    public uint flags;
    public uint time;
    public IntPtr extraInfo;
  }

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc procedure, IntPtr module, uint threadId);

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern bool UnhookWindowsHookEx(IntPtr hook);

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);

  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern IntPtr GetModuleHandle(string moduleName);

  [DllImport("user32.dll")]
  private static extern short GetAsyncKeyState(int virtualKey);
}
"@ -ReferencedAssemblies System.Windows.Forms
[SkillMouseShortcutHook]::Run()
`;

    mouseHook = spawn('powershell.exe', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    mouseHook.stdout.on('data', (chunk) => {
      String(chunk).split(/\r?\n/).forEach((line) => handleMouseOutput(line.trim()));
    });
    mouseHook.once('spawn', () => sendMouseCommand(pendingMouseCommand));
    mouseHook.once('exit', () => {
      mouseHook = null;
      if (!quitting) setTimeout(startMouseHook, 1200);
    });
    mouseHook.once('error', () => {
      mouseHook = null;
    });
  }

  app.whenReady().then(startMouseHook);
  app.on('will-quit', () => {
    quitting = true;
    deactivate('app-quit');
    if (mouseHook) {
      try { mouseHook.kill(); } catch (_) {}
      mouseHook = null;
    }
  });

  console.log('[SkillShortcutRuntime] installed');
}

module.exports = { install };
