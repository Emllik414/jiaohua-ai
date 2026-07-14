import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function skillShortcutMenuPlugin(): Plugin {
  return {
    name: 'jiaohua-skill-shortcut-menu',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/App.tsx')) return null

      // App.tsx may be checked out with CRLF on Windows. Normalize only the
      // in-memory transform input so marker matching is independent of the
      // developer's Git/autocrlf configuration. The source file on disk is
      // not modified.
      const normalizedCode = code.replace(/\r\n?/g, '\n')
      const opening = `          <div className={'skill-menu ' + menuSide} ref={menuRef} draggable={false} onMouseDown={(event) => event.stopPropagation()}>`
      const closing = `\n          </div>\n        ) : null}`
      const start = normalizedCode.indexOf(opening)
      if (start < 0) {
        throw new Error('[skill-shortcut-menu] cannot find the skill menu opening marker in src/App.tsx')
      }
      const contentStart = start + opening.length
      const end = normalizedCode.indexOf(closing, contentStart)
      if (end < 0) {
        throw new Error('[skill-shortcut-menu] cannot find the skill menu closing marker in src/App.tsx')
      }

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

      return {
        code: normalizedCode.slice(0, contentStart) + menuItems + normalizedCode.slice(end),
        map: null,
      }
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
      if (disabledCount !== 4) {
        throw new Error(`[pronunciation-card] expected 4 running-state audio locks, found ${disabledCount}`)
      }
      next = next.split(disabledMarker).join('')

      return { code: next, map: null }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [skillShortcutMenuPlugin(), pronunciationCardPlugin(), react(), tailwindcss()],
})
