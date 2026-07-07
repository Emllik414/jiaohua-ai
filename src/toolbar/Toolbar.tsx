import { Fragment, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import type { ToolbarAction } from './actionRegistry'
import './toolbar.css'

type ToolbarProps = {
  actions: ToolbarAction[]
  busySkill: string
  moreOpen: boolean
  visible: boolean
  toolbarRef: RefObject<HTMLDivElement>
  shellRef: RefObject<HTMLDivElement>
  onRunSkill: (skillId: string) => void
  onCopy: () => void
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
  onCopy,
  onMore,
  onGripDown,
  onPointerEnter,
  onPointerLeave,
}: ToolbarProps) {
  return (
    <div
      ref={shellRef}
      className={'toolbar-layer' + (visible ? '' : ' is-hidden')}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div ref={toolbarRef} className="selection-toolbar" onMouseDown={onGripDown} title="按住空白处拖动">
        {actions.map((action) => {
          if (action.kind === 'copy') {
            return (
              <button key={action.id} className="toolbar-button" onMouseDown={(event) => event.stopPropagation()} onClick={onCopy}>
                <span className="toolbar-button-icon" dangerouslySetInnerHTML={{ __html: action.icon }} />
                <span className="toolbar-button-label">{action.label}</span>
              </button>
            )
          }
          if (action.kind === 'more') {
            return (
              <Fragment key={action.id}>
                <span className="toolbar-separator" aria-hidden="true" />
                <button
                  className={'toolbar-button more-button' + (moreOpen ? ' is-active' : '')}
                  aria-label={action.label}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={onMore}
                >
                  <span className="toolbar-button-icon" dangerouslySetInnerHTML={{ __html: action.icon }} />
                </button>
              </Fragment>
            )
          }
          return (
            <button
              key={action.id}
              className="toolbar-button"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => onRunSkill(action.id)}
              disabled={Boolean(busySkill)}
            >
              <span className="toolbar-button-icon">{action.icon}</span>
              <span className="toolbar-button-label">{busySkill === action.id ? '处理中' : action.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
