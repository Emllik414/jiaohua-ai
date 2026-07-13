import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react'
import { motion } from 'motion/react'
import { SkillIcon } from './SkillIcon'
import {
  captureKeyboardShortcut,
  captureMouseButtonShortcut,
  captureWheelShortcut,
  formatSkillShortcut,
  type SkillShortcut,
} from '../shortcuts/skillShortcut'

type ShortcutSkill = {
  id: string
  name: string
  iconKey?: string
  shortcut?: SkillShortcut | null
}

type Props = {
  skill: ShortcutSkill
  onClose: () => void
  onSaved: () => void | Promise<void>
}

export function SkillShortcutDialog({ skill, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<SkillShortcut | null>(skill.shortcut || null)
  const [recording, setRecording] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const captureRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (recording) captureRef.current?.focus()
  }, [recording])

  const accept = (shortcut: SkillShortcut) => {
    setDraft(shortcut)
    setError('')
    setRecording(false)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(false)
      setError('')
      return
    }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return
    try {
      accept(captureKeyboardShortcut(event))
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : String(captureError))
    }
  }

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      accept(captureWheelShortcut(event))
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : String(captureError))
    }
  }

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (![1, 3, 4].includes(event.button)) return
    event.preventDefault()
    event.stopPropagation()
    try {
      accept(captureMouseButtonShortcut(event))
    } catch (captureError) {
      setError(captureError instanceof Error ? captureError.message : String(captureError))
    }
  }

  const save = async () => {
    if (!draft || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await window.desktopApi.setSkillShortcut(skill.id, draft)
      if (!result.ok) {
        setError(result.error || '快捷键保存失败。')
        return
      }
      await onSaved()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  const clear = async () => {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      const result = await window.desktopApi.clearSkillShortcut(skill.id)
      if (!result.ok) {
        setError(result.error || '快捷键清除失败。')
        return
      }
      await onSaved()
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className='skill-modal-backdrop shortcut-modal-backdrop' onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <motion.div
        className='skill-shortcut-modal'
        initial={{ opacity: 0, y: 14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.18 }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className='skill-shortcut-header'>
          <div>
            <div className='skill-shortcut-eyebrow'>技能快捷键</div>
            <div className='skill-shortcut-title'>设置快捷键</div>
          </div>
          <button className='skill-modal-close' onClick={onClose} aria-label='关闭'>×</button>
        </header>

        <div className='skill-shortcut-body'>
          <div className='skill-shortcut-skill'>
            <span className='skill-shortcut-icon'><SkillIcon iconKey={skill.iconKey || 'spark'} /></span>
            <div>
              <strong>{skill.name}</strong>
              <span>划词后工具条仍会正常弹出，按快捷键可直接执行此技能。</span>
            </div>
          </div>

          <div className='skill-shortcut-current'>
            <span>当前快捷键</span>
            <strong>{draft ? formatSkillShortcut(draft) : '未设置'}</strong>
          </div>

          <div
            ref={captureRef}
            className={'skill-shortcut-capture' + (recording ? ' recording' : '')}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onContextMenu={(event) => event.preventDefault()}
            onClick={() => { setRecording(true); setError('') }}
          >
            <div className='skill-shortcut-capture-ring'>⌨</div>
            <strong>{recording ? '正在录制快捷键…' : '点击这里重新录制'}</strong>
            <span>按键盘组合、滚轮中键、侧键 1、侧键 2，或带修饰键的滚轮方向。</span>
          </div>

          <div className='skill-shortcut-rules'>
            <div>键盘快捷键必须包含 Ctrl、Alt、Shift 或 Meta。</div>
            <div>滚轮上/下必须搭配修饰键；滚轮中键和两个侧键可以单独使用。</div>
            <div>快捷键只在有效划词工具条出现期间生效。</div>
          </div>

          {error ? <div className='skill-error'>{error}</div> : null}
        </div>

        <footer className='skill-shortcut-footer'>
          <button className='shortcut-clear-btn' onClick={clear} disabled={saving || !skill.shortcut}>清除快捷键</button>
          <div className='grow' />
          <button className='btn' onClick={onClose} disabled={saving}>取消</button>
          <button className='primary' onClick={save} disabled={saving || !draft}>{saving ? '保存中…' : '保存'}</button>
        </footer>
      </motion.div>
    </div>
  )
}
