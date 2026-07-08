export type ToolbarSkill = {
  id: string
  name: string
  iconKey?: string
  enabled: boolean
  showInToolbar: boolean
  sortOrder: number
  type?: 'ai' | 'builtin'
  builtinAction?: string
}

export type ToolbarMode = 'english-word' | 'english-sentence' | 'chinese' | 'unknown'

export type ToolbarAction =
  | { kind: 'skill'; id: string; label: string; iconKey?: string; skill: ToolbarSkill }
  | { kind: 'more'; id: 'more'; label: string; iconKey?: string }

const TOOLBAR_SKILL_LIMIT = 5


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
  return Array.from(label).slice(0, 2).join('')
}

function skillAction(skill: ToolbarSkill): ToolbarAction {
  return { kind: 'skill', id: skill.id, label: displaySkillLabel(skill), iconKey: skill.iconKey || 'spark', skill }
}

function sortedSkills(skills: ToolbarSkill[]) {
  return [...skills].sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999))
}

export function buildToolbarActions(skills: ToolbarSkill[], selection: string): ToolbarAction[] {
  void selection
  const primary = sortedSkills(skills)
    .slice(0, TOOLBAR_SKILL_LIMIT)
    .map(skillAction)
  return [
    ...primary,
    { kind: 'more', id: 'more', label: '更多', iconKey: 'more' },
  ]
}

export function buildMoreMenuSkills(skills: ToolbarSkill[], selection: string): ToolbarSkill[] {
  void selection
  return sortedSkills(skills).slice(TOOLBAR_SKILL_LIMIT)
}


