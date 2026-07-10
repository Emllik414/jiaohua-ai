import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { motion } from 'motion/react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Toolbar } from './toolbar/Toolbar'
import { MoreMenu } from './toolbar/MoreMenu'
import { ResultCardChrome } from './toolbar/ResultCardChrome'
import { buildMoreMenuSkills, buildToolbarActions } from './toolbar/actionRegistry'
import brandImg from './assets/icon.png'
import { SkillIcon, SKILL_ICON_KEYS, getDefaultSkillIconKey } from './components/SkillIcon'
import './App.css'

// ─── types ───
type Settings = {
  hotkey: string
  api: { providerName: string; baseUrl: string; chatPath: string; model: string; apiKey: string; stream: boolean }
  obsidian: { vaultPath: string; activeTemplateId?: string }
  selection: { autoSelect: boolean; dragDistance: number; releaseDelayMs: number }
}

type Skill = {
  id: string
  name: string
  icon: string
  enabled: boolean
  showInToolbar: boolean
  systemPrompt: string
  userPrompt: string
  outputMode: string
  sortOrder: number
  type?: 'ai' | 'builtin'
  builtinAction?: string
  deletable?: boolean
  iconKey?: string
}

type AppearanceMode = 'light' | 'dark' | 'system'

type PronunciationData = {
  mode: 'word' | 'sentence'
  text: string
  us_ipa?: string
  gb_ipa?: string
}

type HistoryRecord = {
  id: string
  createdAt: string
  sourceApp: string
  windowTitle: string
  selectedText: string
  skillId: string
  skillName: string
  providerId: string
  model: string
  answerMarkdown: string
  status: 'running' | 'completed' | 'failed' | 'confirming'
  savedToObsidian: boolean
  obsidianPath: string
  pronunciationData?: PronunciationData
  conversationId?: string
  selectionSource?: string
  selectionConfidence?: number
  selectionLatency?: number
  selectionAppName?: string
  selectionWindowTitle?: string
  pickedInfoSource?: string
  pickedInfoConfidence?: number
  runId?: string
}

type Conversation = {
  id: string
  title: string
  pinned: boolean
  createdAt: string
  updatedAt: string
  lastActivityAt: string
}

type ObsidianAppendBehavior = 'append_to_existing_note_bottom' | 'append_to_existing_note_top'

type ObsidianTemplate = {
  id: string
  name: string
  saveBehavior: ObsidianAppendBehavior
  targetNotePath: string
  contentTemplate: string
  createdAt: string
  updatedAt: string
}

type InitialData = {
  settings: Settings
  skills: Skill[]
  history: HistoryRecord[]
  toolbarSkills: Skill[]
  dataDir: string
  obsidianTemplates: ObsidianTemplate[]
  conversations: Conversation[]
  activeConversationId: string
}

type HotkeyConfig = {
  hotkeyEnabled: boolean
  selectionHotkey: string
}

type TtsStatePayload = {
  speaking: boolean
  key?: string
  reason?: string
  error?: string
}

type ProviderUserConfig = {
  enabled: boolean; apiKey: string; baseUrl: string; model: string;
  customModels: string[]; stream: boolean; temperature: number; maxTokens: number; timeoutMs: number;
}

type ProviderPreset = {
  name: string; apiType: string; baseUrl: string; models: string[];
  defaultModel: string; modelLabel?: string; hint?: string;
}

type ProviderConfigSnapshot = {
  configVersion: number; activeProvider: string;
  providers: Record<string, ProviderUserConfig>;
  skillModelMap: Record<string, { providerId?: string; modelId?: string }>;
}

type ProvidersMap = Record<string, ProviderPreset>

declare global {
  interface Window {
    desktopApi: {
      getInitialData: () => Promise<InitialData>
      saveSettings: (settings: Settings) => Promise<InitialData>
      saveSkill: (skill: Skill) => Promise<InitialData>
      reorderSkills: (skillIds: string[]) => Promise<InitialData>
      deleteSkill: (skillId: string) => Promise<InitialData>
      runSkill: (skillId: string, selection?: string) => Promise<HistoryRecord>
      copyText: (text: string, options?: { silent?: boolean }) => Promise<{ ok: boolean; silent?: boolean }>
      getConversations: () => Promise<{ conversations: Conversation[]; activeId: string }>
      createConversation: (title: string) => Promise<unknown>
      renameConversation: (id: string, title: string) => Promise<unknown>
      deleteConversation: (id: string, deleteRecords: boolean) => Promise<unknown>
      pinConversation: (id: string) => Promise<unknown>
      setActiveConversation: (id: string) => Promise<unknown>
      getObsidianTemplates: () => Promise<ObsidianTemplate[]>
      saveObsidianTemplate: (template: ObsidianTemplate) => Promise<ObsidianTemplate[]>
      deleteObsidianTemplate: (templateId: string) => Promise<ObsidianTemplate[]>
      previewObsidianTemplate: (templateId: string, recordId: string, record?: HistoryRecord) => Promise<{ markdown: string; relativePath: string; behavior: string; templateName: string }>
      saveToObsidianNote: (templateId: string, recordId: string, record?: HistoryRecord) => Promise<{ ok: boolean; path: string; templateName: string }>
      listVaultNotes: () => Promise<string[]>
      checkVaultPath: (relativePath: string) => Promise<{ exists: boolean }>
      deleteHistory: (recordIds: string[]) => Promise<InitialData>
      clearHistory: () => Promise<InitialData>
      speak: (text: string, options?: { key?: string }) => Promise<{ ok: boolean; speaking?: boolean }>
      stopSpeak: () => Promise<{ ok: boolean; speaking?: boolean }>
      onTtsState: (callback: (payload: TtsStatePayload) => void) => () => void
      showMain: () => Promise<{ ok: boolean }>
      closeCurrent: () => Promise<{ ok: boolean }>
      rendererLog?: (message: string) => void
      hideToolbar: () => Promise<{ ok: boolean }>
      resizeToolbar: (expanded: boolean) => Promise<{ ok: boolean }>
      toggleToolbarMore: () => Promise<{ ok: boolean; open: boolean }>
      hideToolbarMore: () => Promise<{ ok: boolean; open: boolean }>
      getToolbarBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>
      setToolbarSize: (size: { width: number; height: number }) => Promise<{ ok: boolean; width?: number; height?: number }>
      setToolbarPosition: (pos: { x: number; y: number } | null) => Promise<{ ok: boolean }>
      setToolbarPointerInside: (inside: boolean) => Promise<{ ok: boolean }>
      setToolbarMorePointerInside: (inside: boolean) => Promise<{ ok: boolean }>
      setResultPointerInside: (inside: boolean) => Promise<{ ok: boolean }>
      lockResultInteraction: (duration?: number) => Promise<{ ok: boolean }>
      setResultState: (state: string) => Promise<{ ok: boolean; state?: string }>
      closeResult: (reason: string) => Promise<{ ok: boolean }>
      getResultBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>
      setResultPosition: (pos: { x: number; y: number }) => Promise<{ ok: boolean }>
      resizeResult: (height: number) => Promise<{ ok: boolean }>
      resizeResultBox: (size: { width: number; height: number }) => Promise<{ ok: boolean }>
      onSelectionReady: (callback: (payload: { selection: string; skills: Skill[]; allSkills?: Skill[] }) => void) => () => void
      onResultReady: (callback: (record: HistoryRecord) => void) => () => void
      onResultUpdate: (callback: (record: HistoryRecord) => void) => () => void
      onResultReset: (callback: () => void) => () => void
      onConfirmSelection: (callback: (payload: any) => void) => () => void
      onToolbarShow: (callback: () => void) => () => void
      onToolbarHide: (callback: () => void) => () => void
      onToolbarMoreState: (callback: (payload: { open: boolean }) => void) => () => void
      onSkillsUpdated: (callback: (payload: { toolbarSkills: Skill[]; allSkills: Skill[] }) => void) => () => void
      confirmSelection: (skillId: string, selectedText: string) => Promise<HistoryRecord>
      cancelSelection: () => Promise<{ ok: boolean }>
      onHistoryChanged: (callback: (history: HistoryRecord[]) => void) => () => void
      getHotkeyConfig: () => Promise<HotkeyConfig>
      saveHotkeyConfig: (config: HotkeyConfig) => Promise<{ ok: boolean }>
      getProviderConfig: () => Promise<ProviderConfigSnapshot>
      saveProviderConfig: (updates: { activeProvider?: string; providers?: Record<string, Partial<ProviderUserConfig>> }) => Promise<{ ok: boolean }>
      getProviderPresets: () => Promise<ProvidersMap>
      testProviderConnection: (providerId: string) => Promise<{ ok: boolean; error?: string }>
    }
  }
}

const newTemplateId = () => `obsidian_tpl_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`

// Toolbar tooltip needs a small transparent top breathing room inside the Electron window.
const TOOLBAR_TOOLTIP_TOP_SPACE = 26
const TOOLBAR_WINDOW_SIDE_PADDING = 20

const emptySkill: Skill = {
  id: 'custom_skill',
  name: '自定义',
  icon: '自',
  iconKey: 'spark',
  enabled: true,
  showInToolbar: true,
  systemPrompt: '你是 饺划-AI划词助手，请用中文回答。',
  userPrompt: '请处理下面划词内容：\n\n{{selection}}',
  outputMode: 'popup',
  sortOrder: 100,
}

async function saveRecordToActiveObsidian(record: HistoryRecord) {
  const data = await window.desktopApi.getInitialData()
  const templates = data.obsidianTemplates || []
  if (templates.length === 0) throw new Error('没有可用的 Obsidian 模板')
  const activeId = data.settings.obsidian.activeTemplateId
  const template = templates.find((item) => item.id === activeId) || templates[0]
  return window.desktopApi.saveToObsidianNote(template.id, record.id, record)
}

function routeName() {
  return new URLSearchParams(window.location.search).get('route') || 'main'
}

function useDesktopTts() {
  const [activeTtsKey, setActiveTtsKey] = useState('')

  useEffect(() => {
    return window.desktopApi.onTtsState((payload) => {
      setActiveTtsKey(payload.speaking ? (payload.key || '') : '')
    })
  }, [])

  const toggleDesktopSpeak = async (text: string, key: string) => {
    if (activeTtsKey === key) {
      await window.desktopApi.stopSpeak()
      setActiveTtsKey('')
      return
    }

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }

    setActiveTtsKey(key)
    await window.desktopApi.speak(text, { key })
  }

  return { activeTtsKey, toggleDesktopSpeak }
}

export default function App() {
  useAppearanceBootstrap()
  const route = routeName()
  if (route === 'toolbar') return <ToolbarView />
  if (route === 'toolbar-more') return <ToolbarMoreView />
  if (route === 'result') return <ResultView />
  return <MainView />
}

function useAppearanceBootstrap() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => applyAppearance(getStoredAppearance(), media.matches)
    sync()
    media.addEventListener('change', sync)
    window.addEventListener('storage', sync)
    return () => {
      media.removeEventListener('change', sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
}

function MainView() {
  const [data, setData] = useState<InitialData | null>(null)
  const [tab, setTab] = useState<'history' | 'settings' | 'skills' | 'obsidian'>('history')
  const [message, setMessage] = useState('')

  useEffect(() => {
    window.desktopApi.getInitialData().then(setData)
    return window.desktopApi.onHistoryChanged((history) => setData((current) => current ? { ...current, history } : current))
  }, [])

  if (!data) return <div className="loading">正在启动 饺划-AI划词助手...</div>

  const saveSettings = async (settings: Settings) => {
    const next = await window.desktopApi.saveSettings(settings)
    setData(next)
    setMessage('设置已保存')
  }
  const saveSkill = async (skill: Skill) => {
    const next = await window.desktopApi.saveSkill(skill)
    setData(next)
    setMessage('技能已保存')
  }
  const deleteSkill = async (skillId: string) => {
    const next = await window.desktopApi.deleteSkill(skillId)
    setData(next)
    setMessage('技能已删除')
  }
  const reorderSkills = async (skillIds: string[]) => {
    const next = await window.desktopApi.reorderSkills(skillIds)
    setData(next)
    setMessage('排序已保存')
  }
  const refreshConversations = async () => {
    const { conversations, activeId } = await window.desktopApi.getConversations()
    setData((current) => current ? { ...current, conversations, activeConversationId: activeId } : current)
  }

  return (
    <div className="main-window-wrap">
      <div className="main-glass-window">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-icon"><SkillIcon iconKey="spark" /></div>
            <div>
              <div className="brand-title">饺划-AI划词助手</div>
              <div className="brand-sub">Selection Copilot</div>
            </div>
          </div>
          <nav className="nav">
            {[
              ['history', 'history', '历史对话'],
              ['settings', 'api', 'API 设置'],
              ['skills', 'skills', '技能管理'],
              ['obsidian', 'obsidian', 'Obsidian 导入'],
            ].map(([id, icon, label]) => (
              <div
                key={id}
                className={'nav-item' + (tab === id ? ' active' : '')}
                onClick={() => setTab(id as typeof tab)}
              >
                <span className="nav-icon"><SkillIcon iconKey={icon} /></span>
                <span>{label}</span>
              </div>
            ))}
          </nav>
          <div className="sidebar-spacer" />
          <AppearanceControl />
          <HotkeyCard />
          <div className="version">v1.0.0</div>
        </aside>

        <main className="main-panel">
          {tab !== 'skills' && tab !== 'history' && tab !== 'settings' && tab !== 'obsidian' ? (
            <header className="topbar">
              <div><h2>{tabTitle(tab)}</h2><p>{tabSubtitle(tab)}</p></div>
              {message ? <span className="toast">{message}</span> : null}
            </header>
          ) : null}
          {tab === 'history' && <HistoryPanel history={data.history} conversations={data.conversations} activeConversationId={data.activeConversationId} onRefresh={refreshConversations} templates={data.obsidianTemplates} activeTemplateId={data.settings.obsidian.activeTemplateId} />}
          {tab === 'settings' && <ApiPanel />}
          {tab === 'skills' && <SkillsPanel skills={data.skills} onSave={saveSkill} onDelete={deleteSkill} onReorder={reorderSkills} />}
          {tab === 'obsidian' && <ObsidianPanel settings={data.settings} onSave={saveSettings} dataDir={data.dataDir} templates={data.obsidianTemplates} />}
        </main>
      </div>
    </div>
  )
}

const APPEARANCE_STORAGE_KEY = 'jiaohua.appearance'

function getStoredAppearance(): AppearanceMode {
  const stored = localStorage.getItem(APPEARANCE_STORAGE_KEY)
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

function applyAppearance(mode: AppearanceMode, systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches) {
  const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
  document.documentElement.dataset.appearance = resolved
  document.documentElement.style.colorScheme = resolved
}

function AppearanceControl() {
  const [mode, setMode] = useState<AppearanceMode>(getStoredAppearance)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => applyAppearance(mode, media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [mode])

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [])

  const choose = (next: AppearanceMode) => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, next)
    setMode(next)
    setOpen(false)
  }

  const labels: Record<AppearanceMode, string> = { light: '浅色', dark: '深色', system: '跟随系统' }
  const icons: Record<AppearanceMode, string> = { light: 'sun', dark: 'moon', system: 'system' }

  return (
    <div className="appearance-control" ref={rootRef}>
      <button className="appearance-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <SkillIcon iconKey={icons[mode]} />
        <span>外观与颜色</span>
        <em>{labels[mode]}</em>
      </button>
      {open ? (
        <div className="appearance-menu">
          {(['light', 'dark', 'system'] as AppearanceMode[]).map((item) => (
            <button key={item} className={mode === item ? 'active' : ''} onClick={() => choose(item)}>
              <SkillIcon iconKey={icons[item]} />
              <span>{labels[item]}</span>
              {mode === item ? <b>✓</b> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ─── HotkeyCard ──────────────────────────────────────

const RESERVED_HOTKEYS = ['Alt+F4', 'Ctrl+Alt+Delete', 'Win+L', 'Win+D', 'Win+R', 'Win+E', 'Alt+Tab', 'Ctrl+Shift+Escape', 'Ctrl+Alt+Del'];
const HOTKEY_RE = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?([A-Z0-9])$/i;

function formatAccelerator(accelerator: string) {
  return accelerator.replace(/\+/g, ' + ');
}

function HotkeyCard() {
  const [config, setConfig] = useState<HotkeyConfig>({ hotkeyEnabled: true, selectionHotkey: 'Alt+Q' });
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    window.desktopApi.getHotkeyConfig().then((cfg) => { if (cfg) setConfig(cfg); });
  }, []);

  const save = async (next: HotkeyConfig) => {
    setError('');
    const result = await window.desktopApi.saveHotkeyConfig(next);
    if (result.ok) setConfig(next); else setError('保存失败');
  };

  const toggleEnabled = () => {
    const next = { ...config, hotkeyEnabled: !config.hotkeyEnabled };
    if (!next.hotkeyEnabled) setRecording(false);
    save(next);
  };

  const startRecord = () => { setRecording(true); setError(''); };

  const handleRecordKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    const key = e.key.toUpperCase();
    if (!/^[A-Z0-9]$/.test(key)) { setError('请使用字母或数字'); return; }
    if (parts.length === 0) { setError('需要包含 Ctrl / Alt / Shift / Meta 修饰键'); return; }
    parts.push(key);
    const combo = parts.join('+');
    if (RESERVED_HOTKEYS.includes(combo)) { setError('不允许使用系统高危快捷键: ' + combo); return; }
    if (!HOTKEY_RE.test(combo)) { setError('快捷键格式非法'); return; }
    setRecording(false);
    setError('');
    save({ ...config, selectionHotkey: combo });
  };

  return (
    <div className="hotkey-card">
      <div className="hotkey-card-title">划词快捷键</div>
      <label className="hotkey-toggle">
        <span>快捷键取词</span>
        <button className={config.hotkeyEnabled ? 'toggle on' : 'toggle'} onClick={toggleEnabled} role="switch" aria-checked={config.hotkeyEnabled}>
          <span className="toggle-knob" />
        </button>
      </label>
      {config.hotkeyEnabled ? (
        <div className="hotkey-display">
          <span className="hotkey-current">{formatAccelerator(config.selectionHotkey)}</span>
          {!recording ? (
            <div className="hotkey-btns">
              <button className="hotkey-change-btn" onClick={startRecord}>修改</button>
              {config.selectionHotkey !== 'Alt+Q' ? (
                <button className="hotkey-reset-btn" onClick={() => save({ ...config, selectionHotkey: 'Alt+Q' })}>重置</button>
              ) : null}
            </div>
          ) : (
            <div className="hotkey-recording" tabIndex={0} onKeyDown={handleRecordKeyDown} onBlur={() => { setRecording(false); setError(''); }} ref={(el) => { if (el) el.focus(); }}>按下新快捷键...</div>
          )}
        </div>
      ) : (
        <div className="hotkey-disabled-note">快捷键已关闭</div>
      )}
      {error ? <div className="hotkey-error">{error}</div> : null}
    </div>
  );
}

function tabTitle(tab: string) {
  return { history: '对话式历史', settings: 'API 接口', skills: '划词技能', obsidian: 'Obsidian 导入' }[tab] || ''
}

function tabSubtitle(tab: string) {
  return {
    history: '每次划词都会保存为一组轻量 AI 对话。',
    settings: '配置 DeepSeek 或 OpenAI-compatible 接口。',
    skills: '自定义工具条按钮、图标和 Prompt。',
    obsidian: '把结果直接写入你的 Obsidian vault。',
  }[tab] || ''
}

﻿function HistoryPanel({ history, conversations, activeConversationId, onRefresh, templates, activeTemplateId }: { history: HistoryRecord[]; conversations: Conversation[]; activeConversationId: string; onRefresh: () => void; templates: ObsidianTemplate[]; activeTemplateId?: string }) {
  const [filter, setFilter] = useState('')
  const [convSearch, setConvSearch] = useState('')
  const [message, setMessage] = useState('')
  const [editingConvId, setEditingConvId] = useState('')
  const [editingConvTitle, setEditingConvTitle] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const { activeTtsKey, toggleDesktopSpeak } = useDesktopTts()

  // ─── 选择模式 ───
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const activeConv = conversations.find((c) => c.id === activeConversationId)
  const convRecords = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    const filtered = history.filter((r) => r.conversationId === activeConversationId)
    return keyword ? filtered.filter((item) => `${item.selectedText} ${item.answerMarkdown} ${item.skillName}`.toLowerCase().includes(keyword)) : filtered
  }, [filter, history, activeConversationId])

  const filteredConvs = useMemo(() => {
    const q = convSearch.trim().toLowerCase()
    return conversations.filter((c) => !q || c.title.toLowerCase().includes(q))
  }, [conversations, convSearch])

  const sortedConvs = useMemo(() => {
    const pinned = filteredConvs.filter((c) => c.pinned).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    const unpinned = filteredConvs.filter((c) => !c.pinned).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    return [...pinned, ...unpinned]
  }, [filteredConvs])

  // ─── 对话分组 ───
  const convGroups = useMemo(() => {
    const map = new Map<string, Conversation[]>()
    for (const c of sortedConvs) {
      const key = formatDateGroup(c.lastActivityAt)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(c)
    }
    return Array.from(map.entries())
  }, [sortedConvs])

  const enterSelectMode = () => { setSelectMode(true); setSelectedIds(new Set()) }
  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()) }

  // ─── 模板选择器 ───
  const [tplOpen, setTplOpen] = useState(false)
  const [localActiveTplId, setLocalActiveTplId] = useState(activeTemplateId)
  const activeTpl = templates.find((t) => t.id === localActiveTplId) || templates[0]
  const switchTemplate = async (tplId: string) => {
    setLocalActiveTplId(tplId)
    setTplOpen(false)
    const data = await window.desktopApi.getInitialData()
    await window.desktopApi.saveSettings({ ...data.settings, obsidian: { ...data.settings.obsidian, activeTemplateId: tplId } })
  }

  const toggleSelectId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const allSelected = convRecords.length > 0 && convRecords.every((r) => selectedIds.has(r.id))
  const selectAll = () => { setSelectedIds(new Set(convRecords.map((r) => r.id))) }
  const deselectAll = () => { setSelectedIds(new Set()) }

  const selectedRecords = useMemo(() => convRecords.filter((r) => selectedIds.has(r.id)), [convRecords, selectedIds])

  const importToObsidian = async (records: HistoryRecord[]) => {
    if (records.length === 0) { setMessage('没有可导入的记录'); return }
    let ok = 0, fail = 0
    for (const r of records) {
      try { await saveRecordToActiveObsidian(r); ok++ }
      catch { fail++ }
    }
    setMessage(`已导入 ${ok} 条${fail > 0 ? `，${fail} 条失败` : ''}`)
  }

  const importAllToObsidian = () => importToObsidian(convRecords)
  const importSelectedToObsidian = () => importToObsidian(selectedRecords)
  const deleteSingle = async (id: string) => { await window.desktopApi.deleteHistory([id]); onRefresh() }
  const deleteSelected = async () => { if (selectedIds.size) { await window.desktopApi.deleteHistory([...selectedIds]); onRefresh() } }

  // ─── 全部展开/收起 ───
  const allExpanded = convRecords.length > 0 && convRecords.every((r) => expandedIds.has(r.id))
  const toggleAllExpanded = () => {
    if (allExpanded) {
      const next = new Set(expandedIds)
      convRecords.forEach((r) => next.delete(r.id))
      setExpandedIds(next)
    } else {
      const next = new Set(expandedIds)
      convRecords.forEach((r) => next.add(r.id))
      setExpandedIds(next)
    }
  }

  // ─── 对话记录数 ───
  const conversationRecordCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of history) {
      map.set(r.conversationId || '', (map.get(r.conversationId || '') || 0) + 1)
    }
    return map
  }, [history])

  return (
    <div className="history-page">
      <div className="history-head">
        <div>
          <h1>对话式历史</h1>
          <p>每次划词都会保存为一组轻量 AI 对话。</p>
        </div>
      </div>

      <div className="history-layout">
        <aside className="conversation-pane">
          <input className="conversation-search" placeholder="搜索对话..." value={convSearch} onChange={(e) => setConvSearch(e.target.value)} />
          <button className="new-conversation-btn" onClick={async () => { await window.desktopApi.createConversation(''); onRefresh() }}>+ 新对话</button>
          <div className="conversation-list">
            {convGroups.length === 0 ? (
              <div className="empty">没有找到对话</div>
            ) : (
              convGroups.map(([label, convs]) => (
                <div key={label}>
                  <div className="conv-date-label">{label}</div>
                  {convs.map((conv) => (
                    <ConversationItem
                      key={conv.id}
                      conv={conv}
                      active={conv.id === activeConversationId}
                      editing={editingConvId === conv.id}
                      editTitle={editingConvTitle}
                      recordCount={conversationRecordCounts.get(conv.id) || 0}
                      onSelect={async () => { await window.desktopApi.setActiveConversation(conv.id); onRefresh() }}
                      onEditStart={(title) => { setEditingConvId(conv.id); setEditingConvTitle(title) }}
                      onEditConfirm={async () => { await window.desktopApi.renameConversation(conv.id, editingConvTitle); setEditingConvId(''); onRefresh() }}
                      onPin={async () => { await window.desktopApi.pinConversation(conv.id); onRefresh() }}
                      onDelete={async () => {
                        if (conversations.length <= 1) { setMessage('至少保留一个对话'); return }
                        const delRecords = window.confirm('同时删除对话中的所有记录？\n"确定"=删除记录，"取消"=只删除对话')
                        await window.desktopApi.deleteConversation(conv.id, delRecords)
                        setEditingConvId('')
                        onRefresh()
                      }}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </aside>

        <section className="records-pane">
          <div className="records-head">
            <div>
              <h2>{activeConv?.title || '对话式历史'}</h2>
              <p>{convRecords.length} 条记录</p>
            </div>
            {!selectMode ? (
              <div className="history-actions">
                <button className="btn" onClick={toggleAllExpanded}>{allExpanded ? '全部收起' : '全部展开'}</button>
                <button className="btn primary" onClick={enterSelectMode}>选择</button>
              </div>
            ) : (
              <div className="selection-toolbar">
                <span className="select-pill">已选择 {selectedIds.size} 条</span>
                <button className="btn" onClick={allSelected ? deselectAll : selectAll}>{allSelected ? '取消全选' : '全选'}</button>
                <div className="grow" />
                {activeTpl ? (
                  <div className="tpl-selector">
                    <button className="tpl-chip" onClick={() => setTplOpen(!tplOpen)}>
                      <span className="tpl-label">模板</span>
                      <span className="tpl-name">{activeTpl.name}</span>
                      <span className={'tpl-arrow' + (tplOpen ? ' open' : '')}>▾</span>
                    </button>
                    {tplOpen ? (
                      <div className="tpl-dropdown">
                        {templates.map((t) => (
                          <button key={t.id} className={'tpl-item' + (t.id === activeTpl.id ? ' active' : '')} onClick={() => switchTemplate(t.id)}>{t.id === activeTpl.id ? '✓ ' : ''}{t.name}</button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <button className="btn purple" onClick={importSelectedToObsidian} disabled={selectedIds.size === 0}>导入 Obsidian</button>
                <button className="btn danger" onClick={() => { if (confirm('确定删除选中的 ' + selectedIds.size + ' 条记录吗？')) { deleteSelected(); exitSelectMode() } }} disabled={selectedIds.size === 0}>删除</button>
                <button className="btn" onClick={exitSelectMode}>完成</button>
              </div>
            )}
          </div>

          <div className="records-search">
            <input className="search" placeholder="搜索当前对话..." value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>

          {message ? <div className="history-message" onClick={() => setMessage('')}>{message}</div> : null}

          <div className="record-list">
            {convRecords.length === 0 ? (
              <div className="empty">选择文字后，AI 结果会保存到这个对话。</div>
            ) : (
              <DateGroupedRecords
                items={convRecords}
                expandedIds={expandedIds}
                toggleExpand={(id) => setExpandedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })}
                selectMode={selectMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelectId}
                onDelete={selectMode ? undefined : deleteSingle}
                activeTtsKey={activeTtsKey}
                onToggleSpeak={toggleDesktopSpeak}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

/* ───── 对话列表项 ───── */

function ConversationItem({ conv, active, editing, editTitle, recordCount, onSelect, onEditStart, onEditConfirm, onPin, onDelete }: {
  conv: Conversation; active: boolean; editing: boolean; editTitle: string; recordCount: number;
  onSelect: () => void; onEditStart: (t: string) => void; onEditConfirm: () => void; onPin: () => void; onDelete: () => void;
}) {
  return (
    <div className={'conversation-item' + (active ? ' active' : '')} onClick={onSelect}>
      {editing ? (
        <input className="conv-edit-input" value={editTitle} onChange={(e) => onEditStart(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onEditConfirm() }} onBlur={onEditConfirm} autoFocus onClick={(e) => e.stopPropagation()} />
      ) : (
        <>
          <div className="conversation-item-title">{conv.pinned ? '📌 ' : ''}{conv.title}</div>
          <div className="conversation-item-meta">{recordCount} 条记录</div>
          {active ? (
            <div className="conv-actions" onClick={(e) => e.stopPropagation()}>
              <button title="重命名" onClick={() => onEditStart(conv.title)}>✏️</button>
              <button title={conv.pinned ? '取消置顶' : '置顶'} onClick={onPin}>{conv.pinned ? '📌' : '📍'}</button>
              <button title="删除" onClick={onDelete}>🗑️</button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

/* ───── 记录分组 ───── */

function formatDateGroup(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const itemDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (itemDay.getTime() === today.getTime()) return '\u4eca\u5929'
  if (itemDay.getTime() === yesterday.getTime()) return '\u6628\u5929'
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}

function DateGroupedRecords({ items, expandedIds, toggleExpand, selectMode, selectedIds, onToggleSelect, onDelete, activeTtsKey, onToggleSpeak }: { items: HistoryRecord[]; expandedIds: Set<string>; toggleExpand: (id: string) => void; selectMode?: boolean; selectedIds?: Set<string>; onToggleSelect?: (id: string) => void; onDelete?: (id: string) => void; activeTtsKey: string; onToggleSpeak: (text: string, key: string) => Promise<void> }) {
  const groups = useMemo(() => {
    const map = new Map<string, HistoryRecord[]>()
    for (const item of items) {
      const key = formatDateGroup(item.createdAt)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(item)
    }
    return Array.from(map.entries())
  }, [items])

  return (
    <>
      {groups.map(([label, records]) => (
        <div key={label} className="date-group">
          <div className="date-group-header">{label}</div>
          {records.map((item) => (
            <RecordCard
              key={item.id} item={item}
              expanded={expandedIds.has(item.id)}
              onToggle={() => toggleExpand(item.id)}
              selectMode={selectMode}
              checked={selectedIds?.has(item.id)}
              onToggleSelect={onToggleSelect ? () => onToggleSelect(item.id) : undefined}
              onDelete={onDelete}
              activeTtsKey={activeTtsKey}
              onToggleSpeak={onToggleSpeak}
            />
          ))}
        </div>
      ))}
    </>
  )
}

function RecordCard({ item, expanded, onToggle, selectMode, checked, onToggleSelect, onDelete, activeTtsKey, onToggleSpeak }: { item: HistoryRecord; expanded: boolean; onToggle: () => void; selectMode?: boolean; checked?: boolean; onToggleSelect?: () => void; onDelete?: (id: string) => void; activeTtsKey: string; onToggleSpeak: (text: string, key: string) => Promise<void> }) {
  const [actionStatus, setActionStatus] = useState('')
  const isRunning = item.status === 'running'
  const ttsKey = `history:${item.id}:answer`
  const isSpeaking = activeTtsKey === ttsKey

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm('\u786e\u5b9a\u5220\u9664\u8fd9\u6761\u8bb0\u5f55\u5417\uff1f')) onDelete?.(item.id)
  }

  const handleHeaderClick = () => {
    if (selectMode && onToggleSelect) onToggleSelect()
    else onToggle()
  }

  return (
    <article className={'record-card' + (expanded ? ' expanded' : '')}>
      <div className="record-card-head" onClick={handleHeaderClick}>
        {selectMode ? (
          <input type="checkbox" className="record-checkbox" checked={checked || false} onChange={onToggleSelect} onClick={(e) => e.stopPropagation()} />
        ) : (
          <span className={'record-card-arrow' + (expanded ? ' open' : '')}>▶</span>
        )}
        <span className="record-skill-badge">{item.skillName}</span>
        <span className="record-preview">{item.selectedText.slice(0, 60)}{item.selectedText.length > 60 ? '...' : ''}</span>
        <span className="record-time">{new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
        {!selectMode ? (
          <button className="record-card-delete" onClick={(e) => { e.stopPropagation(); if (confirm('\u786e\u5b9a\u5220\u9664\u8fd9\u6761\u8bb0\u5f55\u5417\uff1f')) { onDelete?.(item.id) } }} title="删除">×</button>
        ) : null}
      </div>

      {expanded && (
        <div className="record-card-body">
          <div className="record-source">
            <div className="record-source-label">原文</div>
            <div className="record-source-text">{item.selectedText}</div>
          </div>
          {item.pronunciationData ? (
            <PronunciationCard data={item.pronunciationData} answer={item.answerMarkdown} status={item.status} />
          ) : (
            <div className="record-answer">
              <div className="record-answer-label">AI 回答</div>
              {item.answerMarkdown ? <MarkdownView text={item.answerMarkdown} /> : isRunning ? <TypingDots /> : null}
            </div>
          )}
          <div className="record-actions">
            <div className="record-actions-left">
              <button className="pill-btn" onClick={(e) => { e.stopPropagation(); window.desktopApi.copyText(item.answerMarkdown); setActionStatus('\u5df2\u590d\u5236') }}>复制</button>
              <button className="pill-btn" onClick={(e) => { e.stopPropagation(); saveRecordToActiveObsidian(item).then((r) => setActionStatus('\u5df2\u4fdd\u5b58\uff1a' + r.path)).catch((err) => setActionStatus(err instanceof Error ? err.message : String(err))) }}>保存到 Obsidian</button>
              <button className="pill-btn" onClick={(e) => { e.stopPropagation(); void onToggleSpeak(item.answerMarkdown, ttsKey) }}>{isSpeaking ? '停止' : '朗读'}</button>
            </div>
            <button className="pill-btn danger" onClick={handleDelete}>删除</button>
            {actionStatus ? <span className="action-status">{actionStatus}</span> : null}
          </div>
        </div>
      )}
    </article>
  )
}


﻿function ApiPanel() {
  const [config, setConfig] = useState<ProviderConfigSnapshot | null>(null)
  const [presets, setPresets] = useState<ProvidersMap | null>(null)
  const [selectedId, setSelectedId] = useState('deepseek')
  const [showKey, setShowKey] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [message, setMessage] = useState('')
  const [addingModel, setAddingModel] = useState(false)
  const [newModelName, setNewModelName] = useState('')

  useEffect(() => {
    (async () => {
      const cfg = await window.desktopApi.getProviderConfig()
      setConfig(cfg)
      setSelectedId(cfg.activeProvider)
      const p = await window.desktopApi.getProviderPresets()
      setPresets(p)
    })()
  }, [])

  if (!config || !presets) return <div className="loading">加载中...</div>

  const preset = presets[selectedId]
  const pcfg = config.providers[selectedId]
  const availableModels = [...new Set([...(preset?.models || []), ...(pcfg?.customModels || [])])]

  const save = async (updates: Record<string, Partial<ProviderUserConfig>>) => {
    setMessage('')
    setTestResult(null)
    const next = { ...config, providers: { ...config.providers } }
    if (updates[selectedId]) {
      next.providers[selectedId] = { ...next.providers[selectedId], ...updates[selectedId] }
    }
    setConfig(next as ProviderConfigSnapshot)
    await window.desktopApi.saveProviderConfig({ providers: updates })
    setMessage('已保存')
  }

  const testConnection = async () => {
    setTesting(true)
    setTestResult(null)
    const r = await window.desktopApi.testProviderConnection(selectedId)
    setTestResult(r)
    setTesting(false)
  }

  const switchProvider = async (id: string) => {
    setSelectedId(id)
    setShowKey(false)
    setShowAdvanced(false)
    setTestResult(null)
    setAddingModel(false)
    await window.desktopApi.saveProviderConfig({ activeProvider: id })
  }

  const addModel = () => {
    if (!newModelName.trim()) return
    const nextCustomModels = [...new Set([...(pcfg?.customModels || []), newModelName.trim()])]
    save({ [selectedId]: { customModels: nextCustomModels, model: newModelName.trim() } })
    setAddingModel(false)
    setNewModelName('')
  }

  const removeModel = () => {
    const currentModel = pcfg?.model || preset.defaultModel
    const nextCustom = (pcfg?.customModels || []).filter(m => m !== currentModel)
    const fallbackModel = preset.defaultModel
    save({ [selectedId]: { customModels: nextCustom, model: nextCustom.length > 0 ? nextCustom[0] : fallbackModel } })
  }

  return (
    <div className="api-page">
      <div className="api-head">
        <div>
          <h1>API 设置</h1>
          <p>配置 DeepSeek 或 OpenAI-compatible 接口。API Key 仅保存在本地。</p>
        </div>
      </div>

      <div className="api-layout">
        <aside className="provider-pane">
          <div className="provider-list">
            {Object.entries(presets).map(([id, p]) => (
              <button key={id} className={'provider-item' + (selectedId === id ? ' active' : '')} onClick={() => switchProvider(id)}>
                <div>
                  <strong>{p.name}</strong>
                  <span>{p.apiType === 'openai-compatible' ? 'OpenAI-compatible' : p.apiType}</span>
                </div>
                {config.providers[id]?.enabled && config.providers[id]?.apiKey ? (
                  <span className="provider-status-dot configured" />
                ) : (
                  <span className="provider-status-dot" />
                )}
              </button>
            ))}
          </div>
        </aside>

        <section className="api-config-card">
          <div className="api-config-head">
            <div>
              <h2>{preset.name}</h2>
              <p>{preset.hint || (preset.baseUrl ? 'Base URL: ' + preset.baseUrl : '')}</p>
            </div>
          </div>

          <div className="api-form">
            <div className="form-row">
              <label>API Key <span style={{ color: '#ef4444' }}>*</span></label>
              <div className="input-wrap">
                <input type={showKey ? 'text' : 'password'} value={pcfg?.apiKey || ''} onChange={(e) => save({ [selectedId]: { apiKey: e.target.value } })} placeholder="输入 API Key..." />
                <button onClick={() => setShowKey(!showKey)}>{showKey ? '🙈' : '👁'}</button>
              </div>
              <div className="form-row-hint">API Key 仅保存在本地设备。</div>
            </div>

            <div className="form-row">
              <label>{preset.modelLabel || '模型'}</label>
              <div className="input-wrap">
                <select value={pcfg?.model || preset.defaultModel} onChange={(e) => save({ [selectedId]: { model: e.target.value } })}>
                  {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <button onClick={() => { setAddingModel(true); setNewModelName('') }} title="添加模型">+</button>
                {(pcfg?.customModels || []).includes(pcfg?.model || '') ? <button onClick={removeModel} title="删除此模型">−</button> : null}
              </div>
              {addingModel ? (
                <div className="model-add-row">
                  <input value={newModelName} onChange={(e) => setNewModelName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addModel() }} placeholder="模型 ID..." autoFocus />
                  <button onClick={addModel}>确认</button>
                  <button onClick={() => setAddingModel(false)}>取消</button>
                </div>
              ) : null}
            </div>

            <div className="form-row">
              <label>Base URL</label>
              <div className="input-wrap">
                <input value={pcfg?.baseUrl || ''} onChange={(e) => save({ [selectedId]: { baseUrl: e.target.value } })} placeholder={preset.baseUrl || 'https://...'} />
              </div>
            </div>

            <div className="form-row">
              <label className="inline-label">
                <input type="checkbox" checked={pcfg?.stream !== false} onChange={(e) => save({ [selectedId]: { stream: e.target.checked } })} />
                <span>流式输出</span>
              </label>
            </div>

            <button className="api-advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? '▲ 收起高级设置' : '▼ 高级设置'}
            </button>

            {showAdvanced ? (
              <div className="api-advanced">
                <div className="form-row">
                  <label>Temperature</label>
                  <div className="input-wrap">
                    <input type="number" min={0} max={2} step={0.1} value={pcfg?.temperature ?? 0.3} onChange={(e) => save({ [selectedId]: { temperature: Number(e.target.value) } })} />
                  </div>
                </div>
                <div className="form-row">
                  <label>Max Tokens</label>
                  <div className="input-wrap">
                    <input type="number" min={1} max={32000} value={pcfg?.maxTokens ?? 1200} onChange={(e) => save({ [selectedId]: { maxTokens: Number(e.target.value) } })} />
                  </div>
                </div>
                <div className="form-row">
                  <label>Timeout (ms)</label>
                  <div className="input-wrap">
                    <input type="number" min={5000} max={300000} value={pcfg?.timeoutMs ?? 60000} onChange={(e) => save({ [selectedId]: { timeoutMs: Number(e.target.value) } })} />
                  </div>
                </div>
              </div>
            ) : null}

            <div className="api-actions">
              <button className="primary" onClick={testConnection} disabled={testing}>
                {testing ? '测试连接中...' : '测试连接'}
              </button>
              {testResult ? (
                <span className={testResult.ok ? 'api-test-ok' : 'api-test-fail'}>
                  {testResult.ok ? '✓ 连接成功' : ('✗ ' + (testResult.error || '连接失败'))}
                </span>
              ) : null}
              <div className="grow" />
              {message ? <span className="api-saved">{message}</span> : null}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
function isCustomSkill(skill: Skill) {
  if (skill.deletable === false) return false
  return skill.id.startsWith('custom_') || skill.id === 'custom_skill'
}

const toolbarSkillLimit = 5

function SkillsPanel({ skills, onSave, onDelete, onReorder }: { skills: Skill[]; onSave: (skill: Skill) => void; onDelete: (skillId: string) => void; onReorder: (skillIds: string[]) => void }) {
  const sortedSkills = useMemo(() => [...skills].sort((a, b) => a.sortOrder - b.sortOrder), [skills])
  const sortedSkillIds = useMemo(() => sortedSkills.map((skill) => skill.id), [sortedSkills])
  const sortedSkillSignature = sortedSkillIds.join('|')
  const skillById = useMemo(() => new Map(sortedSkills.map((skill) => [skill.id, skill])), [sortedSkills])

  const [menuSkill, setMenuSkill] = useState<Skill | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<Skill | null>(null)
  const [draggingId, setDraggingId] = useState('')
  const [dragOverId, setDragOverId] = useState('')
  const [dragOverPosition, setDragOverPosition] = useState<'before' | 'after'>('before')
  const [orderedSkillIds, setOrderedSkillIds] = useState<string[]>(sortedSkillIds)
  const menuRef = useRef<HTMLDivElement>(null)
  const pendingOrderRef = useRef<string[]>(sortedSkillIds)
  const dragOverStateRef = useRef({ id: '', position: 'before' as 'before' | 'after' })
  const dragCommittedRef = useRef(false)

  useEffect(() => {
    if (draggingId) return
    setOrderedSkillIds(sortedSkillIds)
    pendingOrderRef.current = sortedSkillIds
  }, [sortedSkillSignature, draggingId])

  const displaySkills = useMemo(() => {
    const sourceIds = orderedSkillIds.length > 0 ? orderedSkillIds : sortedSkillIds
    const seen = new Set<string>()
    const ordered = sourceIds
      .map((id) => skillById.get(id))
      .filter((skill): skill is Skill => {
        if (!skill || seen.has(skill.id)) return false
        seen.add(skill.id)
        return true
      })

    for (const skill of sortedSkills) {
      if (!seen.has(skill.id)) ordered.push(skill)
    }

    return ordered
  }, [orderedSkillIds, sortedSkillIds, skillById, sortedSkills])

  const toolbarSkills = displaySkills.slice(0, 5)
  const moreSkills = displaySkills.slice(5)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuSkill(null)
        setMenuPos(null)
      }
    }
    if (menuSkill) {
      window.addEventListener('mousedown', handleClick)
      return () => window.removeEventListener('mousedown', handleClick)
    }
  }, [menuSkill])

  const openMenu = (e: React.MouseEvent, skill: Skill) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenuPos({ x: Math.min(rect.right - 180, window.innerWidth - 200), y: rect.bottom + 4 })
    setMenuSkill(skill)
  }

  const newSkill = () => {
    setEditing({
      ...emptySkill,
      id: 'custom_' + Date.now(),
      name: '新技能',
      sortOrder: 100 + skills.length,
    })
  }

  const resetDragState = () => {
    setDraggingId('')
    setDragOverId('')
    setDragOverPosition('before')
    dragOverStateRef.current = { id: '', position: 'before' }
  }

  const handleDragStart = (event: React.DragEvent, skillId: string) => {
    const currentOrder = displaySkills.map((skill) => skill.id)
    pendingOrderRef.current = currentOrder
    dragCommittedRef.current = false
    dragOverStateRef.current = { id: '', position: 'before' }
    setOrderedSkillIds(currentOrder)
    setDraggingId(skillId)
    setDragOverId('')
    setDragOverPosition('before')
    setMenuSkill(null)
    setMenuPos(null)

    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', skillId)
  }

  const handleDragOver = (event: React.DragEvent, targetId: string) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'

    if (!draggingId || draggingId === targetId) {
      if (dragOverStateRef.current.id) {
        dragOverStateRef.current = { id: '', position: 'before' }
        setDragOverId('')
      }
      return
    }

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const nextPosition: 'before' | 'after' = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    const current = dragOverStateRef.current

    if (current.id !== targetId || current.position !== nextPosition) {
      dragOverStateRef.current = { id: targetId, position: nextPosition }
      setDragOverId(targetId)
      setDragOverPosition(nextPosition)
    }
  }

  const handleDrop = (event: React.DragEvent, targetId: string) => {
    event.preventDefault()
    event.stopPropagation()

    if (!draggingId || draggingId === targetId) {
      resetDragState()
      return
    }

    const sourceOrder = pendingOrderRef.current.length > 0 ? pendingOrderRef.current : displaySkills.map((skill) => skill.id)
    const withoutDragged = sourceOrder.filter((id) => id !== draggingId)
    const targetIndex = withoutDragged.indexOf(targetId)

    if (targetIndex < 0) {
      resetDragState()
      return
    }

    const insertIndex = dragOverPosition === 'after' ? targetIndex + 1 : targetIndex
    const finalOrder = [...withoutDragged]
    finalOrder.splice(insertIndex, 0, draggingId)
    const finalSignature = finalOrder.join('|')

    pendingOrderRef.current = finalOrder
    setOrderedSkillIds(finalOrder)
    dragCommittedRef.current = true
    resetDragState()

    if (finalOrder.length > 0 && finalSignature !== sortedSkillSignature) {
      onReorder(finalOrder)
    }
  }

  const handleDragEnd = () => {
    if (dragCommittedRef.current) {
      dragCommittedRef.current = false
      return
    }
    resetDragState()
  }

  const renderSkillRow = (skill: Skill) => {
    const isAI = skill.type !== 'builtin'
    const dragClass =
      dragOverId === skill.id && draggingId !== skill.id
        ? (dragOverPosition === 'after' ? ' drag-over-after' : ' drag-over-before')
        : ''
    return (
      <div
        key={skill.id}
        className={'skill-row' + (draggingId === skill.id ? ' dragging' : '') + dragClass}
        draggable
        onDragStart={(event) => handleDragStart(event, skill.id)}
        onDragOver={(event) => handleDragOver(event, skill.id)}
        onDragEnter={(event) => handleDragOver(event, skill.id)}
        onDrop={(event) => handleDrop(event, skill.id)}
        onDragEnd={handleDragEnd}
      >
        <div className="skill-row-drag">⠿</div>
        <span className="skill-row-icon"><SkillIcon iconKey={normalizeIconKey(skill.iconKey)} /></span>
        <div className="skill-row-info">
          <div className="skill-row-name">{skill.name}</div>
          <div className="skill-row-desc">{isAI ? 'AI 技能' : '系统内置'} · {skill.outputMode === 'inline' ? '行内输出' : '弹出窗口'}</div>
        </div>
        <span className={'pill ' + (isAI ? 'purple' : 'system')}>{isAI ? 'AI 技能' : '系统技能'}</span>
        <button className="skill-row-more" onClick={(e) => openMenu(e, skill)}>⋯</button>
      </div>
    )
  }

  return (
    <div className="app-page-inner app-page-inner-skills">
      <div className="page-head">
        <div>
          <h1 className="h1">划词技能</h1>
          <div className="sub">自定义工具条按钮、图标和 Prompt。</div>
        </div>
        <div className="top-actions">
          <button className="btn primary" onClick={newSkill}>＋ 新建技能</button>
        </div>
      </div>

      {toolbarSkills.length > 0 ? (
        <div className="section-card">
          <div className="section-card-header">
            <div className="section-card-title">AI 技能</div>
            <div className="section-card-desc">在划词工具条中显示的技能</div>
          </div>
          <div className="skill-rows">{toolbarSkills.map(renderSkillRow)}</div>
        </div>
      ) : null}

      {moreSkills.length > 0 ? (
        <div className="section-card">
          <div className="section-card-header">
            <div className="section-card-title">更多菜单</div>
            <div className="section-card-desc">在 "..." 中显示的技能</div>
          </div>
          <div className="skill-rows">{moreSkills.map(renderSkillRow)}</div>
        </div>
      ) : null}

      {menuSkill && menuPos ? (
        <div className="skill-menu" ref={menuRef} style={{ left: menuPos.x + 'px', top: menuPos.y + 'px' }}>
          <div className="skill-menu-item" onClick={() => { setEditing({ ...menuSkill }); setMenuSkill(null) }}>编辑技能</div>
          {isCustomSkill(menuSkill) ? (
            <>
              <div className="skill-menu-item" onClick={() => {
                const clone: Skill = { ...menuSkill, id: 'custom_' + Date.now(), name: menuSkill.name + ' (副本)', sortOrder: 1000 + skills.length }
                onSave(clone)
                setMenuSkill(null)
              }}>复制为新技能</div>
              <div className="skill-menu-sep" />
              <div className="skill-menu-item danger" onClick={() => {
                if (window.confirm('确定删除技能「' + menuSkill.name + '」吗？')) onDelete(menuSkill.id)
                setMenuSkill(null)
              }}>删除技能</div>
            </>
          ) : null}
          <div className="skill-menu-sep" />
          <div className="skill-menu-item" onClick={() => {
            const ids = displaySkills.map((s) => s.id)
            const fromIdx = ids.indexOf(menuSkill!.id)
            if (fromIdx > 0) { ids.splice(fromIdx, 1); ids.unshift(menuSkill!.id) }
            onReorder(ids)
            setMenuSkill(null)
          }}>移到最前</div>
          <div className="skill-menu-item" onClick={() => {
            const ids = displaySkills.map((s) => s.id)
            const fromIdx = ids.indexOf(menuSkill!.id)
            if (fromIdx >= 0 && fromIdx < 5) { ids.splice(fromIdx, 1); ids.splice(5, 0, menuSkill!.id) }
            onReorder(ids)
            setMenuSkill(null)
          }}>移到更多菜单</div>
        </div>
      ) : null}

      {editing ? <SkillEditDialog skill={editing} onChange={setEditing} onClose={() => setEditing(null)} onSave={(s) => { onSave(s); setEditing(null) }} /> : null}
    </div>
  )
}

function SkillEditDialog({ skill, onChange, onClose, onSave }: { skill: Skill; onChange: (skill: Skill) => void; onClose: () => void; onSave: (skill: Skill) => void }) {
  const [iconOpen, setIconOpen] = useState(false)
  const [error, setError] = useState('')
  const custom = isCustomSkill(skill)
  const nameCount = Array.from(skill.name).length

  const save = () => {
    if (!skill.name.trim()) { setError('请输入技能名称'); return }
    if (nameCount > 20) { setError('技能名称不能超过 20 个字'); return }
    if (!skill.userPrompt.trim()) { setError('请输入提示词内容'); return }
    onSave(skill)
  }

  const useExample = (prompt: string) => onChange({ ...skill, userPrompt: prompt })

  return (
    <div className="skill-modal-backdrop" onClick={onClose}>
      <motion.div
        className="skill-modal"
        initial={{ opacity: 0, y: 14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="skill-modal-header">
          <div className="skill-modal-title">{custom ? '新建技能' : '编辑技能'}</div>
          <button className="skill-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="skill-modal-body">
          <div className="skill-modal-grid">
            <div className="skill-modal-field">
              <label>技能名称 <span style={{ color: '#ef4444' }}>*</span></label>
              <div className="skill-input-wrap">
                <input maxLength={20} value={skill.name} onChange={(e) => onChange({ ...skill, name: e.target.value })} placeholder="在这里命名你的技能..." />
                <span className="skill-name-count">{nameCount}/20</span>
              </div>
            </div>
            <div className="skill-modal-field skill-icon-field">
              <label>图标</label>
              <button className="skill-icon-trigger" onClick={() => setIconOpen(!iconOpen)} type="button">
                <SkillIcon iconKey={normalizeIconKey(skill.iconKey)} />
              </button>
              {iconOpen ? (
                <div className="skill-icon-popover" onClick={(e) => e.stopPropagation()}>
                  <div className="skill-icon-popover-head">
                    <span>图标</span>
                    <button className="skill-icon-pop-close" onClick={() => setIconOpen(false)} type="button">×</button>
                  </div>
                  <div className="skill-icon-grid">
                    {SKILL_ICON_KEYS.map((key) => (
                      <button
                        key={key}
                        className={'skill-icon-option' + (skill.iconKey === key ? ' active' : '')}
                        onClick={() => { onChange({ ...skill, iconKey: key }); setIconOpen(false) }}
                        type="button"
                        title={key}
                      >
                        <SkillIcon iconKey={key} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="skill-modal-field">
            <label>提示词内容 <span style={{ color: '#ef4444' }}>*</span></label>
            <div className="prompt-help">
              使用特殊字符串 <b>{'{{selection}}'}</b> 代表划选中的文字。点击下面示例可快速填入。
            </div>
            <div className="prompt-examples">
              <button className="prompt-example" onClick={() => useExample('请把下面内容翻译成自然、准确的中文：\n\n{{selection}}')}>翻译成中文</button>
              <button className="prompt-example" onClick={() => useExample('请用通俗易懂的语言解释下面这段内容：\n\n{{selection}}')}>通俗解释</button>
              <button className="prompt-example" onClick={() => useExample('请总结下面内容的核心要点，使用简洁的项目符号：\n\n{{selection}}')}>总结要点</button>
              <button className="prompt-example" onClick={() => useExample('请将下面内容改写成更正式、清晰的学术表达：\n\n{{selection}}')}>学术改写</button>
            </div>
          </div>

          <div className="skill-vars">
            <div className="skill-vars-title">可用变量说明</div>
            <div className="skill-var-row"><code className="skill-var-token">{'{{selection}}'}</code><span>当前划选文本。新建技能时通常必须包含它。</span></div>
            <div className="skill-var-row"><code className="skill-var-token">{'{{ai_result}}'}</code><span>上一轮 AI 结果，用于二次改写、整理或导入。</span></div>
            <div className="skill-var-row"><code className="skill-var-token">{'{{skill_name}}'}</code><span>当前技能名称。</span></div>
            <div className="skill-var-row"><code className="skill-var-token">{'{{model}}'}</code><span>当前使用的模型名称。</span></div>
            <div className="skill-var-row"><code className="skill-var-token">{'{{date}}'}</code><span>当前日期。</span></div>
            <div className="skill-var-row"><code className="skill-var-token">{'{{time}}'}</code><span>当前时间。</span></div>
          </div>

          <div className="skill-modal-field">
            <textarea className="skill-prompt-textarea" value={skill.userPrompt} onChange={(e) => onChange({ ...skill, userPrompt: e.target.value })} placeholder="在此输入或粘贴你的提示词。" />
          </div>

          {error ? <div className="skill-error">{error}</div> : null}
          {!custom ? <div className="skill-system-note">这是内置技能，可以改名称、图标和提示词，但不能删除。</div> : null}
        </div>

        <div className="skill-modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="primary" onClick={save}>保存</button>
        </div>
      </motion.div>
    </div>
  )
}

﻿function ObsidianPanel({ settings, onSave, dataDir, templates }: { settings: Settings; onSave: (settings: Settings) => void; dataDir: string; templates: ObsidianTemplate[] }) {
  const [draft, setDraft] = useState(settings)
  const [localTemplates, setLocalTemplates] = useState<ObsidianTemplate[]>(templates)
  const [selectedId, setSelectedId] = useState<string>(settings.obsidian.activeTemplateId || templates[0]?.id || '')
  const [editing, setEditing] = useState<ObsidianTemplate | null>(null)
  const [previewMd, setPreviewMd] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [showNotePicker, setShowNotePicker] = useState(false)
  const [message, setMessage] = useState('')

  const selected = localTemplates.find((t) => t.id === selectedId)

  const refresh = async (preferredId = selectedId) => {
    const list = await window.desktopApi.getObsidianTemplates()
    setLocalTemplates(list)
    const nextId = preferredId && list.some((t) => t.id === preferredId) ? preferredId : (list[0]?.id || '')
    setSelectedId(nextId)
  }

  const persistActiveTemplate = async (templateId: string) => {
    const nextSettings = { ...draft, obsidian: { ...draft.obsidian, activeTemplateId: templateId } }
    setDraft(nextSettings)
    await onSave(nextSettings)
  }

  const selectTemplate = async (templateId: string) => {
    setSelectedId(templateId)
    setEditing(null)
    setPreviewMd('')
    setPreviewError('')
    await persistActiveTemplate(templateId)
    setMessage('已设为当前使用模板')
  }

  const newTemplate = () => {
    const now = new Date().toISOString()
    setEditing({
      id: newTemplateId(),
      name: '新模板',
      saveBehavior: 'append_to_existing_note_bottom',
      targetNotePath: '',
      contentTemplate: '## {{date}} {{time}} - {{skill_name}}\n\n### 原文\n> {{selection}}\n\n### AI 结果\n{{ai_result}}\n\n模型：{{model}}\n来源：{{source_app}}\n',
      createdAt: now,
      updatedAt: now,
    })
    setPreviewMd('')
    setPreviewError('')
  }

  const editSelected = () => {
    if (selected) setEditing({ ...selected })
  }

  const saveTemplate = async () => {
    if (!editing) return
    if (!editing.name.trim()) { setMessage('请输入模板名称'); return }
    if (!editing.targetNotePath.trim()) { setMessage('请输入目标笔记路径'); return }
    if (!editing.targetNotePath.endsWith('.md')) { setMessage('目标笔记必须是 .md 文件'); return }
    const savedId = editing.id
    await window.desktopApi.saveObsidianTemplate(editing)
    await persistActiveTemplate(savedId)
    setMessage('模板已保存，并设为当前使用模板')
    setEditing(null)
    setPreviewMd('')
    setPreviewError('')
    await refresh(savedId)
  }

  const deleteTemplate = async () => {
    if (!editing) return
    if (localTemplates.length <= 1) { setMessage('至少保留一个模板'); return }
    await window.desktopApi.deleteObsidianTemplate(editing.id)
    const remaining = localTemplates.filter((t) => t.id !== editing.id)
    const nextActiveId = remaining[0]?.id || ''
    await persistActiveTemplate(nextActiveId)
    setMessage('模板已删除')
    setEditing(null)
    setPreviewMd('')
    setPreviewError('')
    await refresh(nextActiveId)
  }

  const doPreview = () => {
    if (!editing) return
    const ctx: Record<string, string> = {
      selection: '这是用户划选的示例原文内容。',
      ai_result: '这是 AI 返回的示例结果。\n\n- 要点一\n- 要点二',
      skill_name: '翻译',
      model: 'deepseek-v4-flash',
      date: new Date().toISOString().slice(0, 10),
      time: new Date().toTimeString().slice(0, 5),
      source_app: 'Windows',
      history_space: '',
    }
    try {
      setPreviewMd(editing.contentTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => ctx[key] ?? ''))
      setPreviewError('')
    } catch (err) {
      setPreviewError(String(err))
      setPreviewMd('')
    }
  }

  const pickedNote = (relativePath: string) => {
    if (editing) setEditing({ ...editing, targetNotePath: relativePath })
    setShowNotePicker(false)
  }

  const handleVaultPathSave = async () => {
    await onSave(draft)
    setMessage('Vault 路径已保存')
  }

  return (
    <div className="obsidian-page">
      <div className="obsidian-head">
        <div>
          <h1>Obsidian 导入</h1>
          <p>把结果直接写入你的 Obsidian vault。</p>
        </div>
      </div>

      <section className="vault-card">
        <div className="vault-card-head">
          <div>
            <h2>Vault 路径</h2>
            <p>选择你的 Obsidian 仓库根目录。</p>
          </div>
        </div>
        <div className="vault-row">
          <input className="vault-input" value={draft.obsidian.vaultPath} onChange={(e) => setDraft({ ...draft, obsidian: { ...draft.obsidian, vaultPath: e.target.value } })} placeholder="例如 C:\Users\你\Documents\ObsidianVault" />
          <button className="browse-btn" onClick={() => {}}>浏览</button>
          <button className="primary" onClick={handleVaultPathSave}>保存</button>
        </div>
      </section>

      <div className="obsidian-layout">
        <aside className="template-pane">
          <div className="template-pane-head">
            <h2>模板</h2>
            <button className="btn primary" onClick={newTemplate}>+ 新建模板</button>
          </div>
          <div className="template-list">
            {localTemplates.length === 0 ? (
              <div className="empty">还没有模板</div>
            ) : (
              localTemplates.map((tpl) => (
                <button key={tpl.id} className={'template-item' + (selectedId === tpl.id ? ' active' : '')} onClick={() => { void selectTemplate(tpl.id) }}>
                  {tpl.name}
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="template-editor-card">
          <div className="template-editor-head">
            <div>
              <h2>模板详情</h2>
              <p>编辑保存路径和 Markdown 模板。</p>
            </div>
          </div>

          {!selected && !editing ? (
            <div className="empty">选择一个模板开始编辑</div>
          ) : null}

          {selected && !editing ? (
            <div className="template-form">
              <div className="form-row">
                <label>名称</label>
                <div className="form-value">{selected.name}</div>
              </div>
              <div className="form-row">
                <label>保存方式</label>
                <div className="form-value">{selected.saveBehavior === 'append_to_existing_note_bottom' ? '追加到末尾' : '追加到开头'}</div>
              </div>
              <div className="form-row">
                <label>目标笔记</label>
                <div className="form-value">{selected.targetNotePath || '未设置'}</div>
              </div>
              <div className="form-row">
                <label>模板预览</label>
                <pre className="template-preview">{selected.contentTemplate.slice(0, 200)}{selected.contentTemplate.length > 200 ? '...' : ''}</pre>
              </div>
              <div className="obsidian-actions">
                <button className="btn primary" onClick={editSelected}>编辑模板</button>
              </div>
            </div>
          ) : null}

          {editing ? (
            <div className="template-form">
              <div className="form-row">
                <label>模板名称</label>
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例如：英语学习笔记" />
              </div>
              <div className="form-row">
                <label>保存方式</label>
                <div className="radio-group">
                  <label className="radio-label"><input type="radio" name="saveBehavior" checked={editing.saveBehavior === 'append_to_existing_note_bottom'} onChange={() => setEditing({ ...editing, saveBehavior: 'append_to_existing_note_bottom' })} /> 追加到已有笔记末尾</label>
                  <label className="radio-label"><input type="radio" name="saveBehavior" checked={editing.saveBehavior === 'append_to_existing_note_top'} onChange={() => setEditing({ ...editing, saveBehavior: 'append_to_existing_note_top' })} /> 追加到已有笔记开头</label>
                </div>
              </div>
              <div className="form-row">
                <label>目标笔记路径</label>
                <div className="path-input-wrap">
                  <input value={editing.targetNotePath} onChange={(e) => setEditing({ ...editing, targetNotePath: e.target.value })} placeholder="例如 英语/台词学习.md" />
                  <button className="browse-btn" onClick={() => setShowNotePicker(true)}>浏览</button>
                </div>
              </div>
              <div className="form-row">
                <label>变量 token</label>
                <div className="token-row">
                  {['{{selection}}', '{{ai_result}}', '{{skill_name}}', '{{model}}', '{{date}}', '{{time}}', '{{source_app}}', '{{history_space}}'].map((t) => (
                    <span key={t} className="token">{t}</span>
                  ))}
                </div>
              </div>
              <div className="form-row">
                <label>内容模板</label>
                <textarea className="template-textarea" value={editing.contentTemplate} onChange={(e) => setEditing({ ...editing, contentTemplate: e.target.value })} placeholder="输入 Markdown 模板..." />
              </div>

              <div className="obsidian-actions">
                <button className="btn primary" onClick={doPreview}>预览</button>
                <button className="btn primary" onClick={saveTemplate}>保存模板</button>
                <button className="btn danger" onClick={deleteTemplate}>删除</button>
              </div>

              {previewMd ? (
                <div className="preview-box">
                  <div className="preview-box-label">Markdown 预览</div>
                  <pre className="preview-content">{previewMd}</pre>
                </div>
              ) : null}
              {previewError ? <div className="obsidian-error">{previewError}</div> : null}
            </div>
          ) : null}
        </section>
      </div>

      {message ? <div className="inline-message">{message}</div> : null}
      <p className="subtle">本地数据目录：{dataDir}</p>
      {showNotePicker ? <VaultNotePicker vaultPath={draft.obsidian.vaultPath} onPick={pickedNote} onClose={() => setShowNotePicker(false)} /> : null}
    </div>
  )
}
function VaultNotePicker({ vaultPath, onPick, onClose }: { vaultPath: string; onPick: (path: string) => void; onClose: () => void }) {
  const [notes, setNotes] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    setLoading(true)
    window.desktopApi.listVaultNotes().then((list) => {
      setNotes(list)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const filtered = search.trim() ? notes.filter((n) => n.toLowerCase().includes(search.toLowerCase())) : notes

  return (
    <div className="modal-backdrop">
      <div className="vault-picker-modal">
        <header><strong>选择笔记</strong><button onClick={onClose}>×</button></header>
        {!vaultPath.trim() ? (
          <div className="vault-picker-empty">请先在 Obsidian 设置中配置 Vault 路径。</div>
        ) : loading ? (
          <div className="vault-picker-empty">加载中...</div>
        ) : notes.length === 0 ? (
          <div className="vault-picker-empty">Vault 中未找到 .md 文件。</div>
        ) : (
          <>
            <input className="search" placeholder="搜索笔记..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="vault-note-list">
              {filtered.map((note) => <button key={note} className="vault-note-row" onClick={() => onPick(note)}>{note}</button>)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ToolbarView() {
  const [selection, setSelection] = useState('')
  const [skills, setSkills] = useState<Skill[]>([])
  const [busySkill, setBusySkill] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Keep the floating toolbar BrowserWindow visually transparent.
    // This prevents the enlarged tooltip area from showing a gray rectangular backing.
    document.documentElement.style.background = 'rgba(0,0,0,0)'
    document.documentElement.style.backgroundColor = 'rgba(0,0,0,0)'
    document.documentElement.style.margin = '0'
    document.documentElement.style.padding = '0'
    document.documentElement.style.overflow = 'visible'
    document.documentElement.style.width = 'max-content'

    document.body.style.background = 'rgba(0,0,0,0)'
    document.body.style.backgroundColor = 'rgba(0,0,0,0)'
    document.body.style.margin = '0'
    document.body.style.padding = '0'
    document.body.style.overflow = 'visible'
    document.body.style.width = 'max-content'

    const root = document.getElementById('root')
    if (root) {
      root.style.background = 'rgba(0,0,0,0)'
      root.style.backgroundColor = 'rgba(0,0,0,0)'
      root.style.margin = '0'
      root.style.padding = '0'
      root.style.overflow = 'visible'
      root.style.width = 'max-content'
    }
    window.desktopApi.getInitialData().then((data) => setSkills(data.toolbarSkills))

    // Visibility toggle — near-instant CSS transition
    const offShow = window.desktopApi.onToolbarShow(() => {
      if (window.desktopApi.rendererLog) window.desktopApi.rendererLog('[PERF] renderer toolbar:show at=' + Date.now());
      setVisible(true)
    })
    const offHide = window.desktopApi.onToolbarHide(() => {
      setVisible(false)
      setMoreOpen(false)
    })
    const offMoreState = window.desktopApi.onToolbarMoreState((payload) => {
      setMoreOpen(Boolean(payload.open))
    })
    const offSelection = window.desktopApi.onSelectionReady((payload: any) => {
      if (window.desktopApi.rendererLog) window.desktopApi.rendererLog('[PERF] renderer selection:ready at=' + Date.now() + ' attemptId=' + (payload as any).attemptId);
      setSelection(payload.selection)
      setSkills(payload.skills)
      setBusySkill('')
      setMoreOpen(false)
    })
    const offSkills = window.desktopApi.onSkillsUpdated((payload) => {
      setSkills(payload.toolbarSkills)
      setMoreOpen(false)
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMoreOpen(false)
        window.desktopApi.hideToolbar()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      offShow()
      offHide()
      offMoreState()
      offSelection()
      offSkills()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const run = async (skillId: string) => {
    setBusySkill(skillId)
    setMoreOpen(false)
    await window.desktopApi.hideToolbarMore()
    await window.desktopApi.runSkill(skillId, selection)
    setBusySkill('')
  }
  const actions = buildToolbarActions(skills, selection)
  const actionSignature = actions.map((action) => action.id).join('|')
  useEffect(() => {
    if (dragRef.current.active) return
    const frame = requestAnimationFrame(() => {
      const rect = toolbarRef.current?.getBoundingClientRect()
      if (!rect) return
      window.desktopApi.setToolbarSize({
        width: Math.ceil(rect.width + TOOLBAR_WINDOW_SIDE_PADDING),
        height: Math.ceil(rect.height + TOOLBAR_TOOLTIP_TOP_SPACE + 2),
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [actionSignature, busySkill, visible, moreOpen])

  const toggleMore = async () => {
    const result = await window.desktopApi.toggleToolbarMore()
    setMoreOpen(Boolean(result.open))
  }
  // ─── drag state ───
  const dragRef = useRef({
    active: false,
    sx: 0,
    sy: 0,
    width: 0,
    height: 0,
    raf: 0,
    pending: null as null | { x: number; y: number },
  })
  const toolbarShellRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)

  const onGripDown = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    await window.desktopApi.hideToolbarMore()
    const bounds = await window.desktopApi.getToolbarBounds()
    if (!bounds) return

    // Bounds are the real BrowserWindow bounds. The visible toolbar starts below the transparent
    // tooltip breathing room, so drag against the visible toolbar coordinates instead.
    const visualX = bounds.x
    const visualY = bounds.y + TOOLBAR_TOOLTIP_TOP_SPACE
    const fixedRect = toolbarRef.current?.getBoundingClientRect()
    dragRef.current = {
      active: true,
      sx: e.screenX - visualX,
      sy: e.screenY - visualY,
      width: fixedRect?.width || bounds.width,
      height: fixedRect?.height || Math.max(1, bounds.height - TOOLBAR_TOOLTIP_TOP_SPACE),
      raf: 0,
      pending: null,
    }

    const flushPosition = () => {
      const pending = dragRef.current.pending
      dragRef.current.raf = 0
      if (!dragRef.current.active || !pending) return
      window.desktopApi.setToolbarPosition(pending)
    }

    const schedulePosition = (x: number, y: number) => {
      dragRef.current.pending = { x, y }
      if (!dragRef.current.raf) {
        dragRef.current.raf = window.requestAnimationFrame(flushPosition)
      }
    }

    const onMove = (me: MouseEvent) => {
      if (!dragRef.current.active) return
      schedulePosition(me.screenX - dragRef.current.sx, me.screenY - dragRef.current.sy)
    }
    const onUp = (me: MouseEvent) => {
      if (dragRef.current.raf) {
        window.cancelAnimationFrame(dragRef.current.raf)
        dragRef.current.raf = 0
      }
      window.desktopApi.setToolbarPosition({
        x: me.screenX - dragRef.current.sx,
        y: me.screenY - dragRef.current.sy,
      })
      dragRef.current.active = false
      dragRef.current.pending = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.desktopApi.setToolbarPointerInside(true)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <Toolbar
      actions={actions}
      busySkill={busySkill}
      moreOpen={moreOpen}
      visible={visible}
      toolbarRef={toolbarRef}
      shellRef={toolbarShellRef}
      onRunSkill={run}




      onMore={toggleMore}
      onGripDown={onGripDown}
      onPointerEnter={() => window.desktopApi.setToolbarPointerInside(true)}
      onPointerLeave={() => window.desktopApi.setToolbarPointerInside(false)}
    />
  )
}

function ToolbarMoreView() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [busySkill, setBusySkill] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    window.desktopApi.getInitialData().then((data) => setSkills(data.skills))
    const offState = window.desktopApi.onToolbarMoreState((payload) => {
      setOpen(Boolean(payload.open))
    })
    const offSelection = window.desktopApi.onSelectionReady((payload: any) => {
      if (Array.isArray(payload.allSkills)) setSkills(payload.allSkills)
    })
    const offSkills = window.desktopApi.onSkillsUpdated((payload) => {
      setSkills(payload.allSkills)
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.desktopApi.hideToolbar()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      offState()
      offSelection()
      offSkills()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const moreSkills = buildMoreMenuSkills(skills, '')
  const run = (skillId: string) => {
    setBusySkill(skillId)
    // Do not destroy toolbarMoreWindow before dispatching runSkill.
    // In the destroy-on-hide lifecycle, hideToolbarMore() destroys this renderer window.
    // If we await it first, the following runSkill() never gets sent and the result card will not appear.
    void window.desktopApi.runSkill(skillId).catch((error) => {
      console.error('[ToolbarMore] runSkill failed', error)
      setBusySkill('')
    })
  }

  return (
    <MoreMenu
      skills={moreSkills}
      busySkill={busySkill}
      open={open}
      onRunSkill={run}
      onSettings={() => { void window.desktopApi.showMain() }}
      onPointerEnter={() => window.desktopApi.setToolbarMorePointerInside(true)}
      onPointerLeave={() => window.desktopApi.setToolbarMorePointerInside(false)}
    />
  )
}

function ResultView() {
  const [record, setRecord] = useState<HistoryRecord | null>(null)
  const [sourceExpanded, setSourceExpanded] = useState(false)
  const [footerMoreOpen, setFooterMoreOpen] = useState(false)
  const [resultTemplates, setResultTemplates] = useState<ObsidianTemplate[]>([])
  const [resultTemplateId, setResultTemplateId] = useState('')
  const [status, setStatus] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [confirmSkillId, setConfirmSkillId] = useState('')
  const runIdRef = useRef('')
  const renderTiming = useRef<{ readyAt: number; firstUpdateAt: number; firstPaintAt: number; updateCount: number; doneAt: number; timer: any }>({ readyAt: 0, firstUpdateAt: 0, firstPaintAt: 0, updateCount: 0, doneAt: 0, timer: null })
  const resultCardRef = useRef<HTMLDivElement>(null)
  const resultDragRef = useRef({ active: false, startX: 0, startY: 0, winX: 0, winY: 0 })
  const { activeTtsKey, toggleDesktopSpeak } = useDesktopTts()

  useEffect(() => {
    window.desktopApi.getInitialData().then((data) => {
      const templates = data.obsidianTemplates || []
      setResultTemplates(templates)
      const preferred = data.settings.obsidian.activeTemplateId
      setResultTemplateId(templates.some((item) => item.id === preferred) ? (preferred || '') : (templates[0]?.id || ''))
    })
  }, [])

  useEffect(() => {
    const offReady = window.desktopApi.onResultReady((next) => {
      runIdRef.current = next.runId || ''
      renderTiming.current = { readyAt: Date.now(), firstUpdateAt: 0, firstPaintAt: 0, updateCount: 0, doneAt: 0, timer: null }
      if (window.desktopApi.rendererLog) window.desktopApi.rendererLog('[RenderTiming] result:ready runId=' + next.runId); console.log('[RenderTiming] result:ready runId=' + next.runId)
      setRecord(next)
      setSourceExpanded(false)
      setFooterMoreOpen(false)
    })
    const offUpdate = window.desktopApi.onResultUpdate((next) => {
      if (next.runId !== undefined && next.runId !== runIdRef.current) {
        console.log('[Result] update ignored stale runId=' + next.runId + ' currentRunId=' + runIdRef.current);
        return
      }
      var t = renderTiming.current;
      t.updateCount++;
      if (t.firstUpdateAt === 0) {
        t.firstUpdateAt = Date.now();
        if (window.desktopApi.rendererLog) window.desktopApi.rendererLog('[RenderTiming] first result:update received runId=' + runIdRef.current + ' delayFromReady=' + (t.firstUpdateAt - t.readyAt) + 'ms'); console.log('[RenderTiming] first result:update received runId=' + runIdRef.current + ' delayFromReady=' + (t.firstUpdateAt - t.readyAt) + 'ms');
        if (t.timer === null) {
          t.timer = setInterval(function() {
            var rt = renderTiming.current;
            if (window.desktopApi.rendererLog) window.desktopApi.rendererLog('[RenderTiming] 500ms stats runId=' + runIdRef.current + ' updates=' + rt.updateCount + ' elapsed=' + (Date.now() - rt.readyAt) + 'ms'); console.log('[RenderTiming] 500ms stats runId=' + runIdRef.current + ' updates=' + rt.updateCount + ' elapsed=' + (Date.now() - rt.readyAt) + 'ms');
          }, 500);
        }
      }
      setRecord(next)
      if (t.firstUpdateAt > 0 && t.firstPaintAt === 0) {
        requestAnimationFrame(function() {
          var rt = renderTiming.current;
          if (rt.firstPaintAt === 0) {
            rt.firstPaintAt = Date.now();
            if (window.desktopApi.rendererLog) window.desktopApi.rendererLog('[RenderTiming] first paint after update runId=' + runIdRef.current + ' delayFromUpdate=' + (rt.firstPaintAt - rt.firstUpdateAt) + 'ms'); console.log('[RenderTiming] first paint after update runId=' + runIdRef.current + ' delayFromUpdate=' + (rt.firstPaintAt - rt.firstUpdateAt) + 'ms');
          }
        });
      }
    })
    const offConfirm = window.desktopApi.onConfirmSelection((payload) => {
      setRecord(payload.record)
      setConfirmText(payload.record.selectedText)
      setConfirmSkillId(payload.skillId)
    })
    const offReset = window.desktopApi.onResultReset(() => {
      if (window.desktopApi.rendererLog) window.desktopApi.rendererLog('[RenderTiming] result:reset prevRunId=' + runIdRef.current); console.log('[RenderTiming] result:reset prevRunId=' + runIdRef.current);
      if (renderTiming.current.timer) { clearInterval(renderTiming.current.timer); renderTiming.current.timer = null; }
      runIdRef.current = ''
      setRecord(null)
      setSourceExpanded(false)
      setFooterMoreOpen(false)
    })
    return () => {
      offReady()
      offUpdate()
      offConfirm()
      offReset()
    }
  }, [])


  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.desktopApi.closeResult('escape')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!record) return <div className="result-card empty-result">等待划词结果...</div>

  const resultTtsKey = `result:${record.id || record.runId || runIdRef.current || 'current'}:answer`
  const resultSpeaking = activeTtsKey === resultTtsKey

  const copy = async () => {
    await window.desktopApi.copyText(record.answerMarkdown)
  }
  const exportObsidian = async () => {
    try {
      const templateId = resultTemplateId || resultTemplates[0]?.id
      if (!templateId) throw new Error('没有可用的 Obsidian 模板')
      const result = await window.desktopApi.saveToObsidianNote(templateId, record.id, record)
      setStatus(`已保存：${result.path}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }
  const startResultDrag = async (event: ReactMouseEvent) => {
    const target = event.target as HTMLElement
    if (target.closest('button')) return
    event.preventDefault()
    event.stopPropagation()
    window.desktopApi.setResultPointerInside(true)
    window.desktopApi.lockResultInteraction(3000)
    window.desktopApi.setResultState('dragging_result')
    const bounds = await window.desktopApi.getResultBounds()
    if (!bounds) return
    resultDragRef.current = {
      active: true,
      startX: event.screenX,
      startY: event.screenY,
      winX: bounds.x,
      winY: bounds.y,
    }
    const onMove = (moveEvent: MouseEvent) => {
      if (!resultDragRef.current.active) return
      window.desktopApi.lockResultInteraction(900)
      window.desktopApi.setResultPosition({
        x: resultDragRef.current.winX + moveEvent.screenX - resultDragRef.current.startX,
        y: resultDragRef.current.winY + moveEvent.screenY - resultDragRef.current.startY,
      })
    }
    const onUp = () => {
      resultDragRef.current.active = false
      window.desktopApi.lockResultInteraction(900)
      window.desktopApi.setResultState('result_visible')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12 }}
      onMouseEnter={() => window.desktopApi.setResultPointerInside(true)}
      onMouseLeave={() => {
        window.desktopApi.setResultPointerInside(false)
        window.desktopApi.lockResultInteraction(350)
      }}
      onMouseDown={() => {
        window.desktopApi.lockResultInteraction(900)
      }}
      onPointerDown={() => {
        window.desktopApi.lockResultInteraction(900)
      }}
    >
      <ResultCardChrome
        cardRef={resultCardRef}
        title={`${record.skillName}`}
        subtitle={record.model}
        status={record.status}
        sourceExpanded={sourceExpanded}
        selectedText={record.selectedText}
        onToggleSource={() => setSourceExpanded((value) => !value)}
        onClose={() => window.desktopApi.closeResult('close-button')}
        onHeaderMouseDown={startResultDrag}
        onPointerEnter={() => window.desktopApi.setResultPointerInside(true)}
        onPointerLeave={() => {
          window.desktopApi.setResultPointerInside(false)
          window.desktopApi.lockResultInteraction(350)
        }}
        onPointerDown={() => window.desktopApi.lockResultInteraction(900)}
        footer={(
          <>
            <div className="result-obsidian-row">
              <button onClick={exportObsidian}><span>◇</span>保存到 Obsidian</button>
            </div>
            <button onClick={copy}><span>⧉</span>复制</button>
            <button onClick={() => void toggleDesktopSpeak(record.answerMarkdown, resultTtsKey)}><span>◖</span>{resultSpeaking ? '停止' : '朗读'}</button>
            <button onClick={() => window.desktopApi.runSkill(record.skillId, record.selectedText)}><span>↻</span>重新生成</button>
            <div className="result-footer-spacer" />
            <div className="result-footer-more">
              <button className="result-footer-more-button" onClick={() => setFooterMoreOpen((value) => !value)} aria-label="更多操作">•••</button>
              {footerMoreOpen ? (
                <div className="result-footer-menu">
                  <div className="result-footer-menu-label">选择 Obsidian 模板</div>
                  {resultTemplates.length > 0 ? resultTemplates.map((template) => (
                    <button
                      key={template.id}
                      className={template.id === resultTemplateId ? 'active' : ''}
                      onClick={() => {
                        setResultTemplateId(template.id)
                        setFooterMoreOpen(false)
                        setStatus(`已选择模板：${template.name}`)
                      }}
                    >
                      <span>{template.name}</span>
                      {template.id === resultTemplateId ? <b>✓</b> : null}
                    </button>
                  )) : <div className="result-footer-menu-empty">暂无模板</div>}
                </div>
              ) : null}
            </div>
          </>
        )}
        statusLine={status}
      >
        {record.status === 'confirming' ? (
          <section className="answer-box confirm-box">
            <p className="confirm-hint">检测到字幕可能复制了整句，点击词块选择要处理的内容：</p>
            <WordChipSelector
              text={confirmText}
              onChange={(selected) => setConfirmText(selected)}
            />
            <div className="confirm-actions">
              <button onClick={() => {
                window.desktopApi.cancelSelection()
              }}>取消</button>
              <button className="primary" onClick={async () => {
                const result = await window.desktopApi.confirmSelection(confirmSkillId, confirmText.trim())
                if (result) setRecord(result)
              }} disabled={!confirmText.trim()}>确认处理 ({confirmText.trim().split(/\s+/).length}词)</button>
            </div>
          </section>
        ) : (
        <section className={record.status === 'failed' ? 'answer-box failed' : 'answer-box'}>
          {record.pronunciationData ? <PronunciationCard data={record.pronunciationData} answer={record.answerMarkdown} status={record.status} /> : null}
          {!record.pronunciationData && record.answerMarkdown ? <MarkdownView text={record.answerMarkdown} /> : null}
          {!record.pronunciationData && !record.answerMarkdown ? <TypingDots /> : null}
        </section>
        )}
      </ResultCardChrome>
    </motion.div>
  )
}

/* ───── 发音卡片 ───── */

function PronunciationCard({ data, answer, status }: { data: PronunciationData; answer: string; status: string }) {
  const [speakingLang, setSpeakingLang] = useState<'' | 'en-US' | 'en-GB'>('')

  useEffect(() => {
    return () => {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    }
  }, [])

  const handlePlay = (e: React.MouseEvent, lang: 'en-US' | 'en-GB') => {
    e.preventDefault()
    e.stopPropagation()

    if (speakingLang === lang && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel()
      setSpeakingLang('')
      return
    }

    void window.desktopApi.stopSpeak()
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(data.text)
    utterance.lang = lang
    utterance.rate = lang === 'en-GB' ? 0.95 : 1.0
    utterance.onend = () => setSpeakingLang('')
    utterance.onerror = () => setSpeakingLang('')
    setSpeakingLang(lang)
    window.speechSynthesis.speak(utterance)
  }

  const isRunning = status === 'running'

  return (
    <div className="pronunciation-card" onMouseDown={(e) => e.stopPropagation()}>
      {data.mode === 'word' ? (
        <>
          <h3 className="pron-word">{data.text}</h3>
          <div className="pron-chips">
            <button className="pron-chip" onClick={(e) => handlePlay(e, 'en-US')} disabled={isRunning}>
              {speakingLang === 'en-US' ? 'US 停止' : <>US {data.us_ipa ? <span className="pron-ipa">/{data.us_ipa}/</span> : null} 🔊</>}
            </button>
            <button className="pron-chip" onClick={(e) => handlePlay(e, 'en-GB')} disabled={isRunning}>
              {speakingLang === 'en-GB' ? 'GB 停止' : <>GB {data.gb_ipa ? <span className="pron-ipa">/{data.gb_ipa}/</span> : null} 🔊</>}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="pron-sentence">{data.text}</p>
          <div className="pron-chips">
            <button className="pron-chip" onClick={(e) => handlePlay(e, 'en-US')} disabled={isRunning}>{speakingLang === 'en-US' ? 'US 停止' : 'US 朗读句子 🔊'}</button>
            <button className="pron-chip" onClick={(e) => handlePlay(e, 'en-GB')} disabled={isRunning}>{speakingLang === 'en-GB' ? 'GB 停止' : 'GB 朗读句子 🔊'}</button>
          </div>
        </>
      )}
      {answer ? <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown></div> : null}
      {isRunning && !answer ? <TypingDots /> : null}
    </div>
  )
}

/* ───── 词块选择器 ───── */

function WordChipSelector({ text, onChange }: { text: string; onChange: (s: string) => void }) {
  const tokens = useMemo(() => text.trim().split(/(\s+)/).filter(Boolean).map((t, i) => ({
    index: i, text: t, isPunct: /^[.,!?;:'"()\-—]+$/.test(t), isSpace: /^\s+$/.test(t),
  })), [text])

  const wordTokens = tokens.filter((t) => !t.isSpace && !t.isPunct)
  const [selectedSet, setSelectedSet] = useState<Set<number>>(() => new Set(wordTokens.map((t) => t.index)))
  const [dragStart, setDragStart] = useState<number | null>(null)
  const [dragDirection, setDragDirection] = useState<'select' | 'deselect'>('select')

  const toggleWord = (idx: number) => {
    setSelectedSet((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }

  const selectRange = (from: number, to: number, mode: 'select' | 'deselect') => {
    const start = Math.min(from, to)
    const end = Math.max(from, to)
    setSelectedSet((prev) => {
      const next = new Set(prev)
      for (const t of wordTokens) {
        if (t.index >= start && t.index <= end) {
          if (mode === 'select') next.add(t.index); else next.delete(t.index)
        }
      }
      return next
    })
  }

  useEffect(() => {
    const selectedWords = wordTokens.filter((t) => selectedSet.has(t.index)).map((t) => t.text)
    onChange(selectedWords.join(' '))
  }, [selectedSet])

  return (
    <div className="word-chip-area" onMouseUp={() => setDragStart(null)}>
      {tokens.map((t) => {
        if (t.isSpace) return <span key={t.index}> </span>
        if (t.isPunct) return <span key={t.index} className="word-chip-punct">{t.text} </span>
        const sel = selectedSet.has(t.index)
        return (
          <button
            key={t.index}
            className={sel ? 'word-chip selected' : 'word-chip'}
            onClick={() => toggleWord(t.index)}
            onDoubleClick={() => { setSelectedSet(new Set([t.index])) }}
            onMouseDown={(e) => {
              if (e.shiftKey) {
                e.preventDefault()
                const lastIdx = [...selectedSet].pop() ?? wordTokens[0]?.index ?? 0
                selectRange(lastIdx, t.index, e.ctrlKey ? 'deselect' : 'select')
              } else {
                setDragStart(t.index)
                setDragDirection(sel ? 'deselect' : 'select')
              }
            }}
            onMouseEnter={() => {
              if (dragStart === null) return
              if (dragStart !== t.index) selectRange(dragStart, t.index, dragDirection)
            }}
          >{t.text}</button>
        )
      })}
    </div>
  )
}

function TypingDots() {
  return <div className="typing-placeholder"><i></i><i></i><i></i></div>
}

function normalizeMarkdownText(text: string) {
  return String(text || '')
    .replace(/\\\*\\\*/g, '**')
    .replace(/＊＊/g, '**')
}

function MarkdownView({ text }: { text: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdownText(text)}</ReactMarkdown></div>
}
function normalizeIconKey(iconKey: string | undefined): string {
  return SKILL_ICON_KEYS.includes(iconKey as any) ? iconKey! : 'spark'
}
