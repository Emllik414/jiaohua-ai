import type { ReactNode, RefObject } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import iconImg from '../assets/icon.png'
import './toolbar.css'

type ResultCardChromeProps = {
  title: string
  subtitle: string
  status: string
  sourceExpanded: boolean
  selectedText: string
  cardRef?: RefObject<HTMLDivElement>
  footer: ReactNode
  statusLine?: string
  children: ReactNode
  onToggleSource: () => void
  onClose: () => void
  onHeaderMouseDown: (event: ReactMouseEvent) => void
  onPointerEnter: () => void
  onPointerLeave: () => void
  onPointerDown: () => void
}

export function ResultCardChrome({
  title,
  subtitle,
  status,
  sourceExpanded,
  selectedText,
  cardRef,
  footer,
  statusLine,
  children,
  onToggleSource,
  onClose,
  onHeaderMouseDown,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
}: ResultCardChromeProps) {
  return (
    <div
      ref={cardRef}
      className="result-card-v2"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onMouseDown={onPointerDown}
      onPointerDown={onPointerDown}
    >
      <header className="result-card-header" onMouseDown={onHeaderMouseDown}>
        <div className="result-card-title">
          <img className="result-card-mark" src={iconImg} alt="" />
          <div>
            <strong>{title}</strong>
            <span>{status === 'running' ? '正在生成中...' : subtitle}</span>
          </div>
        </div>
        <div className="result-card-actions">
          <button onClick={onClose} title="关闭">×</button>
        </div>
      </header>
      <main className="result-card-content">
        <button className="source-toggle" onClick={onToggleSource}>
          <span>{sourceExpanded ? '⌄' : '›'}</span>
          {sourceExpanded ? '收起原文' : '查看原文'}
        </button>
        {sourceExpanded ? <div className="selected-box"><p>{selectedText}</p></div> : null}
        {children}
      </main>
      <footer className="result-card-footer">{footer}</footer>
      {statusLine ? <div className="result-status">{statusLine}</div> : null}
    </div>
  )
}
