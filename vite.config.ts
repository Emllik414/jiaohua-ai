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
              onClick={() => setMenuSkill(null)}
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

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [skillShortcutMenuPlugin(), react(), tailwindcss()],
})
