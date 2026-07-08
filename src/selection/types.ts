/**
 * SelectionEngine — Renderer 端类型定义
 *
 * 与 electron/selection-engine.cjs 中的 JSDoc 类型保持同步。
 */

/** 取词来源 */
export type PickSource = 'browser' | 'windows-uia' | 'ocr' | 'clipboard' | 'manual';

/** 取词结果（从 SelectionEngine.getPickedInfo() 返回） */
export interface PickedInfo {
  /** 规范化的选中文本 — 这是业务层唯一应该使用的值 */
  text: string;
  /** 源端返回的完整文本（如 Ctrl+C 拿到的整句） */
  fullText?: string;
  /** 取词来源 */
  source: PickSource;
  /** 置信度 0-1，< 0.4 视为低置信度 */
  confidence: number;
  /** 选区坐标（屏幕坐标） */
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 源应用名 */
  appName?: string;
  /** 源窗口标题 */
  windowTitle?: string;
  /** 浏览器 URL（仅 browser source） */
  url?: string;
  /** 取词耗时 ms */
  latency?: number;
  /** 附加信息 */
  metadata?: Record<string, unknown>;
  /** @deprecated 保留原 selectedText 字段用于兼容，新代码应使用 text */
  selectedText?: string;
}

/** 取词上下文（传给 SelectionEngine） */
export interface SelectionContext {
  cursorStart?: { x: number; y: number };
  cursorEnd?: { x: number; y: number };
  dragDistance?: number;
  dragDuration?: number;
  foregroundWindowTitle?: string;
  foregroundProcessName?: string;
  isBrowser?: boolean;
  url?: string;
  extra?: Record<string, unknown>;
}

/** selection:ready 事件的新 payload */
export interface SelectionReadyPayload {
  /** 从 SelectionEngine 获取的取词结果 */
  pickedInfo: PickedInfo;
  /** 工具栏技能列表 */
  skills: Skill[];
  /** @deprecated 保留用于兼容 */
  selection: string;
}

// Re-export Skill for convenience
export interface Skill {
  id: string;
  name: string;
  iconKey: string;
  enabled: boolean;
  showInToolbar: boolean;
  systemPrompt: string;
  userPrompt: string;
  outputMode: string;
  sortOrder: number;
  type?: 'ai' | 'builtin';
  builtinAction?: string;
  deletable?: boolean;
}
