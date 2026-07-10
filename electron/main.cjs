const { app, BrowserWindow, Tray, Menu, globalShortcut, clipboard, ipcMain, screen, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.on('uncaughtException', (err) => { if (err.code === 'EPIPE') return; console.error('Uncaught Exception:', err); });

const floatingLayout = require('./floating-layout.cjs');

// ─── Provider Presets & API utilities ─────────────────

const PROVIDER_PRESETS = {
  deepseek:   { name:'DeepSeek', apiType:'openai-compatible-chat', baseUrl:'https://api.deepseek.com', authHeader:'Authorization', authPrefix:'Bearer', models:['deepseek-chat','deepseek-reasoner'], defaultModel:'deepseek-chat' },
  openai:     { name:'OpenAI', apiType:'openai-responses', baseUrl:'https://api.openai.com/v1', authHeader:'Authorization', authPrefix:'Bearer', models:['gpt-5.5','gpt-5.5-pro','gpt-5.4-mini','gpt-5.4-nano'], defaultModel:'gpt-5.4-mini' },
  anthropic:  { name:'Claude', apiType:'anthropic-messages', baseUrl:'https://api.anthropic.com', authHeader:'x-api-key', authPrefix:'', extraHeaders:{'anthropic-version':'2023-06-01'}, models:['claude-sonnet-4-6','claude-opus-4-8','claude-haiku-4-5'], defaultModel:'claude-sonnet-4-6' },
  gemini:     { name:'Gemini', apiType:'gemini-generate-content', baseUrl:'https://generativelanguage.googleapis.com', authHeader:'x-goog-api-key', authPrefix:'', models:['gemini-3.5-flash','gemini-3.1-pro'], defaultModel:'gemini-3.5-flash' },
  kimi:       { name:'Kimi', apiType:'openai-compatible-chat', baseUrl:'https://api.moonshot.ai/v1', authHeader:'Authorization', authPrefix:'Bearer', models:['kimi-k2.6'], defaultModel:'kimi-k2.6' },
  qwen:       { name:'Qwen', apiType:'openai-compatible-chat', baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1', authHeader:'Authorization', authPrefix:'Bearer', models:['qwen3.7-max','qwen3.7-plus','qwen3.6-flash'], defaultModel:'qwen3.6-flash' },
  volcengine: { name:'火山方舟', apiType:'openai-compatible-chat', baseUrl:'https://ark.cn-beijing.volces.com/api/v3', authHeader:'Authorization', authPrefix:'Bearer', models:[], defaultModel:'', modelLabel:'Endpoint ID', hint:'填写火山方舟控制台的 Endpoint ID' },
  grok:       { name:'xAI Grok', apiType:'openai-compatible-chat', baseUrl:'https://api.x.ai/v1', authHeader:'Authorization', authPrefix:'Bearer', models:['grok-4.3','grok-build'], defaultModel:'grok-4.3' },
  custom:     { name:'自定义', apiType:'openai-compatible-chat', baseUrl:'', authHeader:'Authorization', authPrefix:'Bearer', models:[], defaultModel:'' },
};

const PROVIDER_IDS = Object.keys(PROVIDER_PRESETS);

function joinUrl(baseUrl, ...paths) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const parts = paths.filter(Boolean).map(p => String(p).replace(/^\/+/, ''));
  return [base, ...parts].join('/');
}

function getApiUrl(apiType, baseUrl, model) {
  switch (apiType) {
    case 'openai-compatible-chat': return joinUrl(baseUrl, 'chat/completions');
    case 'openai-responses':       return joinUrl(baseUrl, 'responses');
    case 'anthropic-messages':     return joinUrl(baseUrl, 'v1/messages');
    case 'gemini-generate-content':return joinUrl(baseUrl, 'v1beta/models', model, 'generateContent');
    case 'gemini-interactions':    return joinUrl(baseUrl, 'v1beta/interactions');
    default:                       return joinUrl(baseUrl, 'chat/completions');
  }
}

function buildAuthHeaders(provider, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.authHeader && apiKey) {
    headers[provider.authHeader] = provider.authPrefix ? `${provider.authPrefix} ${apiKey}` : apiKey;
  }
  if (provider.extraHeaders) Object.assign(headers, provider.extraHeaders);
  return headers;
}

// ─── Provider Config (separate from store.json) ───

function providerConfigPath() {
  return path.join(dataDir(), 'provider-config.json');
}

function encryptApiKey(plaintext) {
  if (!plaintext) return '';
  if (require('electron').safeStorage.isEncryptionAvailable()) {
    return require('electron').safeStorage.encryptString(plaintext).toString('base64');
  }
  return Buffer.from(plaintext).toString('base64');
}

function decryptApiKey(ciphertext) {
  if (!ciphertext) return '';
  try {
    if (require('electron').safeStorage.isEncryptionAvailable()) {
      return require('electron').safeStorage.decryptString(Buffer.from(ciphertext, 'base64'));
    }
  } catch (_) {}
  try { return Buffer.from(ciphertext, 'base64').toString('utf8'); } catch (_) { return ''; }
}

function readProviderConfig() {
  try {
    if (fs.existsSync(providerConfigPath())) {
      const raw = fs.readFileSync(providerConfigPath(), 'utf8');
      return JSON.parse(raw);
    }
  } catch (_) {}
  return createDefaultProviderConfig();
}

function createDefaultProviderConfig() {
  const providers = {};
  for (const id of PROVIDER_IDS) {
    providers[id] = { enabled: id === 'deepseek', apiKey: '', baseUrl: '', model: '', customModels: [], stream: true, temperature: 0.3, maxTokens: 1200, timeoutMs: 60000 };
  }
  return { configVersion: 1, activeProvider: 'deepseek', providers, skillModelMap: {} };
}

function writeProviderConfig(config) {
  fs.writeFileSync(providerConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

function getActiveProviderConfig() {
  const cfg = readProviderConfig();
  const pid = cfg.activeProvider;
  const preset = PROVIDER_PRESETS[pid] || PROVIDER_PRESETS.custom;
  const pcfg = cfg.providers[pid] || {};
  const models = [...new Set([...preset.models, ...(pcfg.customModels || [])])];
  return {
    id: pid,
    name: preset.name,
    apiType: preset.apiType,
    baseUrl: pcfg.baseUrl || preset.baseUrl,
    authHeader: preset.authHeader,
    authPrefix: preset.authPrefix,
    extraHeaders: preset.extraHeaders || {},
    enabled: pcfg.enabled !== false,
    apiKey: decryptApiKey(pcfg.apiKey),
    model: pcfg.model || preset.defaultModel,
    availableModels: models,
    defaultModel: preset.defaultModel,
    modelLabel: preset.modelLabel || '模型',
    stream: pcfg.stream !== false,
    temperature: pcfg.temperature ?? 0.3,
    maxTokens: pcfg.maxTokens ?? 1200,
    timeoutMs: pcfg.timeoutMs ?? 60000,
  };
}

// ─── SelectionEngine — 统一取词入口 ───
const { createDefaultEngine, markSessionAsShown, isSessionActiveId } = require('./selection-engine.cjs');
// Browser payload cache is set by the HTTP receiver below.
// We pass the getter to createDefaultEngine so BrowserProvider can read it.
const selectionEngine = createDefaultEngine(getBrowserPayload);

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const appUrl = process.env.VITE_DEV_SERVER_URL || `file://${path.join(__dirname, '..', 'dist', 'index.html')}`;

let mainWindow;
let toolbarWindow;
let toolbarMoreWindow;
let resultWindow;
let tray;
let currentSelection = '';
let currentPickedInfo = null;  // PickedInfo from SelectionEngine
let currentAnchorRect = null;
let toolbarMoreAnchor = null;
let currentFloatingSide = 'below';
let resultFloatingSide = null;
let lastSelectionRect = null;
let _currentRecord = null;
let lastGlobalClick = null;

const PERF_LOGGING = true;  // toggle all [PERF] logs; set false for production
let _perfAttemptId = null;


let suppressNextOutsideClick = null;
let speakProcess = null;
let speakToken = 0;
let currentTtsKey = '';
let selectionHelperProcess = null;
let toolbarHideTimer = null;
let toolbarHideGeneration = 0;
let toolbarPointerInside = false;
let toolbarMorePointerInside = false;
let resultPointerInside = false;
let toolbarExpanded = false;
let toolbarInteractionUntil = 0;
let resultInteractionUntil = 0;
let pendingResultTargetHeight = null;
let resultResizeTimer = null;
let overlayState = 'idle';
let currentRunId = null;
let currentAbortController = null;
let toolbarPositionMode = 'auto';       // 'auto' | 'manual'
let toolbarManualPosition = { x: 0, y: 0 };
let toolbarSuppressMoveSync = false;
let resultPositionMode = 'auto';        // 'auto' | 'manual'

// ─── Hotkey config (separate from store.json for fast read) ───
function hotkeyConfigPath() {
  return path.join(dataDir(), 'hotkey-config.json');
}

function readHotkeyConfig() {
  try {
    if (fs.existsSync(hotkeyConfigPath())) {
      return JSON.parse(fs.readFileSync(hotkeyConfigPath(), 'utf8'));
    }
  } catch (_) {}
  return { hotkeyEnabled: true, selectionHotkey: 'Alt+Q' };
}

function writeHotkeyConfig(config) {
  fs.writeFileSync(hotkeyConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

// The currently active registered hotkey (for unregister on change)
let activeRegisteredHotkey = null;

function applyHotkeyConfig(config) {
  if (activeRegisteredHotkey) {
    globalShortcut.unregister(activeRegisteredHotkey);
    activeRegisteredHotkey = null;
  }
  if (config.hotkeyEnabled && config.selectionHotkey) {
    const ok = globalShortcut.register(config.selectionHotkey, showToolbarFromSelection);
    if (ok) {
      activeRegisteredHotkey = config.selectionHotkey;
      console.log('[hotkey] registered:', config.selectionHotkey);
    } else {
      console.error('[hotkey] registration failed for:', config.selectionHotkey);
    }
  }
}

const RESULT_FIXED_WIDTH = 380;
const RESULT_DEFAULT_HEIGHT = 360;
const RESULT_MIN_HEIGHT = 300;
const RESULT_MAX_HEIGHT = 640;
const TOOLBAR_DEFAULT_WIDTH = 620;
const TOOLBAR_MIN_WIDTH = 1;
const TOOLBAR_MAX_WIDTH = 900;
const TOOLBAR_VISUAL_HEIGHT = 52;
const TOOLBAR_TOOLTIP_TOP_SPACE = 26;
const TOOLBAR_FIXED_HEIGHT = TOOLBAR_VISUAL_HEIGHT + TOOLBAR_TOOLTIP_TOP_SPACE;
const TOOLBAR_MORE_FIXED_WIDTH = 190;
// Show the full command list instead of forcing a scrollable menu.
const TOOLBAR_MORE_FIXED_HEIGHT = 150;
let toolbarFixedWidth = TOOLBAR_DEFAULT_WIDTH;
let currentResultHeight = RESULT_DEFAULT_HEIGHT;

const defaultSettings = {
  hotkey: 'Alt+Q',
  api: {
    providerName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    model: 'deepseek-v4-flash',
    apiKey: '',
    stream: false,
  },
  obsidian: {
    vaultPath: '',
    activeTemplateId: 'default',
    saveBehavior: 'inbox',
    fileNameRule: '{{date}} - {{action}} - {{selection_short}}',
    folderRule: 'AI划词/{{action}}/',
    inboxFile: 'AI划词/Inbox/Inbox.md',
    dailyFolder: 'Daily Notes',
    conflictStrategy: 'rename',
    autoOpen: false,
    templates: {
      default: '---\ntitle: "{{ai_title}}"\ntype: "AI划词"\naction: "{{action}}"\nmodel: "{{model}}"\nsource_app: "{{source_app}}"\ncreated: "{{date}} {{time}}"\ntags:\n  - AI划词\n  - "{{action}}"\n---\n\n# {{ai_title}}\n\n## 原文\n\n> {{selection}}\n\n## AI 结果\n\n{{ai_result}}\n\n## 信息\n\n- 来源应用：{{source_app}}\n- 使用模型：{{model}}\n- 创建时间：{{date}} {{time}}\n',
      translate: '---\ntitle: "{{ai_title}}"\ntype: "AI划词"\naction: "{{action}}"\nmodel: "{{model}}"\ncreated: "{{date}} {{time}}"\ntags:\n  - AI划词\n  - 翻译\n---\n\n# {{ai_title}}\n\n## 原文\n\n> {{selection}}\n\n## 翻译结果\n\n{{ai_result}}\n',
      explain: '# {{ai_title}}\n\n> {{selection}}\n\n## 解释\n\n{{ai_result}}\n\n#AI划词 #解释\n',
      summarize: '# {{ai_title}}\n\n## 原文\n\n> {{selection}}\n\n## 总结\n\n{{ai_result}}\n\n#AI划词 #总结\n',
      polish: '# {{ai_title}}\n\n## 原文\n\n> {{selection}}\n\n## 润色结果\n\n{{ai_result}}\n\n#AI划词 #润色\n',
      game: '# {{ai_title}}\n\n## 台词\n\n> {{selection}}\n\n## 解析\n\n{{ai_result}}\n\n#AI划词 #游戏台词\n',
    },
  },
  selection: {
    autoSelect: true,
    dragDistance: 12,
    releaseDelayMs: 120,
  },
};

const defaultSkills = [
  {
    id: 'copy',
    name: '复制',
    icon: '📋',
    iconKey: 'copy',
    enabled: true,
    showInToolbar: true,
    systemPrompt: '',
    userPrompt: '',
    outputMode: 'popup',
    sortOrder: 0,
    type: 'builtin',
    builtinAction: 'copy',
    deletable: false,
  },
  {
    id: 'smart_translate',
    name: '<翻译>',
    icon: '◇',
    iconKey: 'translate',
    enabled: true,
    showInToolbar: true,
    systemPrompt: '你是专业翻译助手。请始终用中文说明。',
    userPrompt: '请严格按下面 Markdown 结构解释划词内容。不要输出开场白，不要说“好的”，不要重复编号。\n\n> {{selection}}\n\n1. 原词 / 原搭配：\n2. 词性标注：\n3. 英文释义（朗文风格）：\n4. 核心译法：\n5. 场景专属译法：\n6. 例句示范：\n7. 易踩坑提醒：',
    outputMode: 'popup',
    sortOrder: 10,
  },
  {
    id: 'translate',
    name: '翻译',
    icon: '译',
    iconKey: 'translate',
    enabled: true,
    showInToolbar: true,
    systemPrompt: '你是专业翻译助手。请用中文回答。',
    userPrompt: '请准确自然地翻译下面内容，并保留必要解释：\n\n{{selection}}',
    outputMode: 'popup',
    sortOrder: 20,
  },
  {
    id: 'explain',
    name: '解释',
    icon: 'i',
    iconKey: 'chat',
    enabled: true,
    showInToolbar: true,
    systemPrompt: '你是擅长解释概念的中文 AI 助手。',
    userPrompt: '请用清楚的中文解释下面内容的含义、背景和重点：\n\n{{selection}}',
    outputMode: 'popup',
    sortOrder: 30,
  },
  {
    id: 'summarize',
    name: '总结',
    icon: '≡',
    iconKey: 'list',
    enabled: true,
    showInToolbar: true,
    systemPrompt: '你是中文阅读总结助手。',
    userPrompt: '请用中文总结下面内容，列出核心要点：\n\n{{selection}}',
    outputMode: 'popup',
    sortOrder: 40,
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    icon: '书',
    iconKey: 'heart',
    enabled: true,
    showInToolbar: true,
    systemPrompt: '你是中文新媒体写作助手。',
    userPrompt: '请把下面内容改写成小红书风格，要求标题吸引人、分点清晰、语气自然，最后给出话题标签：\n\n{{selection}}',
    outputMode: 'popup',
    sortOrder: 50,
  },
  {
    id: 'pronunciation',
    name: '发音',
    icon: '♪',
    iconKey: 'speaker',
    enabled: true,
    showInToolbar: true,
    systemPrompt: '你是英语发音和词汇教学助手。请用中文解释。',
    userPrompt: '请解释下面内容的发音要点、含义和用法：\n\n{{selection}}\n\n请包含：\n1. 单词/短语的准确含义\n2. 发音技巧和重音位置\n3. 例句和常见搭配',
    outputMode: 'popup',
    sortOrder: 25,
    type: 'builtin',
    builtinAction: 'pronunciation',
    deletable: false,
  },
];


/**
 * 兼容旧 skills 没有 iconKey 字段：根据 id/name/旧 icon 推断 iconKey
 */
function getIconKeyFromLegacy(skillId, skillName, oldIcon) {
  const id = String(skillId || '').toLowerCase().trim();
  const name = String(skillName || '').toLowerCase().trim();
  const idMap = {
    'copy': 'copy',
    'smart_translate': 'translate',
    'translate': 'translate',
    'explain': 'chat',
    'lookup': 'search',
    'dictionary': 'search',
    'summarize': 'list',
    'summary': 'list',
    'xiaohongshu': 'heart',
    'obsidian': 'obsidian',
    'import_obsidian': 'obsidian',
    'pronunciation': 'speaker',
    'speak': 'speaker',
    'read': 'book',
  };
  if (idMap[id]) return idMap[id];
  for (const [key, val] of Object.entries(idMap)) {
    if (name.includes(key)) return val;
  }
  return 'spark';
}
const BUILTIN_SKILL_IDS = new Set(['copy', 'pronunciation']);

function normalizeStoredSkill(skill) {
  if (BUILTIN_SKILL_IDS.has(skill.id)) {
    skill.type = 'builtin';
    skill.builtinAction = skill.id === 'copy' ? 'copy' : 'pronunciation';
    skill.deletable = false;
  } else {
    skill.type = 'ai';
    skill.deletable = true;
    delete skill.builtinAction;
  }
  if (!skill.iconKey) skill.iconKey = getIconKeyFromLegacy(skill.id, skill.name, skill.icon);
  return skill;
}
function dataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Auto-migration: ai-selection-desktop -> jiaohua-ai-selection-assistant
function migrateUserDataIfNeeded() {
  try {
    const oldBase = path.join(path.dirname(app.getPath("userData")), "ai-selection-desktop", "data");
    const newBase = dataDir();
    const files = ["store.json", "provider-config.json", "hotkey-config.json"];
    const storePath = path.join(newBase, "store.json");

    if (!fs.existsSync(oldBase)) return;
    if (fs.existsSync(storePath) && fs.statSync(storePath).size > 15000) return;

    const backupDir = path.join(newBase, "backup-" + Date.now());
    fs.mkdirSync(backupDir, { recursive: true });
    for (var fi = 0; fi < files.length; fi++) {
      var src = path.join(newBase, files[fi]);
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, path.join(backupDir, files[fi])); } catch (_) {}
      }
    }

    var count = 0;
    for (var fi = 0; fi < files.length; fi++) {
      var src = path.join(oldBase, files[fi]);
      var dst = path.join(newBase, files[fi]);
      if (fs.existsSync(src)) {
        var srcSize = fs.statSync(src).size;
        var needs = !fs.existsSync(dst) || fs.statSync(dst).size < srcSize;
        if (needs) {
          fs.copyFileSync(src, dst);
          count++;
        }
      }
    }

    if (count > 0) {
      console.log("[Migration] migrated user data from ai-selection-desktop to jiaohua-ai-selection-assistant (" + count + " files)");
    }
  } catch (err) {
    console.error("[Migration] failed:", err.message);
  }
}

function storePath() {
  return path.join(dataDir(), 'store.json');
}

const defaultConversations = [
  { id: 'conv_default', title: '默认对话', pinned: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() },
];

const defaultObsidianTemplates = [
  {
    id: 'default',
    name: 'Default',
    saveBehavior: 'append_to_existing_note_bottom',
    targetNotePath: 'AI划词/默认笔记.md',
    contentTemplate: [
      '---',
      '## {{date}} {{time}} - {{skill_name}}',
      '',
      '### 原文',
      '> {{selection}}',
      '',
      '### AI 结果',
      '{{ai_result}}',
      '',
      '### 信息',
      '- 模型：{{model}}',
      '- 来源：{{source_app}}',
    ].join('\n'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

function readStore() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw);
    const parsedSettings = parsed.settings || {};
    return {
      settings: {
        ...defaultSettings,
        ...parsedSettings,
        api: { ...defaultSettings.api, ...(parsedSettings.api || {}) },
        obsidian: {
          ...defaultSettings.obsidian,
          ...(parsedSettings.obsidian || {}),
          templates: {
            ...defaultSettings.obsidian.templates,
            ...((parsedSettings.obsidian || {}).templates || {}),
          },
        },
        selection: { ...defaultSettings.selection, ...(parsedSettings.selection || {}) },
      },
      skills: (() => {
        const parsed_skills = Array.isArray(parsed.skills) ? parsed.skills : defaultSkills;
        for (const def of defaultSkills) {
          if (def.deletable === false && !parsed_skills.some((s) => s.id === def.id)) {
            parsed_skills.push(def);
          }
        }
        parsed_skills.forEach(normalizeStoredSkill);
        return parsed_skills;
      })(),
      history: Array.isArray(parsed.history) ? parsed.history : [],
      conversations: Array.isArray(parsed.conversations) && parsed.conversations.length > 0 ? parsed.conversations : defaultConversations,
      activeConversationId: parsed.activeConversationId || defaultConversations[0].id,
      obsidianTemplates: Array.isArray(parsed.obsidianTemplates) ? parsed.obsidianTemplates : defaultObsidianTemplates,
    };
  } catch {
    return { settings: defaultSettings, skills: defaultSkills, history: [], conversations: defaultConversations, activeConversationId: defaultConversations[0].id, obsidianTemplates: defaultObsidianTemplates };
  }
}

function writeStore(store) {
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
}

function updateStore(updater) {
  const store = readStore();
  const next = updater(store) || store;
  writeStore(next);
  broadcastHistory(next.history);
  return next;
}

function routeUrl(route) {
  const separator = appUrl.includes('?') ? '&' : '?';
  return `${appUrl}${separator}route=${route}`;
}

function installTextEditContextMenu(win, scope = 'window') {
  if (!win || win.isDestroyed()) return;
  win.webContents.on('context-menu', (event, params) => {
    const editFlags = params.editFlags || {};
    const hasSelection = Boolean(params.selectionText && params.selectionText.length > 0);
    const isEditable = Boolean(params.isEditable);

    if (!isEditable && !hasSelection) return;

    const template = [];

    if (isEditable) {
      template.push(
        { label: '撤销', role: 'undo', enabled: Boolean(editFlags.canUndo) },
        { label: '重做', role: 'redo', enabled: Boolean(editFlags.canRedo) },
        { type: 'separator' },
        { label: '剪切', role: 'cut', enabled: Boolean(editFlags.canCut) },
        { label: '复制', role: 'copy', enabled: Boolean(editFlags.canCopy || hasSelection) },
        { label: '粘贴', role: 'paste', enabled: Boolean(editFlags.canPaste) },
        { label: '粘贴为纯文本', role: 'pasteAndMatchStyle', enabled: Boolean(editFlags.canPaste) },
        { label: '删除', role: 'delete', enabled: Boolean(editFlags.canDelete) },
        { type: 'separator' },
        { label: '全选', role: 'selectAll', enabled: Boolean(editFlags.canSelectAll !== false) }
      );
    } else {
      template.push(
        { label: '复制', role: 'copy', enabled: true },
        { type: 'separator' },
        { label: '全选', role: 'selectAll', enabled: Boolean(editFlags.canSelectAll !== false) }
      );
    }

    try {
      Menu.buildFromTemplate(template).popup({ window: win });
    } catch (error) {
      console.warn('[ContextMenu] popup failed scope=' + scope, error);
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: '饺划',
    icon: path.join(__dirname, '..', 'src', 'assets', 'icon.ico'),
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(routeUrl('main'));
  installTextEditContextMenu(mainWindow, 'main');
  mainWindow.on('focus', () => {
    disableToolbarWindowsForMain('main-focus');
  });
  mainWindow.on('show', () => {
    disableToolbarWindowsForMain('main-show');
  });
}


function boostFloatingWindowForFullscreen(win, label = 'floating') {
  if (!win || win.isDestroyed()) return;
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) {
    try { win.setAlwaysOnTop(true); } catch (_) {}
  }
  try { win.setSkipTaskbar(true); } catch (_) {}
  try { win.setBackgroundColor('#00000000'); } catch (_) {}
  // On Windows fullscreen Chrome/video can sit above ordinary always-on-top windows.
  // Re-applying topmost and moveTop around showInactive() makes the toolbar visible
  // without focusing away from the fullscreen browser.
  try { win.moveTop(); } catch (_) {}
  if (label) {
    try { console.log('[FloatingTopmost] boost ' + label, win.getBounds()); } catch (_) {}
  }
}


function setToolbarWindowBounds(bounds, animate = false) {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return;
  toolbarSuppressMoveSync = true;
  try {
    toolbarWindow.setBounds(bounds, animate);
  } finally {
    setTimeout(() => { toolbarSuppressMoveSync = false; }, 80);
  }
}

function syncToolbarManualPositionFromNativeMove(reason = 'native-move') {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return;
  if (toolbarSuppressMoveSync) return;
  if (overlayState !== 'toolbar_visible') return;
  try {
    const bounds = toolbarWindow.getBounds();
    toolbarPositionMode = 'manual';
    toolbarManualPosition = {
      x: bounds.x,
      y: bounds.y + TOOLBAR_TOOLTIP_TOP_SPACE,
    };
    if (toolbarExpanded) hideToolbarMore();
  } catch (_) {}
}

function createToolbarWindow() {
  toolbarWindow = new BrowserWindow({
    width: toolbarFixedWidth,
    height: TOOLBAR_FIXED_HEIGHT,
    icon: path.join(__dirname, '..', 'src', 'assets', 'icon.ico'),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  boostFloatingWindowForFullscreen(toolbarWindow, 'toolbar:create');
  toolbarWindow.loadURL(routeUrl('toolbar'));
  toolbarWindow.setBackgroundColor('#00000000');
  toolbarWindow.webContents.on('did-finish-load', () => {
    if (toolbarWindow && !toolbarWindow.isDestroyed()) {
      toolbarWindow.setBackgroundColor('#00000000');
      boostFloatingWindowForFullscreen(toolbarWindow, 'toolbar:ready');
    }
  });
  toolbarWindow._visualHeight = TOOLBAR_VISUAL_HEIGHT;
  toolbarWindow.on('move', () => syncToolbarManualPositionFromNativeMove('move'));
  toolbarWindow.on('moved', () => syncToolbarManualPositionFromNativeMove('moved'));
  toolbarWindow.on('closed', () => {
    toolbarWindow = null;
  });
}

function createToolbarMoreWindow() {
  toolbarMoreWindow = new BrowserWindow({
    width: TOOLBAR_MORE_FIXED_WIDTH,
    height: 56,
    icon: path.join(__dirname, '..', 'src', 'assets', 'icon.ico'),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  boostFloatingWindowForFullscreen(toolbarMoreWindow, 'toolbar-more:create');
  toolbarMoreWindow.loadURL(routeUrl('toolbar-more'));
  toolbarMoreWindow.webContents.on('did-finish-load', () => {
    if (toolbarMoreWindow && !toolbarMoreWindow.isDestroyed()) {
      boostFloatingWindowForFullscreen(toolbarMoreWindow, 'toolbar-more:ready');
    }
  });
  toolbarMoreWindow.on('closed', () => {
    toolbarMoreWindow = null;
  });
}

function waitForWindowReady(win, timeoutMs = 1600) {
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  if (!win.webContents.isLoading()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { win.webContents.removeListener('did-finish-load', onFinish); } catch (_) {}
      try { win.webContents.removeListener('did-fail-load', onFail); } catch (_) {}
      resolve(ok);
    };
    const onFinish = () => finish(true);
    const onFail = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    try { win.webContents.once('did-finish-load', onFinish); } catch (_) { finish(false); }
    try { win.webContents.once('did-fail-load', onFail); } catch (_) {}
  });
}

async function ensureToolbarWindowReady() {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) createToolbarWindow();
  await waitForWindowReady(toolbarWindow);
  return toolbarWindow && !toolbarWindow.isDestroyed() ? toolbarWindow : null;
}

async function ensureToolbarMoreWindowReady() {
  if (!toolbarMoreWindow || toolbarMoreWindow.isDestroyed()) createToolbarMoreWindow();
  await waitForWindowReady(toolbarMoreWindow);
  return toolbarMoreWindow && !toolbarMoreWindow.isDestroyed() ? toolbarMoreWindow : null;
}

function createResultWindow() {
  resultWindow = new BrowserWindow({
    width: RESULT_FIXED_WIDTH,
    height: currentResultHeight,
    minWidth: RESULT_FIXED_WIDTH,
    maxWidth: RESULT_FIXED_WIDTH,
    minHeight: RESULT_MIN_HEIGHT,
    maxHeight: RESULT_MAX_HEIGHT,
    icon: path.join(__dirname, '..', 'src', 'assets', 'icon.ico'),
    frame: false,
    resizable: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  boostFloatingWindowForFullscreen(resultWindow, 'result:create');
  resultWindow.loadURL(routeUrl('result'));
  resultWindow.webContents.on('did-finish-load', () => {
    if (resultWindow && !resultWindow.isDestroyed()) {
      boostFloatingWindowForFullscreen(resultWindow, 'result:ready');
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'src', 'assets', 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('JiaoHua AI Selection Assistant');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showMain() },
    { label: '自动划词已开启', enabled: false },
    { label: '显示数据目录', click: () => shell.openPath(dataDir()) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

function showMain() {
  console.log('[Tray] open main window clicked');
  disableToolbarWindowsForMain('show-main');
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.warn('[Tray] mainWindow unavailable after createMainWindow');
    return;
  }
  console.log('[Tray] mainWindow state visible=' + mainWindow.isVisible() + ' minimized=' + mainWindow.isMinimized());
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  console.log('[Tray] mainWindow show/focus done');
}

function placeWindowNearCursor(win, width, height) {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const bounds = display.workArea;
  let x = Math.round(cursor.x - width / 2);
  let y = Math.round(cursor.y - height - 18);
  if (x < bounds.x + 8) x = bounds.x + 8;
  if (x + width > bounds.x + bounds.width - 8) x = bounds.x + bounds.width - width - 8;
  if (y < bounds.y + 8) y = cursor.y + 18;
  if (y + height > bounds.y + bounds.height - 8) y = bounds.y + bounds.height - height - 8;
  win.setBounds({ x, y, width, height });
}

function clampWindowToWorkArea(x, y, width, height, workArea, margin = 8) {
  return floatingLayout.clampWindowToWorkArea(x, y, width, height, workArea, margin);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeHookPoint(x, y) {
  const rawX = Number(x);
  const rawY = Number(y);
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return { x: 0, y: 0 };
  for (const display of screen.getAllDisplays()) {
    const scale = display.scaleFactor || 1;
    const physical = {
      x: display.bounds.x * scale,
      y: display.bounds.y * scale,
      width: display.bounds.width * scale,
      height: display.bounds.height * scale,
    };
    if (
      rawX >= physical.x &&
      rawX <= physical.x + physical.width &&
      rawY >= physical.y &&
      rawY <= physical.y + physical.height
    ) {
      return {
        x: Math.round(display.bounds.x + (rawX - physical.x) / scale),
        y: Math.round(display.bounds.y + (rawY - physical.y) / scale),
      };
    }
  }

  const nearest = screen.getDisplayNearestPoint({ x: rawX, y: rawY });
  const scale = nearest.scaleFactor || 1;
  return {
    x: Math.round(nearest.bounds.x + (rawX - nearest.bounds.x * scale) / scale),
    y: Math.round(nearest.bounds.y + (rawY - nearest.bounds.y * scale) / scale),
  };
}

function calculateToolbarBounds({ anchorRect, toolbarWidth, toolbarHeight, workArea, gap = 6 }) {
  return chooseToolbarPosition(anchorRect, { width: toolbarWidth, height: toolbarHeight }, workArea, gap);
}

function calculateResultCardBounds({ anchorRect, cardWidth, cardHeight, workArea, gap = 8 }) {
  return chooseResultCardPosition(anchorRect, { width: cardWidth, height: cardHeight }, workArea, gap);
}

function chooseToolbarPosition(anchorRect, toolbarSize, workArea, gap = 6) {
  return chooseSelectionAttachedPosition(anchorRect, toolbarSize, workArea, gap);
}

function chooseResultCardPosition(anchorRect, cardSize, workArea, gap = 8) {
  return chooseSelectionAttachedPosition(anchorRect, cardSize, workArea, gap);
}

function chooseSelectionAttachedPosition(anchorRect, windowSize, workArea, gap = 10, margin = 8, preferredSide = null) {
  const positioned = floatingLayout.chooseAttachedPosition(anchorRect, windowSize, workArea, { gap, margin, preferredSide });
  currentFloatingSide = positioned.side;
  console.log('selection attached position', {
    side: positioned.side,
    anchor: anchorRect,
    rect: { x: positioned.x, y: positioned.y, width: windowSize.width, height: windowSize.height },
    spaceAbove: positioned.spaceAbove,
    spaceBelow: positioned.spaceBelow,
    attached: positioned.attached,
    gap,
  });
  return { x: positioned.x, y: positioned.y, width: windowSize.width, height: windowSize.height };
}

function getSelectionAnchorRect() {
  if (currentAnchorRect) return currentAnchorRect;
  const providerRect = normalizeRect(currentPickedInfo?.rect);
  const dragRect = normalizeRect(lastSelectionRect);
  const source = currentPickedInfo?.source || '';
  const sourceRect = chooseAnchorRect({ providerRect, dragRect, source });
  if (!sourceRect || !Number.isFinite(sourceRect.x) || !Number.isFinite(sourceRect.y)) return null;
  return {
    x: Math.round(sourceRect.x),
    y: Math.round(sourceRect.y),
    width: Math.max(1, Math.round(sourceRect.width || 1)),
    height: Math.max(1, Math.round(sourceRect.height || 1)),
  };
}

function normalizeRect(rect) {
  if (!rect) return null;
  const x = rect.x ?? rect.left;
  const y = rect.y ?? rect.top;
  const width = rect.width ?? (Number.isFinite(rect.right) && Number.isFinite(rect.left) ? rect.right - rect.left : undefined);
  const height = rect.height ?? (Number.isFinite(rect.bottom) && Number.isFinite(rect.top) ? rect.bottom - rect.top : undefined);
  if (![x, y, width, height].every((value) => Number.isFinite(Number(value)))) return null;
  return {
    x: Number(x),
    y: Number(y),
    width: Math.max(1, Number(width)),
    height: Math.max(1, Number(height)),
  };
}

function chooseAnchorRect({ providerRect, dragRect, source }) {
  const browserCandidateRect = getBestBrowserCandidateRect(currentPickedInfo);
  if (browserCandidateRect) {
    console.log('selection anchor choice', { source, picked: 'browser-candidate', browserCandidateRect, providerRect, dragRect });
    return browserCandidateRect;
  }
  if (source === 'browser' && providerRect) {
    return providerRect;
  }
  if (!dragRect) return providerRect;
  if (!providerRect) return dragRect;

  const providerArea = providerRect.width * providerRect.height;
  const dragArea = dragRect.width * dragRect.height;
  const providerTooLarge =
    providerRect.width > dragRect.width * 3 ||
    providerRect.height > dragRect.height * 3 ||
    providerArea > dragArea * 6;
  const providerCenter = {
    x: providerRect.x + providerRect.width / 2,
    y: providerRect.y + providerRect.height / 2,
  };
  const dragCenter = {
    x: dragRect.x + dragRect.width / 2,
    y: dragRect.y + dragRect.height / 2,
  };
  const centerDistance = Math.hypot(providerCenter.x - dragCenter.x, providerCenter.y - dragCenter.y);
  const providerFarFromDrag = centerDistance > Math.max(160, Math.max(dragRect.width, dragRect.height) * 2.5);

  if (source === 'windows-uia' || source === 'clipboard' || source === 'ocr') {
    const picked = providerTooLarge || providerFarFromDrag ? dragRect : providerRect;
    console.log('selection anchor choice', { source, picked: picked === dragRect ? 'drag' : 'provider', providerRect, dragRect, providerTooLarge, providerFarFromDrag });
    return picked;
  }

  return providerTooLarge || providerFarFromDrag ? dragRect : providerRect;
}

function getBestBrowserCandidateRect(picked) {
  const candidates = Array.isArray(picked?.candidates) ? picked.candidates : [];
  const browser = candidates.find((candidate) =>
    candidate &&
    candidate.source === 'browser' &&
    candidate.text &&
    (candidate.confidence || 0) >= 0.7 &&
    normalizeRect(candidate.rect)
  );
  return browser ? normalizeRect(browser.rect) : null;
}

function placeToolbarNearSelection() {
  if (!toolbarWindow) return;
  const width = toolbarFixedWidth;
  // Keep the visible toolbar position based on the original visual height.
  // The real BrowserWindow is slightly taller so the hover tooltip can render above it without clipping.
  const visualHeight = TOOLBAR_VISUAL_HEIGHT;
  const windowHeight = TOOLBAR_FIXED_HEIGHT;

  const anchorRect = getSelectionAnchorRect();
  if (!anchorRect) return placeWindowNearCursor(toolbarWindow, width, windowHeight);

  const display = screen.getDisplayNearestPoint({ x: anchorRect.x + anchorRect.width / 2, y: anchorRect.y + anchorRect.height / 2 });
  let bounds;
  if (toolbarPositionMode === 'manual') {
    // toolbarManualPosition stores the VISIBLE toolbar top-left, not the real BrowserWindow top-left.
    // The BrowserWindow has a transparent tooltip area above the visible toolbar, so convert only
    // after clamping the visible rect. This keeps dragging under the cursor and avoids edge jumps.
    const manualDisplay = screen.getDisplayNearestPoint({
      x: toolbarManualPosition.x + width / 2,
      y: toolbarManualPosition.y + visualHeight / 2,
    });
    const visual = clampWindowToWorkArea(
      toolbarManualPosition.x,
      toolbarManualPosition.y,
      width,
      visualHeight,
      manualDisplay.workArea,
      8
    );
    toolbarManualPosition = { x: visual.x, y: visual.y };
    bounds = {
      x: visual.x,
      y: visual.y - TOOLBAR_TOOLTIP_TOP_SPACE,
      width,
      height: windowHeight,
    };
  } else {
    const visualBounds = calculateToolbarBounds({ anchorRect, toolbarWidth: width, toolbarHeight: visualHeight, workArea: display.workArea });
    bounds = {
      x: visualBounds.x,
      y: visualBounds.y - TOOLBAR_TOOLTIP_TOP_SPACE,
      width,
      height: windowHeight,
    };
    bounds = {
      ...clampWindowToWorkArea(bounds.x, bounds.y, bounds.width, bounds.height, display.workArea, 8),
      width,
      height: windowHeight,
    };
  }
  setToolbarWindowBounds(bounds, false);
}

function placeResultNearSelection() {
  if (!resultWindow) return;
  const width = RESULT_FIXED_WIDTH;
  const height = currentResultHeight;
  const anchorRect = getSelectionAnchorRect();
  if (!anchorRect) return placeWindowNearCursor(resultWindow, width, height);
  const display = screen.getDisplayNearestPoint({ x: anchorRect.x + anchorRect.width / 2, y: anchorRect.y + anchorRect.height / 2 });
  const positioned = floatingLayout.chooseAttachedPosition(anchorRect, { width, height }, display.workArea, {
    gap: 8,
    margin: 8,
    preferredSide: resultFloatingSide,
  });
  resultFloatingSide = positioned.side;
  currentFloatingSide = positioned.side;
  console.log('result attached position', {
    side: positioned.side,
    anchor: anchorRect,
    rect: { x: positioned.x, y: positioned.y, width, height },
    spaceAbove: positioned.spaceAbove,
    spaceBelow: positioned.spaceBelow,
    attached: positioned.attached,
  });
  resultWindow.setBounds({ x: positioned.x, y: positioned.y, width, height }, false);
}

function pumpResultResize() {
  if (!resultWindow || resultWindow.isDestroyed()) return;
  if (resultResizeTimer) return;
  resultResizeTimer = setTimeout(() => {
    resultResizeTimer = null;
    const bounds = resultWindow.getBounds();
    const curH = bounds.height;
    const targetHeight = pendingResultTargetHeight;
    if (!targetHeight) return;
    const display = screen.getDisplayMatching(bounds);
    const wa = display.workArea;
    const margin = 12;
    let nextHeight = targetHeight;
    if (targetHeight > curH) {
      nextHeight = Math.min(curH + 48, targetHeight);
    } else {
      if (curH - targetHeight < 32) { pendingResultTargetHeight = null; return; }
      nextHeight = targetHeight;
    }
    if (nextHeight > wa.height - margin * 2) nextHeight = wa.height - margin * 2;
    const curBottom = bounds.y + curH;
    const spaceBelow = (wa.y + wa.height - margin) - curBottom;
    const spaceAbove = bounds.y - (wa.y + margin);
    const extraNeeded = Math.max(0, nextHeight - curH);
    let nextY = bounds.y;
    if (nextHeight > curH) {
      if (spaceBelow < extraNeeded && spaceAbove >= extraNeeded) {
        nextY = curBottom - nextHeight;
      }
    }
    if (nextY < wa.y + margin) nextY = wa.y + margin;
    if (nextY + nextHeight > wa.y + wa.height - margin) {
      nextHeight = wa.y + wa.height - margin - nextY;
    }
    const clamped = clampWindowToWorkArea(bounds.x, nextY, RESULT_FIXED_WIDTH, nextHeight, wa, 8);
    resultWindow.setBounds({ x: clamped.x, y: clamped.y, width: RESULT_FIXED_WIDTH, height: nextHeight }, true);
    currentResultHeight = nextHeight;
      const after = resultWindow.getBounds();
    if (Math.abs(after.height - targetHeight) >= 8) {
      if (after.height === curH) return;
      pumpResultResize();
    }
  }, 16);
}

function resizeResultWindowHeight(desiredHeight) {
  if (!resultWindow || resultWindow.isDestroyed()) return { ok: false };
  const bounds = resultWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const wa = display.workArea;
  const margin = 12;
  const desired = Math.ceil(Number(desiredHeight) || RESULT_DEFAULT_HEIGHT);
  const maxHeight = Math.min(RESULT_MAX_HEIGHT, wa.height - margin * 2);
  const targetHeight = clamp(desired, RESULT_MIN_HEIGHT, maxHeight);
  pendingResultTargetHeight = targetHeight;
  if (!resultResizeTimer) pumpResultResize();
  return { ok: true, width: RESULT_FIXED_WIDTH, height: bounds.height };
}

function getSelectionSideHeightLimit(anchorRect, workArea, gap = 8, margin = 8, desiredHeight = RESULT_DEFAULT_HEIGHT) {
  const sideLimit = floatingLayout.getSideHeightLimit(anchorRect, workArea, {
    gap,
    margin,
    desiredHeight,
    minHeight: RESULT_MIN_HEIGHT,
    preferredSide: resultFloatingSide,
  });
  resultFloatingSide = sideLimit.side;
  return sideLimit.limit;
}

function placeToolbarMoreNearToolbar() {
  if (!toolbarWindow || !toolbarMoreWindow || toolbarWindow.isDestroyed() || toolbarMoreWindow.isDestroyed()) return;
  const toolbarBounds = toolbarWindow.getBounds();
  const width = TOOLBAR_MORE_FIXED_WIDTH;
  const height = toolbarMoreWindow.getBounds().height;
  // toolbarWindow contains a transparent tooltip strip above the visible capsule.
  // Attach the menu to the visible capsule, otherwise an above placement leaves
  // TOOLBAR_TOOLTIP_TOP_SPACE pixels of apparent empty distance.
  const visibleToolbarBounds = {
    x: toolbarBounds.x,
    y: toolbarBounds.y + TOOLBAR_TOOLTIP_TOP_SPACE,
    width: toolbarBounds.width,
    height: TOOLBAR_VISUAL_HEIGHT,
  };
  const display = screen.getDisplayNearestPoint({
    x: visibleToolbarBounds.x + visibleToolbarBounds.width / 2,
    y: visibleToolbarBounds.y + visibleToolbarBounds.height / 2,
  });
  const wa = display.workArea;
  const gap = 2;
  const spaceBelow = (wa.y + wa.height) - (visibleToolbarBounds.y + visibleToolbarBounds.height);
  const spaceAbove = visibleToolbarBounds.y - wa.y;
  let placement = 'below';
  let x, y;

  if (toolbarMoreAnchor) {
    const btnScreenX = visibleToolbarBounds.x + toolbarMoreAnchor.x;
    x = btnScreenX + toolbarMoreAnchor.width - width;
    toolbarMoreAnchor = null;
  } else {
    x = visibleToolbarBounds.x + visibleToolbarBounds.width - width;
  }
  x = Math.max(wa.x + gap, Math.min(x, wa.x + wa.width - width - gap));

  if (spaceBelow >= height + gap) {
    y = visibleToolbarBounds.y + visibleToolbarBounds.height + gap;
    placement = 'below';
  } else if (spaceAbove >= height + gap) {
    y = visibleToolbarBounds.y - height - gap;
    placement = 'above';
  } else {
    y = visibleToolbarBounds.y + visibleToolbarBounds.height + gap;
    placement = 'fallback';
  }
  y = Math.max(wa.y + gap, Math.min(y, wa.y + wa.height - height - gap));

  console.log('[MoreMenu position]', JSON.stringify({ toolbarBounds, visibleToolbarBounds, width, height, gap, spaceAbove, spaceBelow, placement, finalX: x, finalY: y }));
  console.log('[MoreMenu size check]', JSON.stringify({ windowBoundsBefore: {}, menuWidth: width, menuHeight: height, placement, finalX: x, finalY: y, windowBoundsAfter: {} }));
  toolbarMoreWindow.setBounds({ x, y, width, height }, false);
}


/* ───── 发音词典 ───── */

function detectPronunciationMode(text) {
  return /^[a-zA-Z'-]+$/.test(text.trim()) ? 'word' : 'sentence';
}

async function fetchDictionary(word) {
  const w = encodeURIComponent(word.trim());
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${w}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const entry = data[0];
    let usIpa = '', gbIpa = '';
    for (const phonetic of entry.phonetics || []) {
      if (!usIpa && phonetic.audio?.includes('-us')) usIpa = phonetic.text || '';
      if (!gbIpa && phonetic.audio?.includes('-uk')) gbIpa = phonetic.text || '';
    }
    if (!usIpa) {
      for (const phonetic of entry.phonetics || []) {
        if (!usIpa && !(phonetic.audio?.includes('-uk'))) usIpa = phonetic.text || '';
        if (!gbIpa && phonetic.audio?.includes('-uk')) gbIpa = phonetic.text || '';
      }
    }
    return { us_ipa: usIpa, gb_ipa: gbIpa };
  } catch {
    return null;
  }
}

async function runPronunciationSkill(skill, selectedText) {
  const store = readStore();
  const mode = detectPronunciationMode(selectedText);
  let ipaData = null;
  if (mode === 'word') {
    ipaData = await fetchDictionary(selectedText);
  }

  const pronunciationData = {
    mode,
    text: selectedText,
    us_ipa: ipaData?.us_ipa || '',
    gb_ipa: ipaData?.gb_ipa || '',
  };

  const createdAt = new Date().toISOString();
  let record = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt,
    sourceApp: 'Windows',
    windowTitle: '当前应用',
    selectedText,
    skillId: skill.id,
    skillName: skill.name,
    providerId: store.settings.api.providerName,
    model: store.settings.api.model,
    prompt: '',
    answerMarkdown: '',
    status: 'running',
    savedToObsidian: false,
    obsidianPath: '',
    pronunciationData,
  };

  if (!resultWindow) createResultWindow();
  currentResultHeight = RESULT_DEFAULT_HEIGHT;
  resultPositionMode = 'auto';
  resultFloatingSide = null;

  // Cancel previous run before starting new one
  if (currentAbortController) {
    try { currentAbortController.abort(); } catch (_) {}
  }
  const thisRunId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  currentRunId = thisRunId;
  currentAbortController = new AbortController();

  placeResultNearSelection();
  resultWindow.webContents.send('result:ready', { ...record, runId: currentRunId });
  boostFloatingWindowForFullscreen(resultWindow, 'result:before-show');
  resultWindow.showInactive();
  boostFloatingWindowForFullscreen(resultWindow, 'result:after-show');
  hideToolbarViaCss();

  try {
    const result = await callModelStreaming(skill, selectedText, (_delta, fullText, callbackRunId) => {
      const nextText = fullText || `${record.answerMarkdown}${_delta || ''}`;
      record = { ...record, answerMarkdown: nextText };
      if (resultWindow && !resultWindow.isDestroyed()) {
        resultWindow.webContents.send('result:update', { ...record, runId: callbackRunId });
      }
    });
    record = { ...record, providerId: result.providerId, model: result.model, prompt: result.prompt, answerMarkdown: result.answer, status: 'completed' };
  } catch (error) {
    record = { ...record, answerMarkdown: error instanceof Error ? error.message : String(error), status: 'failed' };
  }
  saveRecord(record);
  if (resultWindow && !resultWindow.isDestroyed()) {
    resultWindow.webContents.send('result:update', { ...record, runId: currentRunId });
  }
  return record;
}

function simulateCopy() {
  return new Promise((resolve) => {
    const script = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^c")';
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true }, () => resolve());
  });
}

async function captureViaEngine(context) {
  const _aid2 = (context && context._perfAttemptId) || '';
  if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'capture_engine_start', hasAttemptId: !!_aid2, attemptId: _aid2 }));
  const timeoutMs = (context?.dragDistance && context.dragDistance > 500) ? 3000 : 2000;
  const startTime = Date.now();
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), timeoutMs)
  );
  try {
    const picked = await Promise.race([
      selectionEngine.getPickedInfo(context || {}),
      timeoutPromise
    ]);
    if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'capture_engine_end', duration: Date.now() - startTime, pickedSource: (picked && picked.source) || '', pickedTextLen: (picked && picked.text) ? picked.text.length : 0, pickedConf: (picked && picked.confidence) || 0, attemptId: _aid2 }));
    return picked;
  } catch (err) {
    const duration = Date.now() - startTime;
    if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'capture_engine_timeout', duration, attemptId: _aid2 }));
    console.log('[SelectionEngine] capture timeout attempt=' + Date.now().toString(36) + ' duration=' + duration + 'ms');
    return {
      text: '',
      source: 'manual',
      confidence: 0,
      metadata: { needsManualSelection: true },
    };
  }
}

async function showToolbarFromSelection(context) {
  _perfAttemptId = context._perfAttemptId || null;
  const picked = await captureViaEngine(context);
 
  return showToolbarForPicked(picked);
}

function startSelectionHelper() {
  if (selectionHelperProcess) return;
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class MouseHookRunner {
  private const int WH_MOUSE_LL = 14;
  private const int WM_LBUTTONDOWN = 0x0201;
  private const int WM_LBUTTONUP = 0x0202;
  private const int WM_RBUTTONDOWN = 0x0204;
  private const int WM_MBUTTONDOWN = 0x0207;
  private const byte VK_CONTROL = 0x11;
  private const byte VK_C = 0x43;
  private const uint KEYEVENTF_KEYUP = 0x0002;
  private static IntPtr hookId = IntPtr.Zero;
  private static LowLevelMouseProc proc = HookCallback;
  private static int downX = 0;
  private static int downY = 0;
  private static long downAt = 0;
  private static long lastCaptureAt = 0;
  private static int minDistance = 12;

  public static void Run() {
    hookId = SetHook(proc);
    Application.Run();
    UnhookWindowsHookEx(hookId);
  }

  private static IntPtr SetHook(LowLevelMouseProc proc) {
    using (Process curProcess = Process.GetCurrentProcess())
    using (ProcessModule curModule = curProcess.MainModule) {
      return SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(curModule.ModuleName), 0);
    }
  }

  private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

  private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      MSLLHOOKSTRUCT hookStruct = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
      int message = wParam.ToInt32();
      if (message == WM_LBUTTONDOWN) {
        downX = hookStruct.pt.x;
        downY = hookStruct.pt.y;
        downAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Console.WriteLine("CLICK|" + hookStruct.pt.x + "|" + hookStruct.pt.y);
        Console.Out.Flush();
      } else if (message == WM_LBUTTONUP) {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        int dx = hookStruct.pt.x - downX;
        int dy = hookStruct.pt.y - downY;
        double distance = Math.Sqrt(dx * dx + dy * dy);
        long duration = now - downAt;
        if (distance >= minDistance && duration >= 80 && now - lastCaptureAt > 250) {
          lastCaptureAt = now;
          BeginCapture(downX, downY, hookStruct.pt.x, hookStruct.pt.y);
        }
      } else if (message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN) {
        Console.WriteLine("CLICK|" + hookStruct.pt.x + "|" + hookStruct.pt.y);
        Console.Out.Flush();
      }
    }
    return CallNextHookEx(hookId, nCode, wParam, lParam);
  }

  private static void BeginCapture(int startX, int startY, int endX, int endY) {
    Thread captureThread = new Thread(() => {
      try {
        Thread.Sleep(35);
        string processName = "";
        string windowTitle = "";
        try {
          IntPtr hwnd = GetForegroundWindow();
          StringBuilder title = new StringBuilder(512);
          GetWindowText(hwnd, title, title.Capacity);
          windowTitle = title.ToString();
          uint pid;
          GetWindowThreadProcessId(hwnd, out pid);
          if (pid > 0) processName = Process.GetProcessById((int)pid).ProcessName;
        } catch {}
        string encodedProcess = Convert.ToBase64String(Encoding.UTF8.GetBytes(processName));
        string encodedTitle = Convert.ToBase64String(Encoding.UTF8.GetBytes(windowTitle));
        Console.WriteLine("SELECTED||" + startX + "|" + startY + "|" + endX + "|" + endY + "|" + encodedProcess + "|" + encodedTitle);
        Console.Out.Flush();
      } catch (Exception ex) {
        string encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(ex.Message));
        Console.WriteLine("ERROR|" + encoded);
        Console.Out.Flush();
      }
    });
    captureThread.SetApartmentState(ApartmentState.STA);
    captureThread.IsBackground = true;
    captureThread.Start();
  }

  private static void SendCtrlC() {
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
    keybd_event(VK_C, 0, 0, UIntPtr.Zero);
    keybd_event(VK_C, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct POINT { public int x; public int y; }

  [StructLayout(LayoutKind.Sequential)]
  private struct MSLLHOOKSTRUCT {
    public POINT pt;
    public uint mouseData;
    public uint flags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool UnhookWindowsHookEx(IntPtr hhk);

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern IntPtr GetModuleHandle(string lpModuleName);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@ -ReferencedAssemblies System.Windows.Forms
[MouseHookRunner]::Run()
`;
  selectionHelperProcess = execFile('powershell.exe', ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
  selectionHelperProcess.stdout.on('data', (chunk) => {
    String(chunk).split(/\r?\n/).forEach((line) => handleSelectionHelperLine(line.trim()));
  });
  selectionHelperProcess.on('exit', () => {
    selectionHelperProcess = null;
  });
}

function stopSelectionHelper() {
  if (selectionHelperProcess) {
    selectionHelperProcess.kill();
    selectionHelperProcess = null;
  }
}

function handleSelectionHelperLine(line) {
  if (line.startsWith('CLICK|')) {
    handleGlobalClick(line);
    console.log('[Mouse] CLICK event processed');
    return;
  }
  if (!line.startsWith('SELECTED|')) return;
  const attemptId = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  console.log('[Mouse] SELECTED received attempt=' + attemptId);
  _perfAttemptId = attemptId;
  const store = readStore();
  if (!store.settings.selection?.autoSelect) return;
  const parts = line.split('|');
  const encoded = parts[1] || '';
  const rawStart = { x: Number(parts[2]), y: Number(parts[3]) };
  const rawEnd = { x: Number(parts[4]), y: Number(parts[5]) };
  const start = normalizeHookPoint(parts[2], parts[3]);
  const end = normalizeHookPoint(parts[4], parts[5]);
  const foregroundProcessName = Buffer.from(parts[6] || '', 'base64').toString('utf8').trim();
  const foregroundWindowTitle = Buffer.from(parts[7] || '', 'base64').toString('utf8').trim();
  const meta = {
    startX: start.x,
    startY: start.y,
    endX: end.x,
    endY: end.y,
  };
  if (shouldIgnoreSelectionFromFloatingToolbar(meta, foregroundProcessName, foregroundWindowTitle)) return;
  lastSelectionRect = makeSelectionRect(meta);
  const clipboardText = Buffer.from(encoded, 'base64').toString('utf8').trim();
  const rawText = clipboardText;
  if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'selected_clipboard', textLen: clipboardText.length, attemptId: attemptId }));
  if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'capture_via_engine_start', attemptId: attemptId }));

  // Use SelectionEngine to get the picked info
  // The engine's ClipboardProvider will also do Ctrl+C for verification,
  // and chooseBestPickedInfo will select the best result.
  const context = {
    cursorStart: { x: meta.startX, y: meta.startY },
    cursorEnd: { x: meta.endX, y: meta.endY },
    rawCursorStart: rawStart,
    rawCursorEnd: rawEnd,
    dragDistance: Math.sqrt(
      Math.pow(meta.endX - meta.startX, 2) + Math.pow(meta.endY - meta.startY, 2)
    ),
    foregroundProcessName,
    foregroundWindowTitle,
    _perfAttemptId: attemptId,
    _at: Date.now(),
  };

  // Fire-and-forget: the engine handles clipboard internally
  const startTime = Date.now();
  captureViaEngine(context).then((picked) => {
    console.log('[Debug] captureViaEngine returned', JSON.stringify({ textLen: picked && picked.text ? picked.text.length : 0, source: picked && picked.source, confidence: picked && picked.confidence, expired: picked && picked._expired, sessionId: picked && picked._sessionId, needsManualSelection: picked && picked.needsManualSelection }));
    const duration = Date.now() - startTime;
    console.log('[Mouse] pick done attempt=' + attemptId + ' duration=' + duration + 'ms resultProvider=' + (picked?.source || 'none') + ' textLen=' + (picked?.text || '').length + ' conf=' + (picked?.confidence || 0));
    // needsManualSelection takes priority over garbage text from UIA estimated results
    if (picked && (picked.needsManualSelection || picked.metadata?.needsManualSelection)) {
      console.log('[selection:autoSelect] needs manual selection, blocking garbage text:', JSON.stringify({
        reason: picked.reason || '',
        textPreview: (picked.text || '').slice(0, 40),
        confidence: picked.confidence,
      }));
    } else if (picked && picked.text) {
      // Drag distance guard: small drag with stale/uncertain result => block toolbar
      // Browser fast path (high confidence) and fresh clipboard are always allowed
      const dragDist = context?.dragDistance || 0;
      const source = picked.source || picked.provider || picked.resultProvider || 'unknown';
      const conf = picked.confidence || 0;
      const isHighConfBrowser = ['browser', 'browser-extension', 'youtube-native-caption', 'trancy-caption'].includes(source) && conf >= 0.86;
      const isFreshClipboard = source === 'clipboard' && picked.metadata?.clipboardChanged;
      if (dragDist > 0 && dragDist < 18 && !isHighConfBrowser && !isFreshClipboard) {
        console.log('[Toolbar] blocked show reason=drag-too-small distance=' + Math.round(dragDist) + ' source=' + source + ' conf=' + conf);
        return;
      }
      const refinedPicked = applyMouseRefinement(picked, rawText, clipboardText, meta);
      if (shouldBlockUnrefinedSubtitleClipboard(refinedPicked, meta)) {
        console.log('[selection:autoSelect] blocked unrefined subtitle clipboard sentence:', JSON.stringify({
          textPreview: (refinedPicked.text || '').slice(0, 80),
          dragWidth: Math.abs(meta.endX - meta.startX),
          dragHeight: Math.abs(meta.endY - meta.startY),
        }));
        return;
      }
      showToolbarForPicked(refinedPicked);
    } else if (rawText) {
      // Fallback: if engine returns nothing, use the raw text from the hook
      const dragDist = context?.dragDistance || 0;
      if (dragDist > 0 && dragDist < 18) {
        console.log('[Toolbar] blocked fallback show reason=drag-too-small distance=' + Math.round(dragDist) + ' source=clipboard');
        return;
      }
      showToolbarForPicked({
        text: rawText,
        fullText: rawText,
        source: 'clipboard',
        confidence: 0.45,
        metadata: { rawFromHook: true },
      });
    }
  });
}

function applyMouseRefinement(picked, refinedText, clipboardText, meta) {
  // Do not synthesize a smaller phrase from clipboard text and mouse coords.
  // That approximation is what caused subtitle drags to drift from "Forgive"
  // to "me for letting". Only real providers (browser DOM/UIA/OCR) may refine.
  return picked;
}

function shouldBlockUnrefinedSubtitleClipboard(picked, meta) {
  return false;
  if (!picked || picked.source !== 'clipboard' || !meta) return false;
  const text = String(picked.text || '').trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const dx = Math.abs(Number(meta.endX) - Number(meta.startX));
  const dy = Math.abs(Number(meta.endY) - Number(meta.startY));
  return words > 3 && dx <= 140 && dy <= 42;
}

function showToolbarForText(selected) {
  showToolbarForPicked({
    text: selected,
    fullText: selected,
    source: 'clipboard',
    confidence: 0.5,
  });
}

/**
 * Show toolbar with PickedInfo from SelectionEngine.
 * This is the canonical way to show the toolbar — always call this
 * instead of showToolbarForText() directly.
 */
async function showToolbarForPicked(picked) {
    console.log('[Debug] showToolbarForPicked enter', JSON.stringify({ hasPicked: !!picked, textLen: picked && picked.text ? picked.text.length : 0, source: picked && picked.source, confidence: picked && picked.confidence, expired: picked && picked._expired, sessionId: picked && picked._sessionId }));
  // Session guards
  if (!picked || picked._expired) {
 
    return;
  }
  if (picked._sessionId && typeof isSessionActiveId === 'function' && !isSessionActiveId(picked._sessionId)) {
 
    return;
  }
const _tbStart = Date.now();
const aid = _perfAttemptId || '';
  if (!picked || !picked.text) return;
  // Text quality: block if text is just whitespace
  const text = String(picked.text || '').trim();
  if (!text) {
    console.log('[Toolbar] blocked show reason=empty-text');
    return;
  }
  // Low-confidence guard: block if confidence < 0.5 and not from browser
  const source = picked.source || picked.provider || 'unknown';
  const conf = picked.confidence || 0;
  if (conf < 0.5 && source !== 'browser') {
 
    return;
  }
  // New selection while AI generating or result visible: cancel old state first
  if (overlayState === 'ai_generating' || overlayState === 'result_visible') {
    console.log('[Toolbar] new selection resetting overlayState=' + overlayState);
    if (currentAbortController) {
      try { currentAbortController.abort('new-selection'); } catch (_) {}
      currentAbortController = null;
    }
    currentRunId = null;
    if (resultWindow && !resultWindow.isDestroyed()) {
      resultWindow.webContents.send('result:reset');
      resultWindow.hide();
    }
    hideToolbarMore();
    hideToolbarViaCss();
    resultPointerInside = false;
    resultInteractionUntil = 0;
    overlayState = 'idle';
  }
  currentSelection = picked.text;
  currentPickedInfo = picked;
  currentAnchorRect = null;
  currentAnchorRect = getSelectionAnchorRect();
  toolbarPositionMode = 'auto';
  toolbarManualPosition = { x: 0, y: 0 };
  resultPositionMode = 'auto';
  resultFloatingSide = null;
  overlayState = 'toolbar_visible';
  toolbarPointerInside = false;
  toolbarMorePointerInside = false;
  toolbarExpanded = false;
  toolbarInteractionUntil = Date.now() + 800;
  await ensureToolbarWindowReady();
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return;
  placeToolbarNearSelection();
  destroyToolbarMoreWindow('new-toolbar-show');
  toolbarHideGeneration += 1;
  toolbarWindow.setIgnoreMouseEvents(false);
  boostFloatingWindowForFullscreen(toolbarWindow, 'toolbar:before-show');
  if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'toolbar_show_inactive', durationMs: Date.now() - _tbStart, textLen: text.length, attemptId: aid }));
  console.log('[Toolbar] before showInactive', JSON.stringify({ textLen: text.length, source: picked.source }));
  toolbarWindow.showInactive();
  boostFloatingWindowForFullscreen(toolbarWindow, 'toolbar:after-show');
  setTimeout(() => boostFloatingWindowForFullscreen(toolbarWindow, 'toolbar:after-show-delay'), 80);
  console.log('toolbar show for selection', {
    textLength: String(picked.text || '').length,
    bounds: toolbarWindow.getBounds(),
    skills: getToolbarSkills().map((skill) => skill.name),
  });
  toolbarWindow.webContents.send('toolbar:show');
  toolbarWindow.webContents.send('selection:ready', {
    pickedInfo: picked,
    selection: picked.text,   // backward compat
    attemptId: aid,
    skills: getToolbarSkills(),
    allSkills: readStore().skills,
  });

  // Notify session: toolbar shown
  if (typeof markSessionAsShown === 'function' && picked._sessionId) {
    markSessionAsShown(picked._sessionId);
  }
  if (PERF_LOGGING) console.log('[PERF]', JSON.stringify({ event: 'toolbar_ready', totalDurationMs: Date.now() - _tbStart, textLen: text.length, attemptId: aid }));
  scheduleToolbarHide();
}

function refineSelectionText(text, meta) {
  const value = String(text || '').trim();
  if (!value || !meta) return value;
  const dx = Math.abs(Number(meta.endX) - Number(meta.startX));
  const dy = Math.abs(Number(meta.endY) - Number(meta.startY));
  const singleLine = !/[\r\n]/.test(value);
  const wordMatches = Array.from(value.matchAll(/[A-Za-z][A-Za-z'’-]*|[\u4e00-\u9fa5]|[\d.]+/g));
  if (!singleLine || wordMatches.length <= 1 || value.length < 18 || dx > 480 || dy > 42) return value;

  const midPoint = { x: (Number(meta.startX) + Number(meta.endX)) / 2, y: (Number(meta.startY) + Number(meta.endY)) / 2 };
  const display = screen.getDisplayNearestPoint(midPoint);
  const approxCharWidth = /[\u4e00-\u9fa5]/.test(value) ? 28 : 16.5;
  const approxLineWidth = Math.min(display.workArea.width * 0.92, Math.max(180, value.length * approxCharWidth));
  let lineLeft = display.workArea.x + display.workArea.width / 2 - approxLineWidth / 2;
  if (dx <= 220 && wordMatches.length > 3) {
    lineLeft = Math.min(Number(meta.startX), Number(meta.endX)) - 4;
  }
  const startRatio = Math.max(0, Math.min(1, (Math.min(meta.startX, meta.endX) - lineLeft) / approxLineWidth));
  const endRatio = Math.max(0, Math.min(1, (Math.max(meta.startX, meta.endX) - lineLeft) / approxLineWidth));
  const startChar = Math.floor(startRatio * value.length);
  const endChar = Math.max(startChar + 1, Math.ceil(endRatio * value.length));
  const selectedWords = wordMatches
    .filter((match) => {
      const start = match.index || 0;
      const end = start + match[0].length;
      return end >= startChar && start <= endChar;
    })
    .map((match) => match[0]);

  if (selectedWords.length > 0 && selectedWords.length <= 6) return selectedWords.join(' ');
  if (dx <= 110 && wordMatches.length > 3) {
    const dragCenterRatio = Math.max(0, Math.min(1, (midPoint.x - lineLeft) / approxLineWidth));
    const dragCenterChar = Math.floor(dragCenterRatio * value.length);
    const nearest = wordMatches
      .map((match) => {
        const start = match.index || 0;
        const end = start + match[0].length;
        return {
          text: match[0],
          distance: Math.abs(((start + end) / 2) - dragCenterChar),
        };
      })
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest && nearest.text) return nearest.text;
  }
  return value;
}

function makeSelectionRect(meta) {
  if (!meta || !Number.isFinite(meta.startX) || !Number.isFinite(meta.endX) || !Number.isFinite(meta.startY) || !Number.isFinite(meta.endY)) return null;
  const rawLeft = Math.min(meta.startX, meta.endX);
  const rawRight = Math.max(meta.startX, meta.endX);
  const rawTop = Math.min(meta.startY, meta.endY);
  const rawBottom = Math.max(meta.startY, meta.endY);
  const centerX = (rawLeft + rawRight) / 2;
  const centerY = (rawTop + rawBottom) / 2;
  const width = Math.max(90, rawRight - rawLeft);
  const height = Math.max(28, rawBottom - rawTop);
  const left = Math.round(centerX - width / 2);
  const right = Math.round(centerX + width / 2);
  const top = Math.round(centerY - height / 2);
  const bottom = Math.round(centerY + height / 2);
  return { left, right, top, bottom, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
function pointInWindowBounds(point, bounds, pad = 0) {
  if (!point || !bounds) return false;
  return point.x >= bounds.x - pad &&
    point.x <= bounds.x + bounds.width + pad &&
    point.y >= bounds.y - pad &&
    point.y <= bounds.y + bounds.height + pad;
}

function selectionRectIntersectsBounds(meta, bounds, pad = 0) {
  if (!meta || !bounds) return false;
  const left = Math.min(meta.startX, meta.endX);
  const right = Math.max(meta.startX, meta.endX);
  const top = Math.min(meta.startY, meta.endY);
  const bottom = Math.max(meta.startY, meta.endY);
  return right >= bounds.x - pad &&
    left <= bounds.x + bounds.width + pad &&
    bottom >= bounds.y - pad &&
    top <= bounds.y + bounds.height + pad;
}

function shouldIgnoreSelectionFromFloatingToolbar(meta, foregroundProcessName = '', foregroundWindowTitle = '') {
  // The global WH_MOUSE_LL hook sees dragging the floating toolbar as a normal mouse drag.
  // If we let that drag enter the selection pipeline, showToolbarForPicked() will auto-place
  // the toolbar near the stale clipboard/selection and the toolbar appears to "jump".
  const toolbarVisible = toolbarWindow && !toolbarWindow.isDestroyed() && toolbarWindow.isVisible();
  const moreVisible = toolbarMoreWindow && !toolbarMoreWindow.isDestroyed() && toolbarMoreWindow.isVisible();
  if (!toolbarVisible && !moreVisible) return false;

  const start = { x: meta.startX, y: meta.startY };
  const end = { x: meta.endX, y: meta.endY };
  const toolbarBounds = toolbarVisible ? toolbarWindow.getBounds() : null;
  const moreBounds = moreVisible ? toolbarMoreWindow.getBounds() : null;
  const toolbarPad = 10;
  const morePad = 8;

  const hitToolbar = toolbarBounds && (
    pointInWindowBounds(start, toolbarBounds, toolbarPad) ||
    pointInWindowBounds(end, toolbarBounds, toolbarPad) ||
    selectionRectIntersectsBounds(meta, toolbarBounds, toolbarPad)
  );
  const hitMore = moreBounds && (
    pointInWindowBounds(start, moreBounds, morePad) ||
    pointInWindowBounds(end, moreBounds, morePad) ||
    selectionRectIntersectsBounds(meta, moreBounds, morePad)
  );

  if (hitToolbar || hitMore) {
    console.log('[ToolbarDrag] ignored SELECTED from floating toolbar drag', JSON.stringify({
      start,
      end,
      toolbarBounds,
      moreBounds,
      hitToolbar: Boolean(hitToolbar),
      hitMore: Boolean(hitMore),
      foregroundProcessName,
      foregroundWindowTitle,
      overlayState,
    }));
    return true;
  }
  return false;
}



function destroyToolbarWindow(reason = 'unknown') {
  toolbarHideGeneration += 1;
  const generation = toolbarHideGeneration;

  toolbarPointerInside = false;
  toolbarMorePointerInside = false;
  toolbarExpanded = false;
  toolbarInteractionUntil = 0;

  if (!toolbarWindow || toolbarWindow.isDestroyed()) {
    toolbarWindow = null;
    return;
  }

  const bounds = (() => {
    try { return toolbarWindow.getBounds(); } catch (_) { return null; }
  })();

  try { toolbarWindow.webContents.send('toolbar:hide'); } catch (_) {}
  try { toolbarWindow.setIgnoreMouseEvents(true, { forward: true }); } catch (_) {}
  try { toolbarWindow.removeAllListeners('move'); } catch (_) {}
  try { toolbarWindow.removeAllListeners('resize'); } catch (_) {}
  try { toolbarWindow.destroy(); } catch (_) {}
  toolbarWindow = null;

  console.log('[Toolbar] destroyed on hide', {
    reason,
    generation,
    bounds,
  });
}

function destroyToolbarMoreWindow(reason = 'unknown') {
  toolbarExpanded = false;
  toolbarMorePointerInside = false;

  if (toolbarMoreWindow && !toolbarMoreWindow.isDestroyed()) {
    const bounds = (() => {
      try { return toolbarMoreWindow.getBounds(); } catch (_) { return null; }
    })();
    try { toolbarMoreWindow.webContents.send('toolbar-more:state', { open: false }); } catch (_) {}
    try { toolbarMoreWindow.setIgnoreMouseEvents(true, { forward: true }); } catch (_) {}
    try { toolbarMoreWindow.removeAllListeners('move'); } catch (_) {}
    try { toolbarMoreWindow.removeAllListeners('resize'); } catch (_) {}
    try { toolbarMoreWindow.destroy(); } catch (_) {}
    toolbarMoreWindow = null;
    console.log('[ToolbarMore] destroyed on hide', { reason, bounds });
  }
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    try { toolbarWindow.webContents.send('toolbar-more:state', { open: false }); } catch (_) {}
  }
}

function disableToolbarWindowsForMain(reason = 'main-active') {
  // When the main settings window is active, floating toolbar windows must not
  // remain as invisible mouse blockers above it.
  destroyToolbarMoreWindow(reason);
  destroyToolbarWindow(reason);
}

function explicitCloseResultCard(reason) {
  const allowed = new Set(['close-button', 'escape', 'explicit-user-action', 'outside-click']);
  if (!allowed.has(reason)) return { ok: false };
  if (resultWindow && !resultWindow.isDestroyed()) {
    resultWindow.webContents.send('result:reset');
    resultWindow.hide();
  }
  resultPointerInside = false;
  resultInteractionUntil = 0;
  pendingResultTargetHeight = null;
  overlayState = 'idle';
  // Cancel current run so stale streaming updates don't reach renderer
  if (currentAbortController) {
    try { currentAbortController.abort(); } catch (_) {}
    currentAbortController = null;
  }
  currentRunId = null;
  return { ok: true };
}

function hideToolbarViaCss() {
  clearTimeout(toolbarHideTimer);
  destroyToolbarMoreWindow('hide-toolbar');
  destroyToolbarWindow('hide-toolbar');
}

async function showToolbarMore() {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return { ok: false, open: false };
  await ensureToolbarMoreWindowReady();
  if (!toolbarMoreWindow || toolbarMoreWindow.isDestroyed()) return { ok: false, open: false };
  // A stable menu size avoids visual jumping as skills are added. The list
  // itself scrolls, with its scrollbar intentionally hidden in the renderer.
  toolbarMoreWindow.setSize(TOOLBAR_MORE_FIXED_WIDTH, TOOLBAR_MORE_FIXED_HEIGHT, false);
  toolbarExpanded = true;
  toolbarMorePointerInside = false;
  placeToolbarMoreNearToolbar();
  toolbarMoreWindow.setIgnoreMouseEvents(false);
  boostFloatingWindowForFullscreen(toolbarMoreWindow, 'toolbar-more:before-show');
  toolbarMoreWindow.webContents.send('toolbar-more:state', { open: true });
  toolbarWindow.webContents.send('toolbar-more:state', { open: true });
  toolbarMoreWindow.showInactive();
  boostFloatingWindowForFullscreen(toolbarMoreWindow, 'toolbar-more:after-show');
  setTimeout(() => boostFloatingWindowForFullscreen(toolbarMoreWindow, 'toolbar-more:after-show-delay'), 80);
  scheduleToolbarHide();
  return { ok: true, open: true };
}

function hideToolbarMore() {
  destroyToolbarMoreWindow('hide-toolbar-more');
  return { ok: true, open: false };
}

async function toggleToolbarMore() {
  if (toolbarMoreWindow && !toolbarMoreWindow.isDestroyed() && toolbarMoreWindow.isVisible()) {
    return hideToolbarMore();
  }
  return showToolbarMore();
}

function scheduleToolbarHide() {
  // Timer removed: toolbar stays visible until explicitly hidden
  clearTimeout(toolbarHideTimer);
}

function shouldSuppressSkillStartClick(clickX, clickY) {
  if (!suppressNextOutsideClick || suppressNextOutsideClick.consumed || suppressNextOutsideClick.runId !== currentRunId) return false;
  var age = Date.now() - suppressNextOutsideClick.createdAt;
  var samePos = Math.abs(clickX - suppressNextOutsideClick.x) <= 4 && Math.abs(clickY - suppressNextOutsideClick.y) <= 4;
  if (age <= 120 && samePos) {
    suppressNextOutsideClick.consumed = true;
    suppressNextOutsideClick = null;
    console.log('[Click] suppress same skill-start click');
    return true;
  }
  suppressNextOutsideClick = null;
  return false;
}

function handleGlobalClick(line) {
  const [, xRaw, yRaw] = line.split('|');
  const point = normalizeHookPoint(xRaw, yRaw);
  const x = point.x;
  const y = point.y;
  lastGlobalClick = { x, y, at: Date.now() };
  const toolbarVisible = toolbarWindow && !toolbarWindow.isDestroyed() && toolbarWindow.isVisible();
  const resultVisible = resultWindow && !resultWindow.isDestroyed() && resultWindow.isVisible();
  if (!toolbarVisible && !resultVisible) return;

  const toolbarBounds = toolbarVisible ? toolbarWindow.getBounds() : null;
  const toolbarPad = toolbarExpanded ? 10 : 6;
  const visualTop = toolbarBounds ? toolbarBounds.y + TOOLBAR_TOOLTIP_TOP_SPACE : 0;
  const visualHeight = toolbarVisible ? (toolbarWindow._visualHeight || TOOLBAR_VISUAL_HEIGHT) : 0;
  const insideToolbar = toolbarBounds
    ? x >= toolbarBounds.x - toolbarPad && x <= toolbarBounds.x + toolbarBounds.width + toolbarPad && y >= visualTop - toolbarPad && y <= visualTop + visualHeight + toolbarPad
    : false;
  const moreBounds = toolbarMoreWindow && !toolbarMoreWindow.isDestroyed() && toolbarMoreWindow.isVisible()
    ? toolbarMoreWindow.getBounds()
    : null;
  const insideMore = moreBounds
    ? x >= moreBounds.x - 6 && x <= moreBounds.x + moreBounds.width + 6 && y >= moreBounds.y - 6 && y <= moreBounds.y + moreBounds.height + 6
    : false;

  const resultBounds = resultVisible ? resultWindow.getBounds() : null;
  const insideResult = resultBounds
    ? x >= resultBounds.x && x <= resultBounds.x + resultBounds.width && y >= resultBounds.y && y <= resultBounds.y + resultBounds.height
    : false;

  const insideToolbarGroup = insideToolbar || insideMore;

  if (toolbarVisible && insideToolbarGroup) {
    scheduleToolbarHide();
  } else if (toolbarVisible) {
    toolbarPointerInside = false;
    toolbarMorePointerInside = false;
    toolbarExpanded = false;
    toolbarInteractionUntil = 0;
    console.log('toolbar hide by outside click', {
      x,
      y,
      toolbarBounds,
      moreBounds,
      insideToolbar,
      insideMore,
      toolbarPointerInside,
      toolbarMorePointerInside,
      overlayState,
    });
    hideToolbarViaCss();
  }

  if (
    resultVisible &&
    !insideResult &&
    !insideToolbar &&
    !insideMore
    ) {
    if (shouldSuppressSkillStartClick(x, y)) {}
    else { console.log('[Click] outside result close immediately'); explicitCloseResultCard('outside-click'); }
  }
  console.log('[Toolbar] outside click processed overlayState=' + overlayState);
}

function getToolbarSkills() {
  return readStore().skills
    .filter((skill) => skill.enabled && skill.showInToolbar)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .slice(0, 5);
}

function enforceToolbarSkillLimit(skills) {
  return skills;
}

function normalizeSkillOrder(skills, orderedIds) {
  const existingIds = new Set(skills.map(s => s.id));
  const seen = new Set();
  const validOrderedIds = Array.isArray(orderedIds)
    ? orderedIds.filter(id => {
        if (!existingIds.has(id)) return false;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
    : [];
  const orderedIdSet = new Set(validOrderedIds);
  const orderedSkills = validOrderedIds
    .map(id => skills.find(s => s.id === id))
    .filter(Boolean);
  const remainingSkills = skills
    .filter(s => !orderedIdSet.has(s.id))
    .sort((a, b) => (a.sortOrder || 9999) - (b.sortOrder || 9999));
  return [...orderedSkills, ...remainingSkills].map((skill, index) => ({
    ...skill,
    sortOrder: index * 10,
  }));
}

function broadcastSkillsUpdated() {
  const store = readStore();
  const payload = {
    toolbarSkills: getToolbarSkills(),
    allSkills: store.skills,
  };
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.webContents.send('skills:updated', payload);
  }
  if (toolbarMoreWindow && !toolbarMoreWindow.isDestroyed()) {
    toolbarMoreWindow.webContents.send('skills:updated', payload);
  }
  return payload;
}

function renderTemplate(template, context) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => context[key] ?? '');
}

function renderSkillPrompt(template, context) {
  const raw = String(template || '').trim();
  const fallback = '请处理下面划选的内容。';
  const base = raw || fallback;
  const hasSelection =
    /\{\{\s*selection\s*\}\}/.test(base) ||
    /\{\s*selection\s*\}/.test(base);

  const rendered = base
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => context[key] ?? '')
    .replace(/\{\s*(selection|date|time|source_app|sourceApp|window_title|windowTitle)\s*\}/g, (_, key) => context[key] ?? '');

  if (hasSelection) return rendered;

  return `${rendered}

用户划选的文本：
${context.selection}

请严格基于上面的划选文本完成任务；如果任务是翻译、解释、总结或改写，不要脱离原文发挥。`;
}

// ─── Unified LLM Client ──────────────────────────────

function buildMessages(skill, selection) {
  const context = {
    selection,
    date: new Date().toLocaleDateString('zh-CN'),
    time: new Date().toLocaleTimeString('zh-CN'),
    sourceApp: 'Windows',
    windowTitle: '当前应用',
  };
  const userContent = renderSkillPrompt(skill.userPrompt, context);
  const systemContent = `${skill.systemPrompt || '你是 AI 划词助手，请用中文回答。'}

重要规则：用户的任务指令可能没有显式包含划词文本，但消息中会提供"用户划选的文本"。你必须基于划选文本回答。`;
  return { systemContent, userContent };
}

async function dispatchByApiType(apiType, opts) { console.log('[FLOW] dispatchByApiType opts.runId=' + (opts ? opts.runId : 'NO_OPTS') + ' hasRunId=' + (opts ? ('runId' in opts) : 'N/A'));
  const { url, apiKey, model, authHeader, authPrefix, extraHeaders, systemContent, userContent, stream, temperature, maxTokens, timeoutMs, onDelta, signal } = opts;
  const headers = { 'Content-Type': 'application/json' };
  if (authHeader && apiKey) {
    headers[authHeader] = authPrefix ? `${authPrefix} ${apiKey}` : apiKey;
  }
  if (extraHeaders) Object.assign(headers, extraHeaders);

  let body;
  switch (apiType) {
    case 'openai-compatible-chat':
      body = { model, messages: [{ role: 'system', content: systemContent }, { role: 'user', content: userContent }], temperature, max_tokens: maxTokens, stream };
      break;
    case 'openai-responses':
      body = { model, input: userContent, instructions: systemContent, max_output_tokens: maxTokens, temperature };
      break;
    case 'anthropic-messages':
      body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: userContent }] };
      if (systemContent) body.system = systemContent;
      if (stream) body.stream = true;
      break;
    case 'gemini-generate-content':
      body = { contents: [{ parts: [{ text: systemContent + '\n\n' + userContent }] }], generationConfig: { temperature, maxOutputTokens: maxTokens } };
      break;
    default:
      body = { model, messages: [{ role: 'system', content: systemContent }, { role: 'user', content: userContent }], temperature, max_tokens: maxTokens, stream };
  }

  const controller = new AbortController();
  const onExternalAbort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort();
  }, timeoutMs || 60000);
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
    }

    // Parse response
    if (apiType === 'openai-compatible-chat' || apiType === 'openai-responses') {
      if (stream && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', answer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const d = JSON.parse(payload);
              const delta = d?.choices?.[0]?.delta?.content || d?.choices?.[0]?.message?.content || '';
              if (delta && onDelta) { answer += delta; onDelta(delta, answer); }
            } catch { /* skip */ }
          }
        }
        return { answer, prompt: userContent };
      } else {
        const data = await response.json();
        const answer = data?.choices?.[0]?.message?.content || data?.output_text || data?.output?.[0]?.content?.[0]?.text || '';
        if (onDelta) onDelta(answer, answer);
        return { answer, prompt: userContent };
      }
    }

    if (apiType === 'anthropic-messages') {
      const data = await response.json();
      const answer = data?.content?.[0]?.text || '';
      if (onDelta) onDelta(answer, answer);
      return { answer, prompt: userContent };
    }

    if (apiType === 'gemini-generate-content') {
      const data = await response.json();
      const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (onDelta) onDelta(answer, answer);
      return { answer, prompt: userContent };
    }

    const data = await response.json();
    const answer = data?.choices?.[0]?.message?.content || '';
    if (onDelta) onDelta(answer, answer);
    return { answer, prompt: userContent };
  } finally {
    clearTimeout(timer);
    if (signal) {
      signal.removeEventListener?.('abort', onExternalAbort);
    }
  }
}

async function callLLM(skill, selection, onDelta, signal, runId) { console.log('[FLOW] callLLM received runId=' + runId);
  const provider = getActiveProviderConfig();
  const userConfig = readProviderConfig();

  // skillModelMap override
  const smap = userConfig.skillModelMap?.[skill.id] || {};
  const apiKey = smap.providerId
    ? decryptApiKey((userConfig.providers[smap.providerId] || {}).apiKey || '')
    : provider.apiKey;

  if (!apiKey) throw new Error(`Provider "${provider.name}" 未配置 API Key`);

  const model = smap.modelId || skill.model || provider.model;
  const { systemContent, userContent } = buildMessages(skill, selection);
  const url = getApiUrl(provider.apiType, provider.baseUrl, model);

  const result = await dispatchByApiType(provider.apiType, {
    url, apiKey, model,
    authHeader: provider.authHeader,
    authPrefix: provider.authPrefix,
    extraHeaders: provider.extraHeaders,
    systemContent, userContent,
    stream: provider.stream,
    temperature: provider.temperature,
    maxTokens: provider.maxTokens,
    timeoutMs: provider.timeoutMs,
    onDelta,
    signal,
  });

  return { ...result, providerId: provider.id, model };
}

// backward compat aliases
async function callModel(skill, selection) {
  return callLLM(skill, selection, undefined);
}

async function callModelStreaming(skill, selection, onDelta, signal, runId) { console.log('[FLOW] callModelStreaming received runId=' + runId);
  const wrapped = (delta, fullText) => {
    if (signal?.aborted) return;
    onDelta(delta, fullText, runId);
  };
  return callLLM(skill, selection, wrapped, signal, runId);
}

function saveRecord(record) {
  return updateStore((store) => {
    store.history = [record, ...store.history].slice(0, 500);
    return store;
  });
}

function broadcastHistory(history) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:changed', history);
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function templateContext(record) {
  const date = new Date(record.createdAt);
  const dateText = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const timeText = `${pad2(date.getHours())}-${pad2(date.getMinutes())}`;
  const action = record.skillName || record.skillId || 'AI划词';
  const selection = record.selectedText || '';
  return {
    date: dateText,
    time: timeText,
    action,
    skillName: action,
    skillId: record.skillId || '',
    model: record.model || '',
    selection,
    selection_short: selection.replace(/\s+/g, ' ').slice(0, 20),
    ai_result: record.answerMarkdown || '',
    answer: record.answerMarkdown || '',
    source_app: record.sourceApp || 'Windows',
    sourceApp: record.sourceApp || 'Windows',
    windowTitle: record.windowTitle || '当前应用',
    ai_title: `${action}：${selection.slice(0, 24) || 'AI 划词记录'}`,
    tags: `AI划词, ${action}`,
    lang: '',
  };
}

function resolveInsideVault(vaultPath, relativePath) {
  const vaultRoot = path.resolve(vaultPath);
  const target = path.resolve(vaultRoot, relativePath);
  const relative = path.relative(vaultRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('保存路径必须在 Obsidian Vault 内。');
  }
  return target;
}

/* ───── Obsidian 模板系统 ───── */

function obsidianRenderContext(record) {
  const date = new Date(record.createdAt);
  const dateText = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const timeText = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return {
    selection: record.selectedText || '',
    ai_result: record.answerMarkdown || '',
    skill_name: record.skillName || record.skillId || 'AI划词',
    model: record.model || '',
    date: dateText,
    time: timeText,
    source_app: record.sourceApp || 'Windows',
    history_space: '',
  };
}

function renderObsidianTemplate(template, record) {
  const ctx = obsidianRenderContext(record);
  return renderTemplate(template.contentTemplate, ctx);
}

function findObsidianTemplate(store, templateId) {
  const tmpl = (store.obsidianTemplates || []).find((t) => t.id === templateId);
  if (!tmpl) throw new Error('没有找到这个模板。');
  return tmpl;
}

function saveToObsidianNote(templateId, recordInput) {
  const store = readStore();
  let record;
  if (typeof recordInput === 'object' && recordInput !== null) {
    record = recordInput;
  } else {
    record = store.history.find((item) => item.id === recordInput);
    if (!record) throw new Error('没有找到这条历史记录。');
  }

  const template = findObsidianTemplate(store, templateId);
  // Prevent duplicate saves - check if already marked as saved
  if (record.savedToObsidian) {
    throw new Error('该记录已保存到 Obsidian，无需重复保存。');
  }
  const vaultPath = (store.settings.obsidian.vaultPath || '').trim();
  if (!vaultPath) throw new Error('还没有设置 Obsidian vault 路径。');

  const target = resolveInsideVault(vaultPath, template.targetNotePath);
  if (!target.endsWith('.md')) throw new Error('目标笔记必须是 .md 文件。');
  if (!fs.existsSync(target)) throw new Error(`目标笔记不存在：${template.targetNotePath}`);

  const markdown = renderObsidianTemplate(template, record);
  const separator = '\n\n';

  if (template.saveBehavior === 'append_to_existing_note_top') {
    const existing = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, `${markdown}${separator}${existing}`, 'utf8');
  } else {
    fs.appendFileSync(target, `${separator}${markdown}`, 'utf8');
  }

  updateStore((next) => {
    next.history = next.history.map((item) =>
      item.id === record.id ? { ...item, savedToObsidian: true, obsidianPath: target } : item
    );
    return next;
  });

  return { ok: true, path: target, templateName: template.name };
}

function renderObsidianPreview(template, record) {
  const ctx = obsidianRenderContext(record);
  const markdown = renderTemplate(template.contentTemplate, ctx);
  return {
    markdown,
    relativePath: template.targetNotePath,
    behavior: template.saveBehavior,
    templateName: template.name,
  };
}

function listVaultMarkdownFiles(vaultPath) {
  const root = path.resolve(vaultPath);
  if (!fs.existsSync(root)) return [];
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(full);
      } else if (entry.name.endsWith('.md')) {
        results.push(path.relative(root, full).replace(/\\\\/g, '/'));
      }
    }
  }
  walk(root);
  return results.sort();
}

function emitTtsState(payload) {
  for (const win of [mainWindow, resultWindow, toolbarWindow, toolbarMoreWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('tts:state', payload);
    }
  }
}

function speak(text, options = {}) {
  const key = typeof options === 'object' && options ? String(options.key || '') : '';
  const token = ++speakToken;

  if (speakProcess) {
    try { speakProcess.kill(); } catch {}
    speakProcess = null;
  }

  const safe = String(text || '').replace(/'/g, "''");
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.Speak('${safe}')`;
  const child = execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
  speakProcess = child;
  currentTtsKey = key;
  emitTtsState({ speaking: true, key, reason: 'start' });

  child.once('close', () => {
    if (speakToken !== token || speakProcess !== child) return;
    speakProcess = null;
    const endedKey = currentTtsKey;
    currentTtsKey = '';
    emitTtsState({ speaking: false, key: endedKey, reason: 'ended' });
  });

  child.once('error', (error) => {
    if (speakToken !== token || speakProcess !== child) return;
    speakProcess = null;
    const endedKey = currentTtsKey;
    currentTtsKey = '';
    emitTtsState({ speaking: false, key: endedKey, reason: 'error', error: String(error && error.message ? error.message : error) });
  });
}

function stopSpeak(reason = 'stop') {
  const stoppedKey = currentTtsKey;
  speakToken += 1;
  if (speakProcess) {
    try { speakProcess.kill(); } catch {}
    speakProcess = null;
  }
  currentTtsKey = '';
  emitTtsState({ speaking: false, key: stoppedKey, reason });
}

/* ───── 对话管理 ───── */

ipcMain.handle('conversations:list', () => {
  const store = readStore();
  return { conversations: store.conversations || [], activeId: store.activeConversationId };
});
ipcMain.handle('conversations:create', (_event, title) => {
  return updateStore((store) => {
    const conv = {
      id: `conv_${Date.now()}`,
      title: (title || '新对话').trim().slice(0, 50),
      pinned: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    store.conversations = [...(store.conversations || []), conv];
    store.activeConversationId = conv.id;
    return store;
  });
});
ipcMain.handle('conversations:rename', (_event, { id, title }) => {
  return updateStore((store) => {
    store.conversations = (store.conversations || []).map((c) => c.id === id ? { ...c, title: title.trim().slice(0, 50), updatedAt: new Date().toISOString() } : c);
    return store;
  });
});
ipcMain.handle('conversations:delete', (_event, { id, deleteRecords }) => {
  return updateStore((store) => {
    store.conversations = (store.conversations || []).filter((c) => c.id !== id);
    if (store.activeConversationId === id) {
      store.activeConversationId = (store.conversations || [])[0]?.id || null;
    }
    if (deleteRecords) {
      store.history = (store.history || []).filter((r) => r.conversationId !== id);
    }
    return store;
  });
});
ipcMain.handle('conversations:pin', (_event, id) => {
  return updateStore((store) => {
    const now = new Date().toISOString();
    store.conversations = (store.conversations || []).map((c) => c.id === id
      ? { ...c, pinned: !c.pinned, pinnedAt: !c.pinned ? now : null, updatedAt: now }
      : c);
    return store;
  });
});
ipcMain.handle('conversations:set-active', (_event, id) => {
  return updateStore((store) => {
    store.activeConversationId = id;
    return store;
  });
});

ipcMain.handle('app:get-initial-data', () => ({
  ...readStore(),
  dataDir: dataDir(),
  toolbarSkills: getToolbarSkills(),
}));

// ─── Hotkey config IPC ───
ipcMain.handle('hotkey:get-config', () => readHotkeyConfig());

ipcMain.handle('hotkey:save-config', (_event, config) => {
  writeHotkeyConfig(config);
  applyHotkeyConfig(config);
  return { ok: true };
});

// ─── Provider config + test connection IPC ───

ipcMain.handle('provider:get-config', () => {
  const cfg = readProviderConfig();
  // Never send raw apiKey to renderer
  const safe = { configVersion: cfg.configVersion, activeProvider: cfg.activeProvider, skillModelMap: cfg.skillModelMap, providers: {} };
  for (const [id, p] of Object.entries(cfg.providers)) {
    safe.providers[id] = { ...p, apiKey: p.apiKey ? '***' : '' };
  }
  return safe;
});

ipcMain.handle('provider:save-config', (_event, updates) => {
  const cfg = readProviderConfig();
  if (updates.activeProvider !== undefined) cfg.activeProvider = updates.activeProvider;
  if (updates.providers) {
    for (const [id, p] of Object.entries(updates.providers)) {
      if (!cfg.providers[id]) cfg.providers[id] = {};
      const existing = cfg.providers[id];
      if (p.enabled !== undefined) existing.enabled = p.enabled;
      if (p.apiKey !== undefined && p.apiKey !== '***') existing.apiKey = encryptApiKey(p.apiKey);
      if (p.baseUrl !== undefined) existing.baseUrl = p.baseUrl;
      if (p.model !== undefined) existing.model = p.model;
      if (p.customModels !== undefined) existing.customModels = p.customModels;
      if (p.stream !== undefined) existing.stream = p.stream;
      if (p.temperature !== undefined) existing.temperature = p.temperature;
      if (p.maxTokens !== undefined) existing.maxTokens = p.maxTokens;
      if (p.timeoutMs !== undefined) existing.timeoutMs = p.timeoutMs;
    }
  }
  writeProviderConfig(cfg);
  return { ok: true };
});

ipcMain.handle('provider:get-presets', () => {
  const presets = {};
  for (const [id, p] of Object.entries(PROVIDER_PRESETS)) {
    presets[id] = { name: p.name, apiType: p.apiType, baseUrl: p.baseUrl, models: p.models, defaultModel: p.defaultModel, modelLabel: p.modelLabel || '', hint: p.hint || '' };
  }
  return presets;
});

ipcMain.handle('provider:test-connection', async (_event, { providerId }) => {
  const cfg = readProviderConfig();
  const pcfg = cfg.providers[providerId] || {};
  const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.custom;
  const apiKey = decryptApiKey(pcfg.apiKey || '');
  if (!apiKey) return { ok: false, error: '请先填写 API Key' };

  const model = pcfg.model || preset.defaultModel;
  const baseUrl = pcfg.baseUrl || preset.baseUrl;
  const apiType = preset.apiType;
  const TIMEOUT = 12000;

  let url, body;
  const headers = buildAuthHeaders({ authHeader: preset.authHeader, authPrefix: preset.authPrefix, extraHeaders: preset.extraHeaders }, apiKey);

  switch (apiType) {
    case 'openai-compatible-chat':
      url = joinUrl(baseUrl, 'chat/completions');
      body = { model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5, stream: false };
      break;
    case 'openai-responses':
      url = joinUrl(baseUrl, 'responses');
      body = { model, input: 'Hi', max_output_tokens: 5 };
      break;
    case 'anthropic-messages':
      url = joinUrl(baseUrl, 'v1/messages');
      body = { model, max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] };
      break;
    case 'gemini-generate-content':
      url = joinUrl(baseUrl, 'v1beta/models', model, 'generateContent');
      body = { contents: [{ parts: [{ text: 'Hi' }] }] };
      break;
    default:
      url = joinUrl(baseUrl, 'chat/completions');
      body = { model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5, stream: false };
  }

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
    if (res.ok) return { ok: true };
    const errText = await res.text().catch(() => '');
    return { ok: false, error: classifyTestError(res.status, errText) };
  } catch (e) {
    return { ok: false, error: classifyNetworkError(e) };
  }
});

function classifyTestError(status, body) {
  if (status === 401) return 'API Key 无效';
  if (status === 403) return 'API Key 无权限';
  if (status === 404) return body.includes('model') ? '模型不存在' : 'Base URL 错误';
  if (status === 402 || status === 429) return '余额不足或配额超限';
  return `请求失败 (${status})`;
}

function classifyNetworkError(e) {
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return '网络超时';
  return '无法连接服务器，检查 Base URL 和网络';
}

ipcMain.handle('settings:save', (_event, settings) => updateStore((store) => ({ ...store, settings: { ...store.settings, ...settings } })));
ipcMain.handle('skills:save', (_event, skill) => updateStore((store) => {
  const exists = store.skills.some((item) => item.id === skill.id);
  store.skills = exists ? store.skills.map((item) => item.id === skill.id ? skill : item) : [...store.skills, skill];
  store.skills = enforceToolbarSkillLimit(store.skills);
  queueMicrotask(broadcastSkillsUpdated);
  return store;
}));
ipcMain.handle('skills:reorder', (_event, skillIds) => updateStore((store) => {
  store.skills = normalizeSkillOrder(store.skills, skillIds);
  store.skills = enforceToolbarSkillLimit(store.skills);
  queueMicrotask(broadcastSkillsUpdated);
  return store;
}));
ipcMain.handle('skills:delete', (_event, skillId) => updateStore((store) => {
  const skill = store.skills.find((s) => s.id === skillId);
  if (skill && skill.deletable === false) throw new Error('不能删除该技能。');
  store.skills = store.skills.filter((skill) => skill.id !== skillId);
  queueMicrotask(broadcastSkillsUpdated);
  return store;
}));
ipcMain.handle('skill:run', async (_event, { skillId, selection }) => {
  console.log('[SkillRun] received skill:run skillId=' + skillId + ' selectionLen=' + (selection || currentSelection || '').length + ' overlayState=' + overlayState);
  const store = readStore();
  const skill = store.skills.find((item) => item.id === skillId);
  if (!skill) throw new Error('没有找到技能。');
  const selectedText = selection || (currentPickedInfo ? currentPickedInfo.text : currentSelection);
  if (!selectedText) throw new Error('没有可处理的划词文本。');
  // Immediately hide toolbar regardless of outcome
  hideToolbarViaCss();

  // 长文本确认：只有非 browser 来源或低置信度才触发
  // BrowserProvider（浏览器 content script）的 getSelection() 本身是精准的，
  // 即使用户选了 5 个词那也是用户真实想选的，不需要确认。
  const selectedWordCount = selectedText.trim().split(/\s+/).filter(Boolean).length;
  const needsConfirm = false && Boolean(
    currentPickedInfo?.source === 'clipboard' &&
    currentPickedInfo?.metadata?.autoRefinedByMouse &&
    selectedWordCount > 1
  );
  if (needsConfirm) {
    const store = readStore();
    const confirmSelectionText = currentPickedInfo?.metadata?.originalClipboardText || currentPickedInfo?.fullText || selectedText;
    const record = {
      id: `sel-check-${Date.now()}`,
      createdAt: new Date().toISOString(),
      sourceApp: currentPickedInfo?.appName || 'Windows',
      windowTitle: currentPickedInfo?.windowTitle || '当前应用',
      selectedText: confirmSelectionText,
      skillId: skill.id,
      skillName: skill.name,
      providerId: store.settings.api.providerName,
      model: store.settings.api.model,
      prompt: '',
      answerMarkdown: '',
      status: 'confirming',
      savedToObsidian: false,
      obsidianPath: '',
      conversationId: store.activeConversationId || '',
      // Attach pickedInfo metadata for the ResultView
      pickedInfoSource: currentPickedInfo?.source || 'clipboard',
      pickedInfoConfidence: currentPickedInfo?.confidence || 0.5,
    };
    if (!resultWindow) createResultWindow();
    currentResultHeight = RESULT_DEFAULT_HEIGHT;
    resultPositionMode = 'auto';
    resultFloatingSide = null;
    placeResultNearSelection();
    resultWindow.webContents.send('result:confirm-selection', { record, skillId: skill.id });
    boostFloatingWindowForFullscreen(resultWindow, 'result:before-show');
  resultWindow.showInactive();
  boostFloatingWindowForFullscreen(resultWindow, 'result:after-show');
    hideToolbarViaCss();
    return record;
  }

  if (skill.type === 'builtin' && skill.builtinAction === 'pronunciation') {
    return runPronunciationSkill(skill, selectedText);
  }

  if (skill.type === 'builtin' && skill.builtinAction === 'copy') {
    clipboard.writeText(selectedText);
    return { ok: true };
  }

  if (skill.outputMode === 'copy') {
    clipboard.writeText(selectedText);
    return { copied: true };
  }

  return runSkillInternal(skill, selectedText, store);
});

async function runSkillInternal(skill, selectedText, store) {
  console.log('[SkillRun] runSkillInternal start skillId=' + skill.id + ' textLen=' + selectedText.length);
  const createdAt = new Date().toISOString();
  let record = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt,
    sourceApp: currentPickedInfo?.appName || 'Windows',
    windowTitle: currentPickedInfo?.windowTitle || '当前应用',
    selectedText,
    skillId: skill.id,
    skillName: skill.name,
    providerId: store.settings.api.providerName,
    model: store.settings.api.model,
    prompt: '',
    answerMarkdown: '',
    status: 'running',
    savedToObsidian: false,
    obsidianPath: '',
    conversationId: store.activeConversationId || '',
    // Selection metadata
    selectionSource: currentPickedInfo?.source || 'clipboard',
    selectionConfidence: currentPickedInfo?.confidence || 0,
    selectionLatency: currentPickedInfo?.latency || 0,
    selectionAppName: currentPickedInfo?.appName || '',
    selectionWindowTitle: currentPickedInfo?.windowTitle || '',
  };
  if (!resultWindow) createResultWindow();
  currentResultHeight = RESULT_DEFAULT_HEIGHT;
  resultPositionMode = 'auto';
  resultFloatingSide = null;

  // Cancel previous run before starting new one
  if (currentAbortController) {
    try { currentAbortController.abort(); } catch (_) {}
  }
  const thisRunId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  currentRunId = thisRunId;
  currentAbortController = new AbortController();

  if (lastGlobalClick) { suppressNextOutsideClick = { runId: currentRunId, x: lastGlobalClick.x, y: lastGlobalClick.y, createdAt: Date.now(), consumed: false }; }
  console.log('[SkillRun] start runId=' + currentRunId + ' skillId=' + skill.id);

  overlayState = 'ai_generating';
    hideToolbarViaCss();
  console.log('[Toolbar] hidden reason=skill-run');
  placeResultNearSelection();
  resultWindow.webContents.send('result:ready', { ...record, runId: currentRunId });
  console.log('[Result] show loading runId=' + currentRunId);
  boostFloatingWindowForFullscreen(resultWindow, 'result:before-show');
  resultWindow.showInactive();
  boostFloatingWindowForFullscreen(resultWindow, 'result:after-show');

  try {
    const result = await callModelStreaming(skill, selectedText, (_delta, fullText, callbackRunId) => {
      if (_delta && fullText === _delta) {
        console.log('[LLM] first delta runId=' + currentRunId);
      }
      const nextText = fullText || `${record.answerMarkdown}${_delta || ''}`;
      record = { ...record, answerMarkdown: nextText };
      if (resultWindow && !resultWindow.isDestroyed()) {
        resultWindow.webContents.send('result:update', { ...record, runId: callbackRunId });
      }
    }, currentAbortController.signal, currentRunId);
    record = { ...record, providerId: result.providerId, model: result.model, prompt: result.prompt, answerMarkdown: result.answer, status: 'completed' };
    overlayState = 'result_visible';
  } catch (error) {
    const isAborted = error && (error.name === 'AbortError' || error?.code === 20 || error?.type === 'aborted');
    if (isAborted) {
      console.log('[LLM] aborted by external signal runId=' + currentRunId);
      return record;
    }
    record = { ...record, answerMarkdown: error instanceof Error ? error.message : String(error), status: 'failed' };
    console.log('[LLM] error runId=' + currentRunId + ' message=' + (error instanceof Error ? error.message : String(error)));
    overlayState = 'result_visible';
  }
  saveRecord(record);
  if (resultWindow && !resultWindow.isDestroyed()) {
    resultWindow.webContents.send('result:update', { ...record, runId: currentRunId });
  }
  return record;
}

ipcMain.handle('result:confirm-selection-action', async (_event, { skillId, selectedText }) => {
  if (!resultWindow || resultWindow.isDestroyed()) return null;
  const store = readStore();
  const skill = store.skills.find((s) => s.id === skillId);
  if (!skill) throw new Error('没有找到技能。');
  currentSelection = selectedText;
  currentAnchorRect = null;
  currentPickedInfo = {
    text: selectedText,
    source: 'manual',
    confidence: 0.8,
  };
  const record = await runSkillInternal(skill, selectedText, store);
  return record;
});
ipcMain.handle('result:cancel-selection', () => {
  if (resultWindow && !resultWindow.isDestroyed()) resultWindow.hide();
  return { ok: true };
});

ipcMain.handle('clipboard:write', (_event, payload) => {
  const text = payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'text')
    ? payload.text
    : payload;
  const silent = Boolean(payload && typeof payload === 'object' && payload.options && payload.options.silent);
  clipboard.writeText(String(text || ''));
  return { ok: true, silent };
});
ipcMain.handle('obsidian:templates:list', () => {
  return readStore().obsidianTemplates || [];
});
ipcMain.handle('obsidian:templates:save', (_event, template) => {
  return updateStore((store) => {
    const exists = (store.obsidianTemplates || []).some((t) => t.id === template.id);
    const now = new Date().toISOString();
    const updated = { ...template, updatedAt: now, createdAt: exists ? (store.obsidianTemplates.find((t) => t.id === template.id)?.createdAt || now) : now };
    store.obsidianTemplates = exists
      ? store.obsidianTemplates.map((t) => t.id === template.id ? updated : t)
      : [...(store.obsidianTemplates || []), updated];
    return store;
  }).obsidianTemplates;
});
ipcMain.handle('obsidian:templates:delete', (_event, templateId) => {
  return updateStore((store) => {
    store.obsidianTemplates = (store.obsidianTemplates || []).filter((t) => t.id !== templateId);
    return store;
  }).obsidianTemplates;
});
ipcMain.handle('obsidian:template:preview', (_event, payload) => {
  const store = readStore();
  const record = payload.record || store.history.find((item) => item.id === payload.recordId);
  if (!record) throw new Error('没有找到这条历史记录。');
  const template = findObsidianTemplate(store, payload.templateId);
  return renderObsidianPreview(template, record);
});
ipcMain.handle('obsidian:note:save', (_event, payload) => {
  if (payload.record) {
    return saveToObsidianNote(payload.templateId, payload.record);
  }
  return saveToObsidianNote(payload.templateId, payload.recordId);
});
ipcMain.handle('obsidian:vault:list-notes', () => {
  const vaultPath = (readStore().settings.obsidian.vaultPath || '').trim();
  if (!vaultPath) return [];
  return listVaultMarkdownFiles(vaultPath);
});
ipcMain.handle('obsidian:vault:check-path', (_event, relativePath) => {
  const vaultPath = (readStore().settings.obsidian.vaultPath || '').trim();
  if (!vaultPath) return { exists: false };
  try {
    const target = resolveInsideVault(vaultPath, relativePath);
    return { exists: fs.existsSync(target) && target.endsWith('.md') };
  } catch {
    return { exists: false };
  }
});
ipcMain.handle('history:delete', (_event, recordIds) => {
  const ids = new Set(Array.isArray(recordIds) ? recordIds : [recordIds]);
  return updateStore((store) => {
    store.history = store.history.filter((item) => !ids.has(item.id));
    return store;
  });
});
ipcMain.handle('history:clear', () => updateStore((store) => {
  store.history = [];
  return store;
}));
ipcMain.handle('tts:speak', (_event, text, options) => {
  speak(text, options);
  return { ok: true, speaking: true };
});
ipcMain.handle('tts:stop', () => {
  stopSpeak('manual');
  return { ok: true, speaking: false };
});
ipcMain.handle('window:show-main', () => {
  showMain();
  return { ok: true };
});
ipcMain.handle('window:close-current', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && resultWindow && win.id === resultWindow.id) return explicitCloseResultCard('close-button');
  if (win && toolbarWindow && win.id === toolbarWindow.id) {
    hideToolbarViaCss();
    return { ok: true };
  }
  if (win && toolbarMoreWindow && win.id === toolbarMoreWindow.id) {
    hideToolbarMore();
    return { ok: true };
  }
  if (win) win.hide();
  return { ok: true };
});
ipcMain.handle('result:close', (_event, reason = 'explicit-user-action') => explicitCloseResultCard(reason));
ipcMain.handle('toolbar:hide', () => {
  toolbarPointerInside = false;
  toolbarMorePointerInside = false;
  toolbarExpanded = false;
  hideToolbarViaCss();
  return { ok: true };
});
ipcMain.handle('toolbar:pointer-inside', (_event, inside) => {
  toolbarPointerInside = Boolean(inside);
  if (toolbarPointerInside) scheduleToolbarHide();
  return { ok: true };
});
async function resizeToolbar(expanded) {
  if (expanded) return showToolbarMore();
  return hideToolbarMore();
}
ipcMain.handle('toolbar:resize', async (_event, expanded) => {
  await resizeToolbar(Boolean(expanded));
  return { ok: true };
});
ipcMain.handle('toolbar-more:toggle', async (_event, anchor) => { console.log('[main toggle] anchor received:', JSON.stringify(anchor)); toolbarMoreAnchor = anchor || null; return toggleToolbarMore(); });
ipcMain.handle('toolbar-more:hide', () => hideToolbarMore());
ipcMain.handle('toolbar-more:pointer-inside', (_event, inside) => {
  toolbarMorePointerInside = Boolean(inside);
  if (toolbarMorePointerInside) scheduleToolbarHide();
  return { ok: true };
});
ipcMain.handle('toolbar:get-bounds', () => {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return null;
  return toolbarWindow.getBounds();
});
ipcMain.handle('toolbar:set-size', (_event, size) => {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return { ok: false };
  const contentWidth = Math.ceil(Number(size?.width) || toolbarFixedWidth);
  const bounds = toolbarWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  const maxWidth = Math.min(TOOLBAR_MAX_WIDTH, Math.max(TOOLBAR_MIN_WIDTH, display.workArea.width - 16));
  const nextWidth = clamp(contentWidth, TOOLBAR_MIN_WIDTH, maxWidth);
  const nextHeight = TOOLBAR_FIXED_HEIGHT;
  toolbarFixedWidth = nextWidth;
  console.log('toolbar measured size', { contentWidth, width: nextWidth, height: nextHeight, maxWidth });
  if (toolbarPositionMode === 'auto' && currentAnchorRect) {
    placeToolbarNearSelection();
  } else {
    setToolbarWindowBounds({ x: bounds.x, y: bounds.y, width: nextWidth, height: nextHeight }, false);
  }
  return { ok: true, width: nextWidth, height: nextHeight };
});
ipcMain.handle('toolbar:set-position', (_event, pos) => {
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return { ok: false };
  // null → reset to auto mode
  if (pos === null || pos === undefined) {
    toolbarPositionMode = 'auto';
    return { ok: true };
  }

  // Manual position is based on the VISIBLE toolbar top-left.
  // The real BrowserWindow is taller because of the transparent tooltip area above the toolbar.
  // If we clamp/move the real window directly, the visible capsule will jump away from the cursor.
  toolbarPositionMode = 'manual';
  const visualX = Number(pos.x);
  const visualY = Number(pos.y);
  toolbarManualPosition = { x: visualX, y: visualY };

  const display = screen.getDisplayNearestPoint({
    x: visualX + toolbarFixedWidth / 2,
    y: visualY + TOOLBAR_VISUAL_HEIGHT / 2,
  });
  const visual = clampWindowToWorkArea(
    visualX,
    visualY,
    toolbarFixedWidth,
    TOOLBAR_VISUAL_HEIGHT,
    display.workArea,
    8
  );
  toolbarManualPosition = { x: visual.x, y: visual.y };
  setToolbarWindowBounds({
    x: visual.x,
    y: visual.y - TOOLBAR_TOOLTIP_TOP_SPACE,
    width: toolbarFixedWidth,
    height: TOOLBAR_FIXED_HEIGHT,
  }, false);
  return { ok: true };
});
ipcMain.handle('result:pointer-inside', (_event, inside) => {
  resultPointerInside = Boolean(inside);
  if (resultPointerInside) resultInteractionUntil = Date.now() + 350;
  return { ok: true };
});
ipcMain.handle('result:interaction', (_event, duration = 650) => {
  resultPointerInside = true;
  resultInteractionUntil = Date.now() + Math.max(250, Math.min(Number(duration) || 650, 3000));
  return { ok: true };
});
ipcMain.handle('result:set-state', (_event, state) => {
  if (['idle', 'toolbar_visible', 'ai_generating', 'result_visible', 'dragging_result', 'resizing_result'].includes(state)) {
    overlayState = state;
  }
  return { ok: true, state: overlayState };
});
ipcMain.handle('result:get-bounds', () => {
  if (!resultWindow || resultWindow.isDestroyed()) return null;
  return resultWindow.getBounds();
});
ipcMain.handle('result:set-position', (_event, pos) => {
  if (!resultWindow || resultWindow.isDestroyed()) return { ok: false };
  resultPositionMode = 'manual';
  resultPointerInside = true;
  resultInteractionUntil = Date.now() + 900;
  overlayState = 'dragging_result';
  const bounds = resultWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: Number(pos?.x) || bounds.x, y: Number(pos?.y) || bounds.y });
  const next = clampWindowToWorkArea(Number(pos?.x) || bounds.x, Number(pos?.y) || bounds.y, RESULT_FIXED_WIDTH, currentResultHeight, display.workArea, 4);
  resultWindow.setBounds({ x: next.x, y: next.y, width: RESULT_FIXED_WIDTH, height: currentResultHeight }, true);
  return { ok: true };
});
ipcMain.handle('result:resize', (_event, desiredHeight) => {
  return resizeResultWindowHeight(desiredHeight);
});
ipcMain.handle('result:resize-box', (_event, size) => {
  return resizeResultWindowHeight(size?.height);
});

// ─── Browser HTTP Receiver ────────────────────────────
// 接收浏览器插件发来的精准取词结果

let browserPayload = null;      // latest BrowserPickedInfo
let browserPayloadAt = 0;       // timestamp when received
const BROWSER_PAYLOAD_TTL = 500; // ms — how long cached payload is valid
const LOCAL_TOKEN = 'aisel-local-bridge-v1'; // simple token to reject random requests
let lastBrowserSelectionAt = 0;
let lastExtensionHeartbeatAt = 0;
let browserExtensionOffline = false;

function getBrowserPayload() {
  if (!browserPayload) return null;
  if (Date.now() - browserPayloadAt > BROWSER_PAYLOAD_TTL) {
    browserPayload = null;
    return null;
  }
  browserPayload._perfReceivedAt = browserPayloadAt;
  return browserPayload;
}

function startBrowserReceiver() {
  const http = require('http');
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    // GET /health - bridge health check for browser extension
    if (req.method === 'GET' && req.url === '/health') {
      lastExtensionHeartbeatAt = Date.now();
      browserExtensionOffline = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'aisel', ts: Date.now() }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/selection') {
      res.writeHead(404); res.end(); return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        // Token check
        if (data.token !== LOCAL_TOKEN) {
          res.writeHead(403); res.end('bad token'); return;
        }
        browserPayload = data;
        browserPayloadAt = Date.now();
        lastBrowserSelectionAt = Date.now();
        console.log('[BrowserReceiver] got selection:', JSON.stringify({
          text: (data.text || '').slice(0, 60),
          fullText: (data.fullText || '').slice(0, 80),
          source: data.source,
          conf: data.confidence,
          site: data.metadata?.site,
          method: data.metadata?.method,
          adapter: data.metadata?.adapter,
          subtitleOverlayDetected: Boolean(data.metadata?.subtitleOverlayDetected),
          selectedTokens: data.metadata?.selectedTokens,
          error: data.metadata?.error || data.error,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400); res.end('bad json');
      }
    });
  });

  server.listen(17321, '127.0.0.1', () => {
    console.log('[BrowserReceiver] listening on http://127.0.0.1:17321/selection (health at /health)');
  });

  // Periodic extension heartbeat check (10s timeout)
  setInterval(() => {
    if (lastExtensionHeartbeatAt > 0 && Date.now() - lastExtensionHeartbeatAt > 10000) {
      if (!browserExtensionOffline) {
        browserExtensionOffline = true;
        console.log('[BrowserReceiver] extension OFFLINE - no heartbeat for 10s+');
      }
    } else if (lastExtensionHeartbeatAt > 0) {
      browserExtensionOffline = false;
    }
  }, 5000);

  server.on('error', (err) => {
    console.error('[BrowserReceiver] failed to start:', err.message);
  });
}

app.setName('饺划-AI划词助手');
app.setAppUserModelId('com.jiaohua.selection.assistant');

app.whenReady().then(() => {
  migrateUserDataIfNeeded();
  Menu.setApplicationMenu(null);
  createMainWindow();
  // Toolbar windows are intentionally created only when a real selection occurs.
  // When the toolbar is dismissed, the BrowserWindow is destroyed instead of hidden,
  // so it cannot remain as an invisible mouse blocker above the main UI.
  createResultWindow();
  createTray();
  // Apply hotkey config (defaults: enabled=true, key=Alt+Q)
  applyHotkeyConfig(readHotkeyConfig());
  startSelectionHelper();
  startBrowserReceiver();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', () => {
  globalShortcut.unregisterAll();
  stopSelectionHelper();
  stopSpeak();
});
