export type ToolbarSkill = {
  id: string
  name: string
  icon: string
  enabled: boolean
  showInToolbar: boolean
  sortOrder: number
  type?: 'ai' | 'builtin'
  builtinAction?: string
}

export type ToolbarMode = 'english-word' | 'english-sentence' | 'chinese' | 'unknown'

export type ToolbarAction =
  | { kind: 'skill'; id: string; label: string; icon: string; skill: ToolbarSkill }
  | { kind: 'more'; id: 'more'; label: string; icon: string }

const TOOLBAR_SKILL_LIMIT = 5

const ICONS = {
  copy: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  more: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>',
}

export function detectToolbarMode(text: string): ToolbarMode {
  const value = String(text || '').trim()
  if (!value) return 'unknown'
  if (/[\u4e00-\u9fff]/.test(value)) return 'chinese'
  const words = value.split(/\s+/).filter(Boolean)
  if (/^[A-Za-z][A-Za-z'-]*$/.test(value)) return 'english-word'
  if (words.length > 1) return 'english-sentence'
  return 'unknown'
}

export function displaySkillLabel(skill: ToolbarSkill) {
  const label = String(skill.name || '')
    .replace('朗文翻译', '朗文')
    .replace('辅助阅读', '阅读')
    .replace('新技能', '新技')
  return Array.from(label).slice(0, 2).join('')
}

function skillAction(skill: ToolbarSkill): ToolbarAction {
  return { kind: 'skill', id: skill.id, label: displaySkillLabel(skill), icon: skill.icon, skill }
}

function orderedEnabledSkills(skills: ToolbarSkill[]) {
  return [...skills]
    .filter((skill) => skill.enabled)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
}

export function buildToolbarActions(skills: ToolbarSkill[], selection: string): ToolbarAction[] {
  void selection
  const primary = orderedEnabledSkills(skills)
    .filter((skill) => skill.showInToolbar)
    .slice(0, TOOLBAR_SKILL_LIMIT)
    .map(skillAction)

  return [
    ...primary,
    { kind: 'more', id: 'more', label: '更多', icon: ICONS.more },
  ]
}

export function buildMoreMenuSkills(skills: ToolbarSkill[], selection: string): ToolbarSkill[] {
  void selection
  const primaryIds = new Set(
    buildToolbarActions(skills, '')
      .filter((action) => action.kind === 'skill')
      .map((action) => action.id),
  )
  return orderedEnabledSkills(skills)
    .filter((skill) => !skill.showInToolbar || !primaryIds.has(skill.id))
}
