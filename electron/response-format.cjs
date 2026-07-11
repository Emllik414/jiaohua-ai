const RESPONSE_FORMATS = new Set(['rich', 'plain', 'json', 'code', 'template']);

function inferResponseFormat(skill = {}) {
  const prompt = `${skill.systemPrompt || ''}\n${skill.userPrompt || ''}`.trim();

  const explicitlyJson = /(?:只|仅|必须|请)?(?:返回|输出|生成|提供).{0,12}(?:合法|有效|严格)?\s*json\b/i.test(prompt)
    || /(?:json\b).{0,12}(?:格式|对象|数组).{0,8}(?:返回|输出)/i.test(prompt);
  if (explicitlyJson) return 'json';

  const explicitlyCode = /(?:只|仅)(?:返回|输出|生成).{0,8}(?:代码|源码|code)/i.test(prompt)
    || /(?:不要|无需).{0,8}(?:解释|说明).{0,12}(?:只|仅).{0,6}(?:代码|code)/i.test(prompt);
  if (explicitlyCode) return 'code';

  const explicitlyPlain = /(?:纯文本|plain\s*text)/i.test(prompt)
    || /(?:不要|禁止|不使用).{0,8}(?:markdown|md\s*格式|任何格式标记)/i.test(prompt);
  if (explicitlyPlain) return 'plain';

  const strictTemplate = /(?:严格|必须|只|仅).{0,8}(?:按照|遵循|使用).{0,8}(?:以下|下面|给定|指定).{0,6}(?:格式|模板|结构)/i.test(prompt)
    || /(?:保持|保留).{0,6}(?:以下|下面|原有).{0,6}(?:格式|模板|结构)/i.test(prompt);
  if (strictTemplate) return 'template';

  const explicitMachineFormat = /(?:只|仅)(?:返回|输出|生成).{0,8}(?:csv|xml|ya?ml|jsonl|ndjson)\b/i.test(prompt)
    || /(?:csv|xml|ya?ml|jsonl|ndjson)\b.{0,10}(?:格式).{0,8}(?:返回|输出)/i.test(prompt);
  if (explicitMachineFormat) return 'template';

  return 'rich';
}

function formatPolicy(format) {
  switch (RESPONSE_FORMATS.has(format) ? format : 'rich') {
    case 'json':
      return [
        '只返回一个合法 JSON 值，不要使用 Markdown 代码围栏。',
        '不要在 JSON 前后添加解释、标题或开场白。',
        '格式要求不得改变用户要求的数据含义。',
      ].join('\n');
    case 'code':
      return [
        '只返回任务所需的代码，不要添加解释、标题或 Markdown 代码围栏。',
        '保留代码所需的缩进和换行。',
      ].join('\n');
    case 'plain':
      return [
        '使用纯文本回答，不要使用 Markdown 标记、标题符号或代码围栏。',
        '可以保留必要的自然段，但不要添加无关开场白。',
      ].join('\n');
    case 'template':
      return [
        '严格遵循用户任务中指定的格式或模板。',
        '不要擅自增加章节、开场白或格式说明。',
      ].join('\n');
    default:
      return [
        '根据内容需要使用简洁、合法的 GitHub Flavored Markdown。',
        '短回答直接给出正文，不要强制添加标题；只有存在明确章节时才使用 ## 或 ###。',
        '枚举内容使用 Markdown 有序或无序列表，引用原文时使用引用块。',
        '不要用空格模拟列表或缩进，不要滥用标题和粗体，不要输出 HTML。',
        '不要输出开场白、格式说明或内部规则。',
        '这些要求只控制排版，不得改变、删减或扩展用户要求的内容。',
      ].join('\n');
  }
}

function buildFormattingInstruction(skill) {
  const responseFormat = inferResponseFormat(skill);
  return { responseFormat, instruction: formatPolicy(responseFormat) };
}

module.exports = { RESPONSE_FORMATS, inferResponseFormat, formatPolicy, buildFormattingInstruction };
