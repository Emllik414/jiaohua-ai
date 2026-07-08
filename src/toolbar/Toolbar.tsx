import { Fragment, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import type { ToolbarAction } from './actionRegistry'
import { SkillIcon } from '../components/SkillIcon'
import './toolbar.css'

type ToolbarProps = {
  actions: ToolbarAction[]
  busySkill: string
  moreOpen: boolean
  visible: boolean
  toolbarRef: RefObject<HTMLDivElement>
  shellRef: RefObject<HTMLDivElement>
  onRunSkill: (skillId: string) => void
  onMore: () => void
  onGripDown: (event: ReactMouseEvent) => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}

export function Toolbar({
  actions,
  busySkill,
  moreOpen,
  visible,
  toolbarRef,
  shellRef,
  onRunSkill,
  onGripDown,
  onPointerEnter,
  onPointerLeave,
}: ToolbarProps) {
  const moreBtnRef = useRef<HTMLButtonElement>(null);

  const handleMoreClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    const rect = moreBtnRef.current?.getBoundingClientRect();
    if (rect) {
      (window.desktopApi as any).toggleToolbarMore({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    } else {
      (window.desktopApi as any).toggleToolbarMore();
    }
  };

  return (
    <div
      ref={shellRef}
      className={'toolbar-layer' + (visible ? '' : ' is-hidden')}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div ref={toolbarRef} className="toolbar-shell">
        <button className="drag-handle" onMouseDown={onGripDown} title="拖拽">
          <svg viewBox="0 0 12 18" width="14" height="18"><circle cx="3" cy="3" r="1.4"/><circle cx="9" cy="3" r="1.4"/><circle cx="3" cy="9" r="1.4"/><circle cx="9" cy="9" r="1.4"/><circle cx="3" cy="15" r="1.4"/><circle cx="9" cy="15" r="1.4"/></svg>
        </button>
        {actions.map((action) => {
          if (action.kind === 'more') {
            return (
              <Fragment key={action.id}>
                <span className="toolbar-separator" />
                <button
                  ref={moreBtnRef}
                  className={'tool-btn' + (moreOpen ? ' active' : '')}
                  aria-label={action.label}
                  title={action.label}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={handleMoreClick}
                >
                  <SkillIcon iconKey={action.iconKey} />
                </button>
              </Fragment>
            )
          }
          return (
            <button
              key={action.id}
              className="tool-btn"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onRunSkill(action.id)}
              disabled={Boolean(busySkill)}
              title={action.skill ? action.skill.name : action.label}
            >
              <SkillIcon iconKey={action.iconKey} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
