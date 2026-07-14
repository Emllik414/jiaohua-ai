import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function skillShortcutMenuPlugin(): Plugin {
  return {
    name: 'jiaohua-skill-shortcut-menu',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/App.tsx')) return null

      const normalizedCode = code.replace(/\r\n?/g, '\n')
      const opening = `          <div className={'skill-menu ' + menuSide} ref={menuRef} draggable={false} onMouseDown={(event) => event.stopPropagation()}>`
      const closing = `\n          </div>\n        ) : null}`
      const start = normalizedCode.indexOf(opening)
      if (start < 0) throw new Error('[skill-shortcut-menu] cannot find the skill menu opening marker in src/App.tsx')
      const contentStart = start + opening.length
      const end = normalizedCode.indexOf(closing, contentStart)
      if (end < 0) throw new Error('[skill-shortcut-menu] cannot find the skill menu closing marker in src/App.tsx')

      const menuItems = `
            <div className="skill-menu-item" onClick={() => { setEditing({ ...skill }); setMenuSkill(null) }}>编辑技能</div>
            <div
              className="skill-menu-item"
              data-skill-shortcut-compiled={skill.id}
              onClick={() => {
                void window.desktopApi.openSkillShortcutDialog(skill.id)
                setMenuSkill(null)
              }}
            >设置快捷键</div>
            {isCustomSkill(skill) ? (
              <>
                <div className="skill-menu-sep" />
                <div className="skill-menu-item danger" onClick={() => {
                  onDelete(skill.id)
                  setMenuSkill(null)
                }}>删除技能</div>
              </>
            ) : null}`

      return { code: normalizedCode.slice(0, contentStart) + menuItems + normalizedCode.slice(end), map: null }
    },
  }
}

function pronunciationCardPlugin(): Plugin {
  return {
    name: 'jiaohua-pronunciation-card-expanded-live-audio',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/App.tsx')) return null

      let next = code.replace(/\r\n?/g, '\n')
      const stateLine = `  const [detailsOpen, setDetailsOpen] = useState(false)`
      const resetLine = `  useEffect(() => setDetailsOpen(false), [data.text])`
      const collapsedBlock = `      {answer ? (
        isRunning ? <AnswerView text={answer} format={answerFormat} variant="pronunciation" streaming /> : (
          <div className={'pronunciation-details' + (detailsOpen ? ' expanded' : '')}>
            <div className="pronunciation-details-content">
              <AnswerView text={answer} format={answerFormat} variant="pronunciation" />
            </div>
            <button className="pronunciation-details-toggle" onClick={(event) => { event.stopPropagation(); setDetailsOpen((value) => !value) }}>
              {detailsOpen ? '收起详细解析' : '查看详细解析'} <span aria-hidden="true">⌄</span>
            </button>
          </div>
        )
      ) : null}`
      const expandedBlock = `      {answer ? (
        <AnswerView text={answer} format={answerFormat} variant="pronunciation" streaming={isRunning} />
      ) : null}`

      if (!next.includes(stateLine) || !next.includes(resetLine) || !next.includes(collapsedBlock)) {
        throw new Error('[pronunciation-card] cannot find the collapsible pronunciation card markers in src/App.tsx')
      }

      next = next.replace(`${stateLine}\n`, '')
      next = next.replace(`\n${resetLine}\n`, '\n')
      next = next.replace(collapsedBlock, expandedBlock)

      const disabledMarker = ' disabled={isRunning}'
      const disabledCount = next.split(disabledMarker).length - 1
      if (disabledCount !== 4) throw new Error(`[pronunciation-card] expected 4 running-state audio locks, found ${disabledCount}`)
      next = next.split(disabledMarker).join('')

      return { code: next, map: null }
    },
  }
}

function sourceLocationUiPlugin(): Plugin {
  return {
    name: 'jiaohua-source-location-ui',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/App.tsx')) return null
      let next = code.replace(/\r\n?/g, '\n')

      const importMarker = `import './App.css'`
      if (!next.includes(importMarker)) throw new Error('[source-location-ui] missing App.css import')
      next = next.replace(importMarker, `${importMarker}\nimport './source-location.css'`)

      const answerFormatMarker = `type AnswerFormat = 'rich' | 'plain' | 'json' | 'code' | 'template'`
      const sourceTypes = `type SourceLocation = {
  type: 'web' | 'video' | 'subtitle' | 'desktop'
  capturedAt: string
  url?: string
  normalizedUrl?: string
  openUrl?: string
  title?: string
  hostname?: string
  siteName?: string
  icon?: string
  faviconUrl?: string
  faviconVaultPath?: string
  videoTime?: string
  video?: { platform?: string; currentTime: number; duration?: number; paused?: boolean }
  anchor?: { selectedText: string; prefixText?: string; suffixText?: string; elementFingerprint?: string; scrollY?: number; scrollRatio?: number; frameUrl?: string }
}

${answerFormatMarker}`
      if (!next.includes(answerFormatMarker)) throw new Error('[source-location-ui] missing AnswerFormat marker')
      next = next.replace(answerFormatMarker, sourceTypes)

      const runIdMarker = `  runId?: string\n}`
      if (!next.includes(runIdMarker)) throw new Error('[source-location-ui] missing HistoryRecord marker')
      next = next.replace(runIdMarker, `  runId?: string\n  sourceLocation?: SourceLocation\n}`)

      next = next.replace(
        `copyText: (text: string, options?: { silent?: boolean })`,
        `copyText: (text: string, options?: { silent?: boolean; openExternal?: boolean })`,
      )
      next = next.replace(
        `Promise<{ ok: boolean; successCount: number; failureCount: number; results: Array<{ recordId: string; ok: boolean; path?: string; error?: string }> }>`,
        `Promise<{ ok: boolean; successCount: number; duplicateCount?: number; failureCount: number; results: Array<{ recordId: string; ok: boolean; duplicate?: boolean; path?: string; error?: string }> }>`,
      )

      const filterMarker = '`${item.selectedText} ${item.answerMarkdown} ${item.skillName}`.toLowerCase()'
      if (!next.includes(filterMarker)) throw new Error('[source-location-ui] missing history filter marker')
      next = next.replace(filterMarker, '`${item.selectedText} ${item.answerMarkdown} ${item.skillName} ${item.sourceLocation?.title || \'\'} ${item.sourceLocation?.hostname || \'\'} ${item.sourceLocation?.url || \'\'}`.toLowerCase()')

      const oldImportMessage = "setMessage(`已导入 ${result.successCount} 条${result.failureCount > 0 ? `，${result.failureCount} 条失败或已导入` : ''}`)"
      const newImportMessage = "setMessage(`已导入 ${result.successCount} 条${(result.duplicateCount || 0) > 0 ? `，${result.duplicateCount} 条已存在` : ''}${result.failureCount > 0 ? `，${result.failureCount} 条失败` : ''}`)"
      if (!next.includes(oldImportMessage)) throw new Error('[source-location-ui] missing batch import message')
      next = next.replace(oldImportMessage, newImportMessage)

      const previewContextMarker = `      source_app: 'Windows',\n      history_space: '',`
      const previewContextReplacement = `      source_app: 'Chrome',
      source_type: 'subtitle',
      source_site: 'YouTube',
      source_title: 'How to Speak English Naturally',
      source_title_yaml: 'How to Speak English Naturally',
      source_url: 'https://www.youtube.com/watch?v=example',
      source_open_url: 'https://www.youtube.com/watch?v=example&t=512s',
      source_host: 'youtube.com',
      source_icon: '▶',
      source_favicon: '.jiaohua/favicons/youtube.com.png',
      source_line: '> [!source] ▶ YouTube · [How to Speak English Naturally](https://www.youtube.com/watch?v=example&t=512s) · 8:32',
      video_time: '8:32',
      video_seconds: '512',
      selection_short: '示例原文内容',
      selection_title: '示例原文内容',
      answer: '这是 AI 返回的示例结果。',
      skill_id: 'translate',
      selection_context: 'and then, completely out of the blue, he called me again',
      captured_at: new Date().toLocaleString('zh-CN'),
      record_id: 'example-record',
      history_space: '',`
      if (!next.includes(previewContextMarker)) throw new Error('[source-location-ui] missing Obsidian preview context marker')
      next = next.replace(previewContextMarker, previewContextReplacement)

      const obsidianPanelMarker = `function ObsidianPanel(`
      const variableGuide = `type ObsidianTemplateVariable = {
  token: string
  description: string
  category: '划词内容' | 'AI 与技能' | '时间' | '来源' | '内部'
  common: boolean
}

const OBSIDIAN_TEMPLATE_VARIABLES: ObsidianTemplateVariable[] = [
  { token: '{{selection}}', description: '当时划选的完整原文。', category: '划词内容', common: true },
  { token: '{{ai_result}}', description: 'AI 最终生成的翻译、解释或其他结果。', category: 'AI 与技能', common: true },
  { token: '{{source_line}}', description: '自动生成一行简洁来源，包含图标、标题、直接链接和视频时间。', category: '来源', common: true },
  { token: '{{source_open_url}}', description: '可直接打开的最终来源链接；YouTube 和 Bilibili 会带准确视频时间。', category: '来源', common: true },
  { token: '{{source_title}}', description: '原网页、文章或视频的标题。', category: '来源', common: true },
  { token: '{{video_time}}', description: '便于阅读的视频时间，例如 08:32。', category: '时间', common: true },
  { token: '{{skill_name}}', description: '本条记录使用的技能名称，例如翻译、解释或发音。', category: 'AI 与技能', common: true },
  { token: '{{date}}', description: '历史记录创建日期，例如 2026-07-14。', category: '时间', common: true },
  { token: '{{time}}', description: '历史记录创建时间，例如 12:30。', category: '时间', common: true },
  { token: '{{record_id}}', description: '每条历史记录的唯一编号，用于识别和防止重复导入。', category: '内部', common: true },
  { token: '{{selection_short}}', description: '划词内容的短版本，最多约 28 个字符，适合用于文件名。', category: '划词内容', common: false },
  { token: '{{selection_title}}', description: '自动整理的笔记标题；内容过长时会截断。', category: '划词内容', common: false },
  { token: '{{selection_context}}', description: '划词原文连同前文和后文，用于保留语境。', category: '划词内容', common: false },
  { token: '{{answer}}', description: '{{ai_result}} 的别名，输出内容完全相同。', category: 'AI 与技能', common: false },
  { token: '{{skill_id}}', description: '技能的内部编号，适合自动分类或脚本处理。', category: 'AI 与技能', common: false },
  { token: '{{model}}', description: '生成本条结果时使用的 AI 模型名称。', category: 'AI 与技能', common: false },
  { token: '{{captured_at}}', description: '浏览器中真正发生划词时的日期和时间。', category: '时间', common: false },
  { token: '{{source_app}}', description: '来源应用名称，例如 Chrome、Edge 或 Windows。', category: '来源', common: false },
  { token: '{{source_type}}', description: '来源类型：web、subtitle、video 或 desktop。', category: '来源', common: false },
  { token: '{{source_site}}', description: '网站或平台名称，例如 YouTube、Bilibili。', category: '来源', common: false },
  { token: '{{source_title_yaml}}', description: '经过转义的来源标题，适合安全放入 YAML 属性。', category: '来源', common: false },
  { token: '{{source_url}}', description: '清理追踪参数后的原始网页链接；视频链接不额外添加时间。', category: '来源', common: false },
  { token: '{{source_host}}', description: '来源网站域名，例如 youtube.com。', category: '来源', common: false },
  { token: '{{source_icon}}', description: '简单来源图标，例如 ▶、📺 或 🌐。', category: '来源', common: false },
  { token: '{{source_favicon}}', description: '网站图标保存在 Obsidian Vault 中的本地相对路径。', category: '来源', common: false },
  { token: '{{video_seconds}}', description: '视频位置对应的总秒数，例如 512，适合自定义时间链接。', category: '时间', common: false },
  { token: '{{history_space}}', description: '兼容旧模板的预留变量，目前默认输出为空。', category: '内部', common: false },
]

const OBSIDIAN_VARIABLE_CATEGORIES: ObsidianTemplateVariable['category'][] = ['划词内容', 'AI 与技能', '时间', '来源', '内部']

${obsidianPanelMarker}`
      if (!next.includes(obsidianPanelMarker)) throw new Error('[source-location-ui] missing ObsidianPanel marker')
      next = next.replace(obsidianPanelMarker, variableGuide)

      const showPickerState = `  const [showNotePicker, setShowNotePicker] = useState(false)`
      if (!next.includes(showPickerState)) throw new Error('[source-location-ui] missing Obsidian variable state marker')
      next = next.replace(showPickerState, `${showPickerState}\n  const [showMoreVariables, setShowMoreVariables] = useState(false)`)

      const tokenBlock = `              <div className="form-row">
                <label>变量 token</label>
                <div className="token-row">
                  {['{{selection}}', '{{ai_result}}', '{{skill_name}}', '{{model}}', '{{date}}', '{{time}}', '{{source_app}}', '{{history_space}}'].map((t) => (
                    <span key={t} className="token">{t}</span>
                  ))}
                </div>
              </div>`
      const variableBrowser = `              <div className="form-row template-variable-guide">
                <div className="template-variable-guide-head">
                  <div>
                    <label>模板变量</label>
                    <span>共 27 个；常用变量直接显示，其余收进“更多”。点击变量可复制。</span>
                  </div>
                  <span className="template-variable-count">27</span>
                </div>
                <div className="template-variable-common-grid">
                  {OBSIDIAN_TEMPLATE_VARIABLES.filter((item) => item.common).map((item) => (
                    <button
                      key={item.token}
                      type="button"
                      className="template-variable-card"
                      onClick={() => { void window.desktopApi.copyText(item.token); setMessage('已复制变量：' + item.token) }}
                    >
                      <code>{item.token}</code>
                      <small>{item.description}</small>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="template-variable-more-toggle"
                  onClick={() => setShowMoreVariables((value) => !value)}
                  aria-expanded={showMoreVariables}
                >
                  {showMoreVariables ? '收起更多变量' : '更多变量（17）'}
                  <span aria-hidden="true">{showMoreVariables ? '⌃' : '⌄'}</span>
                </button>
                {showMoreVariables ? (
                  <div className="template-variable-more-panel">
                    {OBSIDIAN_VARIABLE_CATEGORIES.map((category) => {
                      const items = OBSIDIAN_TEMPLATE_VARIABLES.filter((item) => !item.common && item.category === category)
                      if (items.length === 0) return null
                      return (
                        <section key={category} className="template-variable-category">
                          <h4>{category}</h4>
                          <div className="template-variable-detail-list">
                            {items.map((item) => (
                              <button
                                key={item.token}
                                type="button"
                                className="template-variable-detail-row"
                                onClick={() => { void window.desktopApi.copyText(item.token); setMessage('已复制变量：' + item.token) }}
                              >
                                <code>{item.token}</code>
                                <span>{item.description}</span>
                              </button>
                            ))}
                          </div>
                        </section>
                      )
                    })}
                  </div>
                ) : null}
              </div>`
      if (!next.includes(tokenBlock)) throw new Error('[source-location-ui] missing Obsidian token block')
      next = next.replace(tokenBlock, variableBrowser)

      const recordCardMarker = `function RecordCard({ item, expanded, onToggle, selectMode, checked, onToggleSelect, onDelete, activeTtsKey, onToggleSpeak }:`
      const helpers = `function sourceLocationLabel(location?: SourceLocation) {
  if (!location) return ''
  const site = location.siteName || location.hostname?.replace(/^www\\./, '') || '网页'
  return location.videoTime ? site + ' · ' + location.videoTime : site
}

function sourceLocationIcon(location?: SourceLocation) {
  return location?.icon || (location?.type === 'subtitle' || location?.type === 'video' ? '▶' : '🌐')
}

function sourceLocationUrl(location?: SourceLocation) {
  return location?.openUrl || location?.normalizedUrl || location?.url || ''
}

${recordCardMarker}`
      if (!next.includes(recordCardMarker)) throw new Error('[source-location-ui] missing RecordCard marker')
      next = next.replace(recordCardMarker, helpers)

      const previewMarker = `<span className="record-preview">{item.selectedText.slice(0, 60)}{item.selectedText.length > 60 ? '...' : ''}</span>`
      const previewWithSource = `${previewMarker}
        {item.sourceLocation ? (
          <span className="record-source-mini" title={item.sourceLocation.title || item.sourceLocation.url}>
            <span aria-hidden="true">{sourceLocationIcon(item.sourceLocation)}</span>
            {sourceLocationLabel(item.sourceLocation)}
          </span>
        ) : null}`
      if (!next.includes(previewMarker)) throw new Error('[source-location-ui] missing record preview marker')
      next = next.replace(previewMarker, previewWithSource)

      const originalBlock = `          <div className="record-source">
            <div className="record-source-label">原文</div>
            <div className="record-source-text">{item.selectedText}</div>
          </div>`
      const sourceBlock = `${originalBlock}
          {item.sourceLocation ? (
            <div className="record-origin-strip">
              <span className="record-origin-icon" aria-hidden="true">{sourceLocationIcon(item.sourceLocation)}</span>
              <span className="record-origin-main">
                <small>{sourceLocationLabel(item.sourceLocation)}</small>
                <strong title={item.sourceLocation.title || item.sourceLocation.url}>{item.sourceLocation.title || item.sourceLocation.hostname || '网页来源'}</strong>
              </span>
              <span className="record-origin-actions">
                <button onClick={(event) => { event.stopPropagation(); const url = sourceLocationUrl(item.sourceLocation); if (url) void window.desktopApi.copyText(url, { openExternal: true }) }}>回到原处</button>
                <button onClick={(event) => { event.stopPropagation(); const url = sourceLocationUrl(item.sourceLocation); if (url) void window.desktopApi.copyText(url).then(() => setActionStatus('来源链接已复制')) }}>复制链接</button>
              </span>
            </div>
          ) : null}`
      if (!next.includes(originalBlock)) throw new Error('[source-location-ui] missing expanded source block marker')
      next = next.replace(originalBlock, sourceBlock)

      return { code: next, map: null }
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [skillShortcutMenuPlugin(), pronunciationCardPlugin(), sourceLocationUiPlugin(), react(), tailwindcss()],
})