'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const shortcutUtils = require('./skill-shortcut-utils.cjs');

let installed = false;

function install() {
  if (installed) return;
  installed = true;

  const electron = require('electron');
  const { app, BrowserWindow, globalShortcut, ipcMain } = electron;
  const activeKeyboard = new Map();
  let skillRunListener = null;
  let initialDataListener = null;
  let latestSkills = [];
  let toolbarWindow = null;
  let currentSelection = '';
  let sessionActive = false;
  let triggerLockUntil = 0;
  let mouseHookProcess = null;
  let pendingMouseCommand = 'SHORTCUT_SESSION|OFF';
  let quitting = false;

  function bindingsPath() {
    return path.join(app.getPath('userData'), 'skill-shortcuts.json');
  }

  function readBindings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(bindingsPath(), 'utf8'));
      return parsed && typeof parsed.bindings === 'object' && parsed.bindings ? parsed.bindings : {};
    } catch (_) {
      return {};
    }
  }

  function writeBindings(bindings) {
    const target = bindingsPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ version: 1, bindings }, null, 2), 'utf8');
  }

  function readSelectionHotkey() {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'hotkey-config.json'), 'utf8'));
      return String(parsed.selectionHotkey || 'Alt+Q');
    } catch (_) {
      return 'Alt+Q';
    }
  }

  function cleanBindings(bindings, skills = latestSkills) {
    const validIds = new Set((skills || []).map((skill) => String(skill.id)));
    const next = {};
    for (const [skillId, input] of Object.entries(bindings || {})) {
      if (validIds.size > 0 && !validIds.has(String(skillId))) continue;
      try {
        const normalized = shortcutUtils.normalizeShortcut(input);
        if (normalized) next[skillId] = normalized;
      } catch (_) {}
    }
    return next;
  }

  function skillListWithBindings(bindings = readBindings()) {
    return (latestSkills || []).map((skill) => ({
      ...skill,
      shortcut: bindings[skill.id] || null,
    }));
  }

  async function resolveSkills(event) {
    if (latestSkills.length > 0) return latestSkills;
    if (!initialDataListener) return [];
    try {
      const data = await initialDataListener(event);
      latestSkills = Array.isArray(data?.skills) ? data.skills : [];
    } catch (_) {}
    return latestSkills;
  }

  function sendMouseCommand(command) {
    pendingMouseCommand = command;
    if (!mouseHookProcess?.stdin || mouseHookProcess.stdin.destroyed) return;
    try { mouseHookProcess.stdin.write(command + '\n'); } catch (_) {}
  }

  function deactivate(reason = 'unknown') {
    for (const accelerator of activeKeyboard.keys()) {
      try { globalShortcut.unregister(accelerator); } catch (_) {}
    }
    activeKeyboard.clear();
    sessionActive = false;
    sendMouseCommand('SHORTCUT_SESSION|OFF');
    console.log('[SkillShortcutRuntime] deactivated reason=' + reason);
  }

  async function triggerSkill(skillId, binding) {
    const now = Date.now();
    if (!sessionActive || now < triggerLockUntil) return;
    if (!toolbarWindow || toolbarWindow.isDestroyed() || !toolbarWindow.isVisible()) return;
    if (!skillRunListener || !currentSelection) return;
    triggerLockUntil = now + 350;
    deactivate('trigger:' + binding);
    try {
      await skillRunListener({ sender: toolbarWindow.webContents }, {
        skillId,
        selection: currentSelection,
        source: 'skill-shortcut',
      });
    } catch (error) {
      console.error('[SkillShortcutRuntime] skill execution failed', error);
    }
  }

  function activate() {
    deactivate('refresh');
    if (!toolbarWindow || toolbarWindow.isDestroyed() || !toolbarWindow.isVisible() || !currentSelection) return;

    const bindings = cleanBindings(readBindings());
    const skills = skillListWithBindings(bindings).filter((skill) => skill.enabled !== false && skill.shortcut);
    let mouseCount = 0;

    for (const skill of skills) {
      const shortcut = skill.shortcut;
      if (shortcut.kind === 'mouse') {
        mouseCount += 1;
        continue;
      }
      let ok = false;
      try {
        ok = globalShortcut.register(shortcut.value, () => {
          void triggerSkill(skill.id, shortcut.value);
        });
      } catch (_) {
        ok = false;
      }
      if (ok) activeKeyboard.set(shortcut.value, skill.id);
      else console.warn('[SkillShortcutRuntime] keyboard registration failed', shortcut.value, skill.id);
    }

    if (mouseCount > 0) {
      sendMouseCommand('SHORTCUT_SESSION|' + shortcutUtils.encodeMouseBindings(skills));
    }
    sessionActive = activeKeyboard.size > 0 || mouseCount > 0;
    console.log('[SkillShortcutRuntime] activated keyboard=' + activeKeyboard.size + ' mouse=' + mouseCount);
  }

  function testKeyboardAvailability(shortcut) {
    if (!shortcut || shortcut.kind !== 'keyboard') return { ok: true };
    if (globalShortcut.isRegistered(shortcut.value)) {
      return { ok: false, error: '该快捷键已被当前应用占用。' };
    }
    let ok = false;
    try { ok = globalShortcut.register(shortcut.value, () => {}); } catch (_) { ok = false; }
    if (ok) {
      try { globalShortcut.unregister(shortcut.value); } catch (_) {}
      return { ok: true };
    }
    return { ok: false, error: '该快捷键已被系统或其他程序占用。' };
  }

  async function validate(event, skillId, input, checkSystem = true) {
    await resolveSkills(event);
    const bindings = cleanBindings(readBindings());
    const skills = skillListWithBindings(bindings);
    const result = shortcutUtils.validateSkillShortcut(input, {
      skillId,
      skills,
      selectionHotkey: readSelectionHotkey(),
    });
    if (!result.ok || !result.shortcut) return result;
    if (checkSystem && result.shortcut.kind === 'keyboard') {
      const availability = testKeyboardAvailability(result.shortcut);
      if (!availability.ok) return availability;
    }
    return result;
  }

  function routeFromUrl(url) {
    try { return new URL(String(url)).searchParams.get('route') || ''; }
    catch (_) { return String(url || '').includes('route=toolbar') ? 'toolbar' : ''; }
  }

  function attachToolbarWindow(win) {
    if (!win || win.__skillShortcutAttached) return;
    win.__skillShortcutAttached = true;
    toolbarWindow = win;
    const originalSend = win.webContents.send.bind(win.webContents);
    win.webContents.send = function patchedSend(channel, ...args) {
      if (channel === 'selection:ready') {
        const payload = args[0] || {};
        currentSelection = String(payload.selection || payload.pickedInfo?.text || '').trim();
        if (Array.isArray(payload.allSkills)) latestSkills = payload.allSkills;
        else if (Array.isArray(payload.skills) && latestSkills.length === 0) latestSkills = payload.skills;
        setImmediate(activate);
      } else if (channel === 'toolbar:hide') {
        deactivate('toolbar-hide-message');
      }
      return originalSend(channel, ...args);
    };
    win.on('hide', () => deactivate('toolbar-hide'));
    win.on('closed', () => {
      if (toolbarWindow === win) toolbarWindow = null;
      currentSelection = '';
      deactivate('toolbar-closed');
    });
  }

  const originalLoadURL = BrowserWindow.prototype.loadURL;
  BrowserWindow.prototype.loadURL = function patchedLoadURL(url, ...args) {
    if (routeFromUrl(url) === 'toolbar') attachToolbarWindow(this);
    return originalLoadURL.call(this, url, ...args);
  };

  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = function patchedHandle(channel, listener) {
    if (channel === 'skill:run') {
      skillRunListener = listener;
      return originalHandle(channel, listener);
    }
    if (channel === 'app:get-initial-data') {
      initialDataListener = listener;
      return originalHandle(channel, async (...args) => {
        const data = await listener(...args);
        latestSkills = Array.isArray(data?.skills) ? data.skills : latestSkills;
        const bindings = cleanBindings(readBindings(), latestSkills);
        return {
          ...data,
          skills: (data.skills || []).map((skill) => ({ ...skill, shortcut: bindings[skill.id] || null })),
          toolbarSkills: (data.toolbarSkills || []).map((skill) => ({ ...skill, shortcut: bindings[skill.id] || null })),
        };
      });
    }
    if (channel === 'skills:save' || channel === 'skills:reorder') {
      return originalHandle(channel, async (...args) => {
        const result = await listener(...args);
        latestSkills = Array.isArray(result?.skills) ? result.skills : latestSkills;
        return result;
      });
    }
    if (channel === 'skills:delete') {
      return originalHandle(channel, async (event, skillId) => {
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
    return originalHandle(channel, listener);
  };

  originalHandle('skill-shortcuts:get-state', async (event) => {
    await resolveSkills(event);
    const bindings = cleanBindings(readBindings());
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

  originalHandle('skill-shortcuts:validate', async (event, payload) => {
    const request = payload || {};
    return validate(event, String(request.skillId || ''), request.shortcut, true);
  });

  originalHandle('skill-shortcuts:set', async (event, payload) => {
    const request = payload || {};
    const skillId = String(request.skillId || '');
    await resolveSkills(event);
    if (!latestSkills.some((skill) => String(skill.id) === skillId)) {
      return { ok: false, error: '没有找到技能。' };
    }
    const validation = await validate(event, skillId, request.shortcut, true);
    if (!validation.ok || !validation.shortcut) return validation;
    const bindings = cleanBindings(readBindings());
    bindings[skillId] = validation.shortcut;
    writeBindings(bindings);
    if (sessionActive) activate();
    return { ok: true, shortcut: validation.shortcut };
  });

  originalHandle('skill-shortcuts:clear', async (event, payload) => {
    const skillId = String(payload?.skillId || '');
    await resolveSkills(event);
    const bindings = readBindings();
    delete bindings[skillId];
    writeBindings(bindings);
    if (sessionActive) activate();
    return { ok: true };
  });

  function handleMouseHookLine(line) {
    if (!line.startsWith('SKILL_SHORTCUT|')) return;
    const parts = line.split('|');
    const skillId = Buffer.from(parts[1] || '', 'base64').toString('utf8');
    const binding = Buffer.from(parts[2] || '', 'base64').toString('utf8');
    if (skillId && binding) void triggerSkill(skillId, binding);
  }

  function startMouseHook() {
    if (process.platform !== 'win32' || mouseHookProcess || quitting) return;
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
  private static LowLevelMouseProc proc = HookCallback;
  private static readonly object gate = new object();
  private static readonly Dictionary<string, string> bindings = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
  private static bool active = false;

  public static void Run() {
    Thread input = new Thread(ReadCommands);
    input.IsBackground = true;
    input.Start();
    hookId = SetHook(proc);
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
        string decoded = Encoding.UTF8.GetString(Convert.FromBase64String(line.Substring("SHORTCUT_SESSION|".Length)));
        Dictionary<string, string> next = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string row in decoded.Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries)) {
          string[] parts = row.Split(new[] { '\t' }, 2);
          if (parts.Length == 2) next[parts[0]] = parts[1];
        }
        lock (gate) {
          bindings.Clear();
          foreach (KeyValuePair<string, string> item in next) bindings[item.Key] = item.Value;
          active = bindings.Count > 0;
        }
      }
    } catch {}
  }

  private static bool Pressed(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
  private static string Prefix() {
    StringBuilder value = new StringBuilder();
    if (Pressed(VK_CONTROL)) value.Append("Ctrl+");
    if (Pressed(VK_MENU)) value.Append("Alt+");
    if (Pressed(VK_SHIFT)) value.Append("Shift+");
    if (Pressed(VK_LWIN) || Pressed(VK_RWIN)) value.Append("Meta+");
    return value.ToString();
  }

  private static IntPtr HookCallback(int code, IntPtr messagePointer, IntPtr dataPointer) {
    if (code >= 0) {
      int message = messagePointer.ToInt32();
      string token = "";
      MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(dataPointer, typeof(MSLLHOOKSTRUCT));
      if (message == WM_MBUTTONDOWN) token = "MouseMiddle";
      else if (message == WM_XBUTTONDOWN) {
        int button = (int)((data.mouseData >> 16) & 0xffff);
        token = button == 1 ? "MouseX1" : button == 2 ? "MouseX2" : "";
      } else if (message == WM_MOUSEWHEEL) {
        short delta = unchecked((short)((data.mouseData >> 16) & 0xffff));
        token = delta > 0 ? "WheelUp" : "WheelDown";
      }
      if (token.Length > 0) {
        string binding = Prefix() + token;
        string skillId = "";
        lock (gate) {
          if (active && bindings.TryGetValue(binding, out skillId)) {
            active = false;
            bindings.Clear();
          } else skillId = "";
        }
        if (skillId.Length > 0) {
          Console.WriteLine("SKILL_SHORTCUT|" + Convert.ToBase64String(Encoding.UTF8.GetBytes(skillId)) + "|" + Convert.ToBase64String(Encoding.UTF8.GetBytes(binding)));
          Console.Out.Flush();
          return (IntPtr)1;
        }
      }
    }
    return CallNextHookEx(hookId, code, messagePointer, dataPointer);
  }

  private static IntPtr SetHook(LowLevelMouseProc callback) {
    using (Process process = Process.GetCurrentProcess())
    using (ProcessModule module = process.MainModule) {
      return SetWindowsHookEx(WH_MOUSE_LL, callback, GetModuleHandle(module.ModuleName), 0);
    }
  }

  private delegate IntPtr LowLevelMouseProc(int code, IntPtr message, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int id, LowLevelMouseProc callback, IntPtr module, uint threadId);
  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)] private static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
}
"@ -ReferencedAssemblies System.Windows.Forms
[SkillMouseShortcutHook]::Run()
`;

    mouseHookProcess = spawn('powershell.exe', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    mouseHookProcess.stdout.on('data', (chunk) => {
      String(chunk).split(/\r?\n/).forEach((line) => handleMouseHookLine(line.trim()));
    });
    mouseHookProcess.once('spawn', () => sendMouseCommand(pendingMouseCommand));
    mouseHookProcess.once('exit', () => {
      mouseHookProcess = null;
      if (!quitting) setTimeout(startMouseHook, 1200);
    });
    mouseHookProcess.once('error', () => {
      mouseHookProcess = null;
    });
  }

  app.whenReady().then(startMouseHook);
  app.on('will-quit', () => {
    quitting = true;
    deactivate('app-quit');
    if (mouseHookProcess) {
      try { mouseHookProcess.kill(); } catch (_) {}
      mouseHookProcess = null;
    }
  });

  console.log('[SkillShortcutRuntime] installed');
}

module.exports = { install };
