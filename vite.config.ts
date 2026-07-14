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
  deepLink?: string
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

      const recordCardMarker = `function RecordCard({ item, expanded, onToggle, selectMode, checked, onToggleSelect, onDelete, activeTtsKey, onToggleSpeak }:`
      const helpers = `function sourceLocationLabel(location?: SourceLocation) {
  if (!location) return ''
  const site = location.siteName || location.hostname?.replace(/^www\\./, '') || '网页'
  return location.videoTime ? \`${'${site}'} · ${'${location.videoTime}'}\` : site
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
