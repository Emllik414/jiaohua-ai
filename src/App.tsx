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
}

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
      speak: (text: string) => Promise<{ ok: boolean }>
      stopSpeak: () => Promise<{ ok: boolean }>
      showMain: () => Promise<{ ok: boolean }>
      closeCurrent: () => Promise<{ ok: boolean }>
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

const emptySkill: Skill = {
  id: 'custom_skill',
  name: '自定义',
  icon: '自',
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

export default function App() {
  const route = routeName()
  if (route === 'toolbar') return <ToolbarView />
  if (route === 'toolbar-more') return <ToolbarMoreView />
  if (route === 'result') return <ResultView />
  return <MainView />
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
        <aside className="soft-sidebar">
          <div className="brand">
            <img className="brand-mark" src={brandImg} alt="" />
            <div><h1>饺划-AI划词助手</h1><p>Selection Copilot</p></div>
          </div>
          <nav>
            {[
              ['history', '历史'],
              ['settings', 'API'],
              ['skills', '技能'],
              ['obsidian', 'Obsidian'],
            ].map(([id, label]) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id as typeof tab)}>{label}</button>
            ))}
          </nav>
          <HotkeyCard />
        </aside>

        <main className="main-panel">
          <header className="topbar">
            <div><h2>{tabTitle(tab)}</h2><p>{tabSubtitle(tab)}</p></div>
            {message ? <span className="toast">{message}</span> : null}
          </header>
          {tab === 'history' && <HistoryPanel history={data.history} conversations={data.conversations} activeConversationId={data.activeConversationId} onRefresh={refreshConversations} templates={data.obsidianTemplates} activeTemplateId={data.settings.obsidian.activeTemplateId} />}
          {tab === 'settings' && <ApiPanel />}
          {tab === 'skills' && <SkillsPanel skills={data.skills} onSave={saveSkill} onDelete={deleteSkill} onReorder={reorderSkills} />}
          {tab === 'obsidian' && <ObsidianPanel settings={data.settings} onSave={saveSettings} dataDir={data.dataDir} templates={data.obsidianTemplates} />}
        </main>
      </div>
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

function HistoryPanel({ history, conversations, activeConversationId, onRefresh, templates, activeTemplateId }: { history: HistoryRecord[]; conversations: Conversation[]; activeConversationId: string; onRefresh: () => void; templates: ObsidianTemplate[]; activeTemplateId?: string }) {
  const [filter, setFilter] = useState('')
  const [convSearch, setConvSearch] = useState('')
  const [message, setMessage] = useState('')
  const [editingConvId, setEditingConvId] = useState('')
  const [editingConvTitle, setEditingConvTitle] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

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

  const selectAll = () => { setSelectedIds(new Set(convRecords.map((r) => r.id))) }
  const deselectAll = () => { setSelectedIds(new Set()) }

  const selectedRecords = useMemo(() => convRecords.filter((r) => selectedIds.has(r.id)), [convRecords, selectedIds])

  const importToObsidian = async (records: HistoryRecord[]) => {
    if (records.length === 0) { setMessage('没有可导入的记录'); return }
    let ok = 0, fail = 0
    for (const r of records) {
      try {
        await saveRecordToActiveObsidian(r)
        ok++
      } catch { fail++ }
    }
    setMessage(`已导入 ${ok} 条${fail > 0 ? `，${fail} 条失败` : ''}`)
  }

  const importAllToObsidian = () => importToObsidian(convRecords)
  const importSelectedToObsidian = () => importToObsidian(selectedRecords)
  const deleteSingle = async (id: string) => { await window.desktopApi.deleteHistory([id]); onRefresh() }
  const deleteSelected = async () => { if (selectedIds.size) { await window.desktopApi.deleteHistory([...selectedIds]); onRefresh() } }

  return (
    <div className="conversations-layout">
      {/* ───── 左侧对话列表 ───── */}
      <aside className="conv-sidebar">
        <input className="search" placeholder="搜索对话..." value={convSearch} onChange={(e) => setConvSearch(e.target.value)} />
        <button className="primary" onClick={async () => {
          await window.desktopApi.createConversation('')
          onRefresh()
        }}>+ 新对话</button>
        <div className="conv-list">
          {sortedConvs.map((conv) => (
            <ConversationItem
              key={conv.id}
              conv={conv}
              active={conv.id === activeConversationId}
              editing={editingConvId === conv.id}
              editTitle={editingConvTitle}
              onSelect={async () => {
                await window.desktopApi.setActiveConversation(conv.id)
                onRefresh()
              }}
              onEditStart={(title) => { setEditingConvId(conv.id); setEditingConvTitle(title) }}
              onEditConfirm={async () => {
                await window.desktopApi.renameConversation(conv.id, editingConvTitle)
                setEditingConvId('')
                onRefresh()
              }}
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
      </aside>

      {/* ───── 右侧对话内容 ───── */}
      <div className="conv-content">
          <div className="conv-header">
            <h3>{activeConv?.title || '历史记录'}</h3>
            <span>{convRecords.length} 条记录</span>
            <div className="conv-header-actions">
              <button onClick={() => setExpandedIds(new Set())}>全部折叠</button>
              <button onClick={() => {
                const latest = convRecords[0]
                if (latest) setExpandedIds(new Set([latest.id]))
              }}>展开最新</button>
            </div>
          </div>
          {message ? <div className="inline-message">{message}</div> : null}
          <div className="history-toolbar">
            <input className="search" placeholder="搜索当前对话..." value={filter} onChange={(e) => setFilter(e.target.value)} />
            {!selectMode ? (
              <div className="history-toolbar-actions">
                <button onClick={enterSelectMode}>选择</button>
                {activeTpl ? (
                  <div className="tpl-selector">
                    <button className="tpl-chip" onClick={() => setTplOpen(!tplOpen)}>
                      <span className="tpl-label">模板</span>
                      <span className="tpl-name">{activeTpl.name}</span>
                      <span className={`tpl-arrow${tplOpen ? ' open' : ''}`}>▾</span>
                    </button>
                    {tplOpen ? (
                      <div className="tpl-dropdown">
                        {templates.map((t) => (
                          <button key={t.id} className={t.id === activeTpl.id ? 'tpl-item active' : 'tpl-item'} onClick={() => switchTemplate(t.id)}>
                            {t.id === activeTpl.id ? '✓ ' : ''}{t.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <button className="obsidian-import-btn" onClick={importAllToObsidian} disabled={convRecords.length === 0}>全部导入到 Obsidian</button>
              </div>
            ) : (
              <div className="history-toolbar-actions select-mode-bar">
                <span className="selected-count">已选择 {selectedIds.size} 条</span>
                <button onClick={selectAll}>全选</button>
                <button onClick={deselectAll}>取消选择</button>
                {activeTpl ? (
                  <div className="tpl-selector">
                    <button className="tpl-chip" onClick={() => setTplOpen(!tplOpen)}>
                      <span className="tpl-label">模板</span>
                      <span className="tpl-name">{activeTpl.name}</span>
                      <span className={`tpl-arrow${tplOpen ? ' open' : ''}`}>▾</span>
                    </button>
                    {tplOpen ? (
                      <div className="tpl-dropdown">
                        {templates.map((t) => (
                          <button key={t.id} className={t.id === activeTpl.id ? 'tpl-item active' : 'tpl-item'} onClick={() => switchTemplate(t.id)}>
                            {t.id === activeTpl.id ? '✓ ' : ''}{t.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <button className="obsidian-import-btn" onClick={importSelectedToObsidian} disabled={selectedIds.size === 0}>导入选中到 Obsidian</button>
                <button onClick={() => { if (confirm(`确定删除选中的 ${selectedIds.size} 条记录吗？`)) { deleteSelected(); exitSelectMode() } }} disabled={selectedIds.size === 0}>删除选中</button>
                <button onClick={exitSelectMode}>退出选择</button>
              </div>
            )}
          </div>
          <div className="history-list">
            {convRecords.length === 0 ? <div className="empty">选择文字后，AI 结果会保存到这个对话。</div> : null}
            <DateGroupedRecords
              items={convRecords}
              expandedIds={expandedIds}
              toggleExpand={(id) => setExpandedIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })}
              selectMode={selectMode}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelectId}
              onDelete={selectMode ? undefined : deleteSingle}
            />
          </div>
      </div>
    </div>
  )
}

/* ───── 对话列表项 ───── */

function ConversationItem({ conv, active, editing, editTitle, onSelect, onEditStart, onEditConfirm, onPin, onDelete }: {
  conv: Conversation; active: boolean; editing: boolean; editTitle: string;
  onSelect: () => void; onEditStart: (t: string) => void; onEditConfirm: () => void; onPin: () => void; onDelete: () => void;
}) {
  return (
    <div className={active ? 'conv-item active' : 'conv-item'} onClick={onSelect}>
      {editing ? (
        <input className="conv-edit-input" value={editTitle} onChange={(e) => onEditStart?.(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onEditConfirm() }} onBlur={onEditConfirm} autoFocus onClick={(e) => e.stopPropagation()} />
      ) : (
        <div className="conv-item-main">
          <span className="conv-title">{conv.pinned ? '📌 ' : ''}{conv.title}</span>
          <div className="conv-actions" onClick={(e) => e.stopPropagation()}>
            <button title="重命名" onClick={() => onEditStart(conv.title)}>✏️</button>
            <button title={conv.pinned ? '取消置顶' : '置顶'} onClick={onPin}>{conv.pinned ? '📌' : '📍'}</button>
            <button title="删除" onClick={onDelete}>🗑️</button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ───── 折叠记录列表 ───── */

function formatDateGroup(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const itemDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (itemDay.getTime() === today.getTime()) return '今天'
  if (itemDay.getTime() === yesterday.getTime()) return '昨天'
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}

function DateGroupedRecords({ items, expandedIds, toggleExpand, selectMode, selectedIds, onToggleSelect, onDelete }: { items: HistoryRecord[]; expandedIds: Set<string>; toggleExpand: (id: string) => void; selectMode?: boolean; selectedIds?: Set<string>; onToggleSelect?: (id: string) => void; onDelete?: (id: string) => void }) {
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
            <CollapsibleRecordItem
              key={item.id} item={item}
              expanded={expandedIds.has(item.id)}
              onToggle={() => toggleExpand(item.id)}
              selectMode={selectMode}
              checked={selectedIds?.has(item.id)}
              onToggleSelect={onToggleSelect ? () => onToggleSelect(item.id) : undefined}
              onDelete={onDelete}
            />
          ))}
        </div>
      ))}
    </>
  )
}

function CollapsibleRecordItem({ item, expanded, onToggle, selectMode, checked, onToggleSelect, onDelete }: { item: HistoryRecord; expanded: boolean; onToggle: () => void; selectMode?: boolean; checked?: boolean; onToggleSelect?: () => void; onDelete?: (id: string) => void }) {
  const [actionStatus, setActionStatus] = useState('')
  const isRunning = item.status === 'running'

  const onAction = (e: React.MouseEvent, fn: () => void) => {
    e.stopPropagation()
    fn()
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm('确定删除这条记录吗？')) onDelete?.(item.id)
  }

  const handleHeaderClick = () => {
    if (selectMode && onToggleSelect) onToggleSelect()
    else onToggle()
  }

  return (
    <article className={expanded ? 'collapsible-card expanded' : 'collapsible-card'}>
      {/* 折叠头 */}
      <div className={`collapsible-header${selectMode ? ' selectable' : ''}`} onClick={handleHeaderClick}>
        {selectMode ? (
          <input type="checkbox" className="record-checkbox" checked={checked || false} onChange={onToggleSelect} onClick={(e) => e.stopPropagation()} />
        ) : (
          <span className="collapsible-arrow">{expanded ? '▾' : '▸'}</span>
        )}
        <span className="collapsible-badge">{item.skillName}</span>
        <span className="collapsible-preview">{item.selectedText.slice(0, 60)}{item.selectedText.length > 60 ? '...' : ''}</span>
        <span className="collapsible-meta">
          {new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          {' · '}{item.model}
          {' · '}<span className={item.status === 'completed' ? 'ok' : item.status === 'running' ? 'running' : 'bad'}>
            {item.status === 'completed' ? '完成' : item.status === 'running' ? '生成中' : '失败'}
          </span>
          {!selectMode ? <button className="record-delete-btn" onClick={handleDelete} title="删除">×</button> : null}
        </span>
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div className="collapsible-body">
          <div className="record-block source-block">
            <span className="record-block-label">原文</span>
            <p>{item.selectedText}</p>
          </div>
          {item.pronunciationData ? (
            <PronunciationCard data={item.pronunciationData} answer={item.answerMarkdown} status={item.status} />
          ) : (
            <div className="record-block answer-block">
              <span className="record-block-label">AI 回答</span>
              {item.answerMarkdown ? <MarkdownView text={item.answerMarkdown} /> : isRunning ? <TypingDots /> : null}
            </div>
          )}
          <div className="record-actions">
            <div className="record-actions-left">
              <button className="pill-btn" onClick={(e) => onAction(e, async () => {
                await window.desktopApi.copyText(item.answerMarkdown)
                setActionStatus('已复制')
              })}>复制</button>
              <button className="pill-btn" onClick={(e) => onAction(e, async () => {
                try {
                  const result = await saveRecordToActiveObsidian(item)
                  setActionStatus(`已保存：${result.path}`)
                } catch (error) {
                  setActionStatus(error instanceof Error ? error.message : String(error))
                }
              })}>保存到 Obsidian</button>
              <button className="pill-btn" onClick={(e) => onAction(e, () => window.desktopApi.speak(item.answerMarkdown))}>朗读</button>
            </div>
            <button className="pill-btn danger" onClick={(e) => onAction(e, () => {
              if (window.confirm('确定删除这条记录吗？')) {
                window.desktopApi.deleteHistory([item.id])
              }
            })}>删除</button>
            {actionStatus ? <span className="action-status">{actionStatus}</span> : null}
          </div>
        </div>
      )}
    </article>
  )
}

function ApiPanel() {
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
    // Optimistic local update
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
    <div className="api-layout">
      {/* Sidebar */}
      <aside className="api-sidebar">
        {Object.entries(presets).map(([id, p]) => (
          <button key={id} className={selectedId === id ? 'api-provider-item active' : 'api-provider-item'} onClick={() => switchProvider(id)}>
            <span className="api-provider-name">{p.name}</span>
            {config.providers[id]?.enabled ? <span className="api-provider-dot" /> : null}
          </button>
        ))}
      </aside>

      {/* Main config */}
      <div className="api-panel">
        <div className="api-panel-head">
          <h3>{preset.name}</h3>
          <label className="hotkey-toggle">
            <button className={pcfg?.enabled !== false ? 'toggle on' : 'toggle'} onClick={() => save({ [selectedId]: { enabled: !(pcfg?.enabled !== false) } })}>
              <span className="toggle-knob" />
            </button>
          </label>
        </div>

        {preset.hint ? <div className="api-hint">{preset.hint}</div> : null}

        <label className="api-field">
          API Key
          <div className="api-key-row">
            <input type={showKey ? 'text' : 'password'} value={pcfg?.apiKey || ''} onChange={(e) => save({ [selectedId]: { apiKey: e.target.value } })} placeholder="输入 API Key..." />
            <button className="api-key-eye" onClick={() => setShowKey(!showKey)}>{showKey ? '🙈' : '👁'}</button>
          </div>
        </label>

        <label className="api-field">
          {preset.modelLabel || '模型'}
          <div className="api-model-row">
            <select value={pcfg?.model || preset.defaultModel} onChange={(e) => save({ [selectedId]: { model: e.target.value } })}>
              {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <button className="api-model-btn" onClick={() => { setAddingModel(true); setNewModelName('') }} title="添加模型">+</button>
            {(pcfg?.customModels || []).includes(pcfg?.model || '') ? <button className="api-model-btn danger" onClick={removeModel} title="删除此模型">−</button> : null}
          </div>
          {addingModel ? (
            <div className="api-model-add">
              <input value={newModelName} onChange={(e) => setNewModelName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addModel() }} placeholder="模型 ID..." autoFocus />
              <button onClick={addModel}>确认</button>
              <button onClick={() => setAddingModel(false)}>取消</button>
            </div>
          ) : null}
        </label>

        {selectedId === 'custom' || preset.baseUrl === '' ? (
          <label className="api-field">
            Base URL
            <input value={pcfg?.baseUrl || ''} onChange={(e) => save({ [selectedId]: { baseUrl: e.target.value } })} placeholder={preset.baseUrl || 'https://...'} />
          </label>
        ) : null}

        <button className="api-advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? '▲ 收起高级设置' : '▼ 高级设置'}
        </button>

        {showAdvanced ? (
          <div className="api-advanced">
            {selectedId === 'custom' || preset.baseUrl === '' ? null : (
              <label className="api-field">
                Base URL
                <input value={pcfg?.baseUrl || ''} onChange={(e) => save({ [selectedId]: { baseUrl: e.target.value } })} placeholder={preset.baseUrl} />
              </label>
            )}
            <div className="api-grid">
              <label className="api-field">
                Temperature
                <input type="number" min={0} max={2} step={0.1} value={pcfg?.temperature ?? 0.3} onChange={(e) => save({ [selectedId]: { temperature: Number(e.target.value) } })} />
              </label>
              <label className="api-field">
                Max Tokens
                <input type="number" min={1} max={32000} value={pcfg?.maxTokens ?? 1200} onChange={(e) => save({ [selectedId]: { maxTokens: Number(e.target.value) } })} />
              </label>
              <label className="api-field">
                Timeout (ms)
                <input type="number" min={5000} max={300000} value={pcfg?.timeoutMs ?? 60000} onChange={(e) => save({ [selectedId]: { timeoutMs: Number(e.target.value) } })} />
              </label>
              <label className="api-field">
                <label className="mini-switch">
                  <input type="checkbox" checked={pcfg?.stream !== false} onChange={(e) => save({ [selectedId]: { stream: e.target.checked } })} />
                  <span>流式输出</span>
                </label>
              </label>
            </div>
          </div>
        ) : null}

        <div className="api-actions">
          <button className="primary" onClick={testConnection} disabled={testing}>
            {testing ? '测试中...' : '测试连接'}
          </button>
          {testResult ? (
            <span className={testResult.ok ? 'api-test-ok' : 'api-test-fail'}>
              {testResult.ok ? '✓ 连接成功' : `✗ ${testResult.error}`}
            </span>
          ) : null}
          {message ? <span className="api-saved">{message}</span> : null}
        </div>
      </div>
    </div>
  )
}

const skillIconChoices = ['♡', '➤', '▣', '▣', '✎', '◷', '♬', '□', '✉', '♢', '⌖', '↻', '✳', '☼', '☁', '⚡', '♧', '☾', '⌕', '⧉', '🔊', '☷', '译', 'i', '自']
const toolbarSkillLimit = 5

function isCustomSkill(skill: Skill) {
  if (skill.deletable === false) return false
  return skill.id.startsWith('custom_') || skill.id === 'custom_skill'
}

function SkillsPanel({ skills, onSave, onDelete, onReorder }: { skills: Skill[]; onSave: (skill: Skill) => void; onDelete: (skillId: string) => void; onReorder: (skillIds: string[]) => void }) {
  const sortedSkills = [...skills].sort((a, b) => a.sortOrder - b.sortOrder)
  const [displaySkills, setDisplaySkills] = useState<Skill[]>(sortedSkills)
  const displaySkillsRef = useRef<Skill[]>(sortedSkills)
  const [expandedId, setExpandedId] = useState(sortedSkills[0]?.id || '')
  const [editing, setEditing] = useState<Skill | null>(null)
  const [draggingId, setDraggingId] = useState('')
  const visibleCount = displaySkills.filter((skill) => skill.enabled && skill.showInToolbar).length

  useEffect(() => {
    setDisplaySkills(sortedSkills)
    displaySkillsRef.current = sortedSkills
  }, [skills])

  const newSkill = () => {
    const now = Date.now()
    setEditing({
      ...emptySkill,
      id: `custom_${now}`,
      name: '新技能',
      icon: '自',
      showInToolbar: visibleCount < toolbarSkillLimit,
      sortOrder: 100 + skills.length,
    })
  }

  const toggleToolbar = (skill: Skill) => {
    if (!skill.showInToolbar && visibleCount >= toolbarSkillLimit) {
      window.alert(`工具条最多显示 ${toolbarSkillLimit} 个技能，请先隐藏一个技能。`)
      return
    }
    onSave({ ...skill, showInToolbar: !skill.showInToolbar, enabled: true })
  }

  const deleteSkill = (skill: Skill) => {
    if (!isCustomSkill(skill)) return
    if (window.confirm(`确定删除“${skill.name}”吗？`)) onDelete(skill.id)
  }

  const moveSkill = (activeId: string, overId: string) => {
    if (!activeId || !overId || activeId === overId) return
    setDisplaySkills((current) => {
      const from = current.findIndex((skill) => skill.id === activeId)
      const to = current.findIndex((skill) => skill.id === overId)
      if (from < 0 || to < 0) return current
      const next = [...current]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      const reordered = next.map((skill, index) => ({ ...skill, sortOrder: (index + 1) * 10 }))
      displaySkillsRef.current = reordered
      return reordered
    })
  }

  const saveOrder = () => {
    if (!draggingId) return
    setDraggingId('')
    onReorder(displaySkillsRef.current.map((skill) => skill.id))
  }

  return (
    <section className="skill-manager">
      <div className="skill-manager-head">
        <div>
          <strong>AI 划词工具栏</strong>
          <span>当前工具条显示 {visibleCount}/5 个。拖动技能行可调整工具条顺序，点击技能可展开操作。</span>
        </div>
        <button className="primary" onClick={newSkill}>新建技能</button>
      </div>

      <div className="skill-card-list">
        {displaySkills.map((skill) => {
          const expanded = expandedId === skill.id
          const custom = isCustomSkill(skill)
          return (
            <article
              key={skill.id}
              draggable
              className={`${expanded ? 'skill-card-row expanded' : 'skill-card-row'}${draggingId === skill.id ? ' dragging' : ''}`}
              onDragStart={(event) => {
                setDraggingId(skill.id)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', skill.id)
              }}
              onDragOver={(event) => {
                event.preventDefault()
                moveSkill(draggingId || event.dataTransfer.getData('text/plain'), skill.id)
              }}
              onDrop={(event) => {
                event.preventDefault()
                saveOrder()
              }}
              onDragEnd={saveOrder}
            >
              <button className="skill-card-main" onClick={() => setExpandedId(expanded ? '' : skill.id)}>
                <span className="drag-dots">⠿</span>
                <span className="skill-icon">{skill.icon || '•'}</span>
                <strong>{skill.name}</strong>
                {!skill.showInToolbar ? <em>已隐藏</em> : null}
              </button>
              {expanded ? (
                <div className="skill-card-actions">
                  <label className="mini-switch">
                    <input type="checkbox" checked={skill.showInToolbar} onChange={() => toggleToolbar(skill)} />
                    <span>工具条显示</span>
                  </label>
                  <button onClick={() => setEditing({ ...skill })}>编辑</button>
                  {custom ? <button className="danger-text" onClick={() => deleteSkill(skill)}>删除</button> : null}
                </div>
              ) : null}
            </article>
          )
        })}
      </div>

      {editing ? <SkillEditDialog skill={editing} onChange={setEditing} onClose={() => setEditing(null)} onSave={(skill) => { onSave(skill); setEditing(null) }} /> : null}
    </section>
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

  const useExample = () => {
    onChange({
      ...skill,
      userPrompt: '请围绕下面划选内容给出清晰、实用的中文解释：\n\n{{selection}}\n\n请包含：核心含义、使用场景、注意点。',
    })
  }

  return (
    <div className="skill-dialog-backdrop">
      <motion.div initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} className="skill-dialog">
        <header>
          <strong>编辑技能</strong>
          <button onClick={onClose}>×</button>
        </header>

        <label className="skill-dialog-label">技能名称和图标 <b>*</b></label>
        <div className="skill-name-line">
          <input maxLength={20} value={skill.name} onChange={(event) => onChange({ ...skill, name: event.target.value })} />
          <span>{nameCount}/20</span>
          <button className="icon-picker-button" onClick={() => setIconOpen((value) => !value)}>{skill.icon || '•'}</button>
          {iconOpen ? (
            <div className="icon-popover">
              <header><span>图标</span><button onClick={() => setIconOpen(false)}>×</button></header>
              <div className="icon-grid">
                {skillIconChoices.map((icon) => (
                  <button key={icon} className={skill.icon === icon ? 'active' : ''} onClick={() => { onChange({ ...skill, icon }); setIconOpen(false) }}>{icon}</button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <label className="skill-dialog-label">提示词内容 <b>*</b></label>
        <div className="prompt-help">
          可以直接写“翻译成中文”“解释这句话”，系统会自动把划词内容传给 AI。
          <span className="prompt-help-more">高级用法：<code>{'{{selection}}'}</code> 或 <code>{'{selection}'}</code> 可指定划词文本插入位置。</span>
          <button onClick={useExample}>插入示例</button>
        </div>
        <textarea className="skill-prompt-box" value={skill.userPrompt} onChange={(event) => onChange({ ...skill, userPrompt: event.target.value })} />

        <div className="skill-dialog-options">
          <label><input type="checkbox" checked={skill.enabled} onChange={(event) => onChange({ ...skill, enabled: event.target.checked })} />启用技能</label>
          <label><input type="checkbox" checked={skill.showInToolbar} onChange={(event) => onChange({ ...skill, showInToolbar: event.target.checked })} />显示在工具条</label>
        </div>

        {error ? <div className="skill-error">{error}</div> : null}
        {!custom ? <p className="skill-system-note">这是内置技能，可以改名称、图标和提示词，但不能删除。</p> : null}

        <footer>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={save}>保存</button>
        </footer>
      </motion.div>
    </div>
  )
}

function ObsidianPanel({ settings, onSave, dataDir, templates }: { settings: Settings; onSave: (settings: Settings) => void; dataDir: string; templates: ObsidianTemplate[] }) {
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
    <section className="panel obsidian-panel">
      <div className="obsidian-vault-row">
        <div className="obsidian-label-line">
          <label>Vault 路径</label>
          <span className="obsidian-help-tip" tabIndex={0}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              const pop = el.querySelector(".obsidian-help-popover");
              if (!pop) return;
              const rect = el.getBoundingClientRect();
              const tw = Math.min(360, window.innerWidth - 24);
              const l = Math.max(8, Math.min(rect.left + rect.width / 2 - tw / 2, window.innerWidth - tw - 8));
              pop.setAttribute("style", "position:fixed;left:" + l + "px;top:" + (rect.top - 8) + "px;opacity:1;transform:scale(1)");
            }}
            onMouseLeave={(e) => {
              const pop = e.currentTarget.querySelector(".obsidian-help-popover");
              if (!pop) return;
              const cur = pop.getAttribute("style") || "";
              const base = cur.replace(/opacity:[^;]+;?/g, "").replace(/transform:[^;]+;?/g, "");
              pop.setAttribute("style", base + "opacity:0;transform:scale(0.98)");
            }}
            onFocus={(e) => {
              const el = e.currentTarget;
              const pop = el.querySelector(".obsidian-help-popover");
              if (!pop) return;
              const rect = el.getBoundingClientRect();
              const tw = Math.min(360, window.innerWidth - 24);
              const l = Math.max(8, Math.min(rect.left + rect.width / 2 - tw / 2, window.innerWidth - tw - 8));
              pop.setAttribute("style", "position:fixed;left:" + l + "px;top:" + (rect.top - 8) + "px;opacity:1;transform:scale(1)");
            }}
            onBlur={(e) => {
              const pop = e.currentTarget.querySelector(".obsidian-help-popover");
              if (!pop) return;
              const cur = pop.getAttribute("style") || "";
              const base = cur.replace(/opacity:[^;]+;?/g, "").replace(/transform:[^;]+;?/g, "");
              pop.setAttribute("style", base + "opacity:0;transform:scale(0.98)");
            }}>
            ?
            <span className="obsidian-help-popover">
              <strong>Obsidian 导入怎么用？</strong>
              <span>1. 先填写并保存 Vault 文件夹路径。</span>
              <span>2. 新建或选择模板，目标笔记必须是 Vault 内已有的 .md 文件。</span>
              <span>3. 当前选中的模板，会用于结果卡片里的“保存到 Obsidian”。</span>
              <em>常用变量：{'{{selection}}'} 原文，{'{{ai_result}}'} AI 结果。</em>
            </span>
          </span>
        </div>
        <div className="row-input">
          <input value={draft.obsidian.vaultPath} onChange={(e) => setDraft({ ...draft, obsidian: { ...draft.obsidian, vaultPath: e.target.value } })} placeholder="例如 C:\Users\你\Documents\ObsidianVault" />
          <button className="primary" onClick={handleVaultPathSave}>保存</button>
        </div>
      </div>

      <div className="obsidian-layout">
        <aside className="obsidian-list">
          <button className="primary" onClick={newTemplate}>+ 新建模板</button>
          {localTemplates.map((tpl) => (
            <button key={tpl.id} className={selectedId === tpl.id ? 'obsidian-tpl-item active' : 'obsidian-tpl-item'} onClick={() => { void selectTemplate(tpl.id) }}>
              {tpl.name}
            </button>
          ))}
        </aside>
        <div className="obsidian-editor">
          {!selected && !editing ? <div className="empty">选择一个模板开始编辑</div> : null}

          {selected && !editing ? (
            <div className="obsidian-view">
              <div className="obsidian-view-field"><label>名称</label><span>{selected.name}</span></div>
              <div className="obsidian-view-field"><label>状态</label><span>{selectedId === draft.obsidian.activeTemplateId ? '当前使用模板' : '未设为当前模板'}</span></div>
              <div className="obsidian-view-field"><label>保存方式</label><span>{selected.saveBehavior === 'append_to_existing_note_bottom' ? '追加到末尾' : '追加到开头'}</span></div>
              <div className="obsidian-view-field"><label>目标笔记</label><span>{selected.targetNotePath || '未设置'}</span></div>
              <div className="obsidian-view-field"><label>模板预览</label><pre className="obsidian-template-preview">{selected.contentTemplate.slice(0, 200)}{selected.contentTemplate.length > 200 ? '...' : ''}</pre></div>
              <button onClick={editSelected}>编辑模板</button>
            </div>
          ) : null}

          {editing ? (
            <div className="obsidian-edit-form">
              <label>模板名称<input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例如：英语学习笔记" /></label>
              <label>保存行为</label>
              <div className="obsidian-radio-group">
                <label><input type="radio" name="saveBehavior" checked={editing.saveBehavior === 'append_to_existing_note_bottom'} onChange={() => setEditing({ ...editing, saveBehavior: 'append_to_existing_note_bottom' })} /> 追加到已有笔记末尾</label>
                <label><input type="radio" name="saveBehavior" checked={editing.saveBehavior === 'append_to_existing_note_top'} onChange={() => setEditing({ ...editing, saveBehavior: 'append_to_existing_note_top' })} /> 追加到已有笔记开头</label>
              </div>
              <label>目标笔记路径
                <div className="path-input-row">
                  <input value={editing.targetNotePath} onChange={(e) => setEditing({ ...editing, targetNotePath: e.target.value })} placeholder="例如 英语/台词学习.md" />
                  <button onClick={() => setShowNotePicker(true)}>浏览</button>
                </div>
              </label>
              <label>内容模板
                <div className="template-vars-hint">
                  可用变量：<code>{'{{selection}}'}</code> <code>{'{{ai_result}}'}</code> <code>{'{{skill_name}}'}</code> <code>{'{{model}}'}</code> <code>{'{{date}}'}</code> <code>{'{{time}}'}</code> <code>{'{{source_app}}'}</code> <code>{'{{history_space}}'}</code>
                </div>
                <textarea className="large template-textarea" value={editing.contentTemplate} onChange={(e) => setEditing({ ...editing, contentTemplate: e.target.value })} placeholder="输入 Markdown 模板..." />
              </label>
              <div className="obsidian-edit-actions">
                <button onClick={doPreview}>预览</button>
                <button className="primary" onClick={saveTemplate}>保存模板</button>
                <button className="danger" onClick={deleteTemplate}>删除</button>
              </div>
              {previewMd ? <div className="obsidian-preview-box"><strong>预览</strong><pre className="obsidian-preview-md">{previewMd}</pre></div> : null}
              {previewError ? <div className="obsidian-error">{previewError}</div> : null}
            </div>
          ) : null}
        </div>
      </div>

      {message ? <div className="inline-message">{message}</div> : null}
      <p className="subtle">本地数据目录：{dataDir}</p>
      {showNotePicker ? <VaultNotePicker vaultPath={draft.obsidian.vaultPath} onPick={pickedNote} onClose={() => setShowNotePicker(false)} /> : null}
    </section>
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
    document.body.style.background = 'transparent'
    document.documentElement.style.background = 'transparent'
    document.body.style.width = 'max-content'
    document.documentElement.style.width = 'max-content'
    const root = document.getElementById('root')
    if (root) root.style.width = 'max-content'
    window.desktopApi.getInitialData().then((data) => setSkills(data.toolbarSkills))

    // Visibility toggle — near-instant CSS transition
    const offShow = window.desktopApi.onToolbarShow(() => setVisible(true))
    const offHide = window.desktopApi.onToolbarHide(() => {
      setVisible(false)
      setMoreOpen(false)
    })
    const offMoreState = window.desktopApi.onToolbarMoreState((payload) => {
      setMoreOpen(Boolean(payload.open))
    })
    const offSelection = window.desktopApi.onSelectionReady((payload: any) => {
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
      console.log('toolbar measured rect', rect)
      window.desktopApi.setToolbarSize({ width: rect.width + 20, height: rect.height })
    })
    return () => cancelAnimationFrame(frame)
  }, [actionSignature, busySkill, visible, moreOpen])

  const toggleMore = async () => {
    const result = await window.desktopApi.toggleToolbarMore()
    setMoreOpen(Boolean(result.open))
  }
  // ─── drag state ───
  const dragRef = useRef({ active: false, sx: 0, sy: 0, width: 0, height: 0 })
  const toolbarShellRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)

  const onGripDown = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const bounds = await window.desktopApi.getToolbarBounds()
    if (!bounds) return
    const fixedRect = toolbarRef.current?.getBoundingClientRect()
    if (fixedRect) console.log('drag start rect', fixedRect)
    dragRef.current = {
      active: true,
      sx: e.screenX - bounds.x,
      sy: e.screenY - bounds.y,
      width: fixedRect?.width || bounds.width,
      height: fixedRect?.height || bounds.height,
    }
    const onMove = (me: MouseEvent) => {
      if (!dragRef.current.active) return
      const x = me.screenX - dragRef.current.sx
      const y = me.screenY - dragRef.current.sy
      console.log('drag move', { x, y, width: dragRef.current.width, height: dragRef.current.height })
      window.desktopApi.setToolbarPosition({ x, y })
    }
    const onUp = () => {
      if (toolbarRef.current) console.log('drag end rect', toolbarRef.current.getBoundingClientRect())
      dragRef.current.active = false
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
      onCopy={async () => {
        await window.desktopApi.copyText(selection, { silent: true })
        await window.desktopApi.hideToolbar()
      }}
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
  const run = async (skillId: string) => {
    setBusySkill(skillId)
    await window.desktopApi.hideToolbarMore()
    await window.desktopApi.runSkill(skillId)
    setBusySkill('')
  }

  return (
    <MoreMenu
      skills={moreSkills}
      busySkill={busySkill}
      open={open}
      onRunSkill={run}
      onSettings={async () => { await window.desktopApi.hideToolbarMore(); await window.desktopApi.showMain() }}
      onPointerEnter={() => window.desktopApi.setToolbarMorePointerInside(true)}
      onPointerLeave={() => window.desktopApi.setToolbarMorePointerInside(false)}
    />
  )
}

function ResultView() {
  const [record, setRecord] = useState<HistoryRecord | null>(null)
  const [sourceExpanded, setSourceExpanded] = useState(false)
  const [footerMoreOpen, setFooterMoreOpen] = useState(false)
  const [status, setStatus] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [confirmSkillId, setConfirmSkillId] = useState('')
  const runIdRef = useRef('')
  const resultCardRef = useRef<HTMLDivElement>(null)
  const resultDragRef = useRef({ active: false, startX: 0, startY: 0, winX: 0, winY: 0 })
  const RESIZE_THROTTLE_MS = 100
  const resizeLastAtRef = useRef(0)
  const resizePendingRef = useRef<number | null>(null)

  useEffect(() => {
    const offReady = window.desktopApi.onResultReady((next) => {
      runIdRef.current = next.runId || ''
      setRecord(next)
      setSourceExpanded(false)
      setFooterMoreOpen(false)
    })
    const offUpdate = window.desktopApi.onResultUpdate((next) => {
      if (next.runId && next.runId !== runIdRef.current) {
        console.log('[Result] update ignored stale runId=' + next.runId + ' currentRunId=' + runIdRef.current);
        return
      }
      setRecord(next)
    })
    const offConfirm = window.desktopApi.onConfirmSelection((payload) => {
      setRecord(payload.record)
      setConfirmText(payload.record.selectedText)
      setConfirmSkillId(payload.skillId)
    })
    const offReset = window.desktopApi.onResultReset(() => {
      if (resizePendingRef.current !== null) {
        cancelAnimationFrame(resizePendingRef.current)
        resizePendingRef.current = null
      }
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
    if (!record || resultDragRef.current.active) return
    // Cancel any previously scheduled resize
    if (resizePendingRef.current !== null) {
      cancelAnimationFrame(resizePendingRef.current)
      resizePendingRef.current = null
    }
    resizePendingRef.current = requestAnimationFrame(() => {
      resizePendingRef.current = null
      const now = Date.now()
      const elapsed = now - resizeLastAtRef.current
      const isDone = record.status === 'completed' || record.status === 'failed'
      if (elapsed < RESIZE_THROTTLE_MS && !isDone) {
        console.log('[Result] resize throttled')
        return
      }
      const card = resultCardRef.current
      if (!card) return
      const header = card.querySelector<HTMLElement>('.result-card-header')
      const content = card.querySelector<HTMLElement>('.result-card-content')
      const footer = card.querySelector<HTMLElement>('.result-card-footer')
      const statusLine = card.querySelector<HTMLElement>('.result-status')
      const contentStyle = content ? window.getComputedStyle(content) : null
      const contentPadding =
        (Number.parseFloat(contentStyle?.paddingTop || '0') || 0) +
        (Number.parseFloat(contentStyle?.paddingBottom || '0') || 0)
      const childrenHeight = content
        ? Array.from(content.children).reduce((total, child) => {
            const element = child as HTMLElement
            const style = window.getComputedStyle(element)
            const margin =
              (Number.parseFloat(style.marginTop || '0') || 0) +
              (Number.parseFloat(style.marginBottom || '0') || 0)
            return total + Math.max(element.scrollHeight, element.offsetHeight) + margin
          }, 0)
        : 0
      const contentHeight = contentPadding + childrenHeight
      const chromeHeight =
        (header?.offsetHeight || 0) +
        (footer?.offsetHeight || 0) +
        (statusLine?.offsetHeight || 0)
      const desiredHeight = Math.ceil(chromeHeight + contentHeight + 8)
      window.desktopApi.resizeResultBox({ width: 444, height: desiredHeight })
      resizeLastAtRef.current = Date.now()
    })
    return () => {
      if (resizePendingRef.current !== null) {
        cancelAnimationFrame(resizePendingRef.current)
        resizePendingRef.current = null
      }
    }
  }, [
    record?.id,
    record?.answerMarkdown,
    record?.status,
    record?.pronunciationData,
    sourceExpanded,
    footerMoreOpen,
    status,
    confirmText,
  ])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.desktopApi.closeResult('escape')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!record) return <div className="result-card empty-result">等待划词结果...</div>

  const copy = async () => {
    await window.desktopApi.copyText(record.answerMarkdown)
  }
  const exportObsidian = async () => {
    try {
      const result = await saveRecordToActiveObsidian(record)
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
            <button onClick={copy}><span>⧉</span>复制</button>
            <button onClick={() => window.desktopApi.speak(record.answerMarkdown)}><span>◖</span>朗读</button>
            <button onClick={() => window.desktopApi.runSkill(record.skillId, record.selectedText)}><span>↻</span>重新生成</button>
            <div className="result-footer-spacer" />
            <div className="result-footer-more">
              <button className="result-footer-more-button" onClick={() => setFooterMoreOpen((value) => !value)} aria-label="更多操作">•••</button>
              {footerMoreOpen ? (
                <div className="result-footer-menu">
                  <button onClick={() => { setFooterMoreOpen(false); exportObsidian() }}>保存到 Obsidian</button>
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
  const handlePlay = (e: React.MouseEvent, lang: 'en-US' | 'en-GB') => {
    e.preventDefault()
    e.stopPropagation()
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(data.text)
    utterance.lang = lang
    utterance.rate = lang === 'en-GB' ? 0.95 : 1.0
    speechSynthesis.speak(utterance)
  }

  const isRunning = status === 'running'

  return (
    <div className="pronunciation-card" onMouseDown={(e) => e.stopPropagation()}>
      {data.mode === 'word' ? (
        <>
          <h3 className="pron-word">{data.text}</h3>
          <div className="pron-chips">
            <button className="pron-chip" onClick={(e) => handlePlay(e, 'en-US')} disabled={isRunning}>
              US {data.us_ipa ? <span className="pron-ipa">/{data.us_ipa}/</span> : null} 🔊
            </button>
            <button className="pron-chip" onClick={(e) => handlePlay(e, 'en-GB')} disabled={isRunning}>
              GB {data.gb_ipa ? <span className="pron-ipa">/{data.gb_ipa}/</span> : null} 🔊
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="pron-sentence">{data.text}</p>
          <div className="pron-chips">
            <button className="pron-chip" onClick={(e) => handlePlay(e, 'en-US')} disabled={isRunning}>US 朗读句子 🔊</button>
            <button className="pron-chip" onClick={(e) => handlePlay(e, 'en-GB')} disabled={isRunning}>GB 朗读句子 🔊</button>
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
