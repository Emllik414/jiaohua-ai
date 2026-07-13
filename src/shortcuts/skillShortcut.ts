import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'

export type SkillShortcutKind = 'keyboard' | 'mouse'

export type SkillShortcut = {
  kind: SkillShortcutKind
  value: string
}

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

type ModifierEvent = Pick<KeyboardEvent | WheelEvent | MouseEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

function modifiersFromEvent(event: ModifierEvent) {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  return parts
}

export function captureKeyboardShortcut(event: KeyboardEvent | ReactKeyboardEvent): SkillShortcut {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  const modifiers = modifiersFromEvent(native)
  const rawKey = event.key
  const key = /^[a-z0-9]$/i.test(rawKey)
    ? rawKey.toUpperCase()
    : /^F(?:[1-9]|1[0-2])$/i.test(rawKey)
      ? rawKey.toUpperCase()
      : ''

  if (!key) throw new Error('请使用字母、数字或 F1–F12。')
  if (modifiers.length === 0) throw new Error('键盘快捷键必须包含 Ctrl、Alt、Shift 或 Meta。')
  return { kind: 'keyboard', value: [...modifiers, key].join('+') }
}

export function captureWheelShortcut(event: WheelEvent | ReactWheelEvent): SkillShortcut {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  const modifiers = modifiersFromEvent(native)
  if (modifiers.length === 0) throw new Error('滚轮方向必须搭配 Ctrl、Alt、Shift 或 Meta。')
  const token = native.deltaY < 0 ? 'WheelUp' : 'WheelDown'
  return { kind: 'mouse', value: [...modifiers, token].join('+') }
}

export function captureMouseButtonShortcut(event: MouseEvent | ReactMouseEvent): SkillShortcut {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  const modifiers = modifiersFromEvent(native)
  const token = native.button === 1
    ? 'MouseMiddle'
    : native.button === 3
      ? 'MouseX1'
      : native.button === 4
        ? 'MouseX2'
        : ''
  if (!token) throw new Error('请按滚轮中键、侧键 1 或侧键 2。')
  return { kind: 'mouse', value: [...modifiers, token].join('+') }
}

export function formatSkillShortcut(shortcut?: SkillShortcut | null) {
  if (!shortcut?.value) return ''
  return shortcut.value
    .replace('WheelUp', '滚轮上')
    .replace('WheelDown', '滚轮下')
    .replace('MouseMiddle', '滚轮中键')
    .replace('MouseX1', '侧键 1')
    .replace('MouseX2', '侧键 2')
    .replace(/\+/g, ' + ')
}

export function canonicalShortcutValue(shortcut?: SkillShortcut | null) {
  if (!shortcut?.value) return ''
  const raw = shortcut.value.split('+').map((part) => part.trim()).filter(Boolean)
  const modifiers = new Set(raw.filter((part) => MODIFIER_ORDER.includes(part as typeof MODIFIER_ORDER[number])))
  const token = raw.find((part) => !MODIFIER_ORDER.includes(part as typeof MODIFIER_ORDER[number])) || ''
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), token].filter(Boolean).join('+')
}
