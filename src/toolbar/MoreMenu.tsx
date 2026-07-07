import type { ToolbarSkill } from './actionRegistry'
import { displaySkillLabel } from './actionRegistry'
import './toolbar.css'

type MoreMenuProps = {
  skills: ToolbarSkill[]
  busySkill: string
  open: boolean
  onRunSkill: (skillId: string) => void
  onSettings: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}

export function MoreMenu({
  skills,
  busySkill,
  open,
  onRunSkill,
  onSettings,
  onPointerEnter,
  onPointerLeave,
}: MoreMenuProps) {
  return (
    <div
      className={'more-menu-layer' + (open ? '' : ' is-hidden')}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div className="more-menu">
        {skills.map((skill) => (
          <button key={skill.id} className="more-menu-item" onClick={() => onRunSkill(skill.id)} disabled={Boolean(busySkill)}>
            <span className="toolbar-button-icon">{skill.icon}</span>
            {displaySkillLabel(skill)}
          </button>
        ))}
        {skills.length ? <div className="more-menu-separator" /> : null}
        <button className="more-menu-item" onClick={onSettings}>自定义设置</button>
      </div>
    </div>
  )
}
