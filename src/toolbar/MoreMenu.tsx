import type { ToolbarSkill } from './actionRegistry'
import { SkillIcon } from '../components/SkillIcon'
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
  onPointerEnter,
  onPointerLeave,
}: MoreMenuProps) {
  return (
    <div
      className={'more-menu-layer' + (open ? '' : ' is-hidden')}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div className="more-menu-panel">
        <div className="more-menu-list">
          {skills.map((skill) => (
            <button
              key={skill.id}
              className="more-menu-item"
              onClick={() => onRunSkill(skill.id)}
              disabled={Boolean(busySkill)}
            >
              <span className="more-menu-icon">
                <SkillIcon iconKey={skill.iconKey || 'spark'} />
              </span>
              <span className="more-menu-name">{skill.name}</span>
              <span className={'more-menu-badge ' + (skill.type === 'builtin' ? 'system' : 'ai')}>
                {skill.type === 'builtin' ? '系统' : 'AI'}
              </span>
            </button>
          ))}
          {skills.length === 0 ? (
            <div className="more-menu-empty">没有更多技能</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
