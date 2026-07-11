const fs = require('fs');
const path = require('path');
const { Document, HeadingLevel, Packer, Paragraph, TextRun } = require('docx');

const FORMAT_EXTENSIONS = { markdown: '.md', word: '.docx', txt: '.txt' };

function sanitizeFileName(value) {
  let cleaned = [...String(value || '')]
    .map((character) => character.codePointAt(0) < 32 ? '_' : character)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned || 'JiaoHua AI 历史记录';
}

function uniqueFilePath(directory, fileName, extension) {
  const base = sanitizeFileName(fileName).replace(/\.(md|docx|txt)$/i, '');
  let candidate = path.join(directory, `${base}${extension}`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base} (${suffix})${extension}`);
    suffix += 1;
  }
  return candidate;
}

function recordTitle(record, index) {
  return `${index + 1}. ${record.skillName || record.skillId || 'AI 划词'}`;
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '');
}

function renderMarkdown(records, title) {
  const lines = [`# ${title}`, '', `导出时间：${new Date().toLocaleString('zh-CN')}`, ''];
  records.forEach((record, index) => {
    lines.push(
      `## ${recordTitle(record, index)}`,
      '',
      `- 时间：${new Date(record.createdAt).toLocaleString('zh-CN')}`,
      `- 模型：${record.model || '未知'}`,
      `- 来源：${record.sourceApp || 'Windows'}`,
      '',
      '### 原文',
      '',
      record.selectedText || '',
      '',
      '### AI 结果',
      '',
      record.answerMarkdown || '',
      ''
    );
  });
  return lines.join('\n').trimEnd() + '\n';
}

function renderText(records, title) {
  const divider = '='.repeat(64);
  const sections = records.map((record, index) => [
    recordTitle(record, index),
    `时间：${new Date(record.createdAt).toLocaleString('zh-CN')}`,
    `模型：${record.model || '未知'}`,
    `来源：${record.sourceApp || 'Windows'}`,
    '',
    '原文：',
    record.selectedText || '',
    '',
    'AI 结果：',
    stripMarkdown(record.answerMarkdown),
  ].join('\n'));
  return [title, `导出时间：${new Date().toLocaleString('zh-CN')}`, divider, ...sections.flatMap((section) => [section, divider])].join('\n') + '\n';
}

async function renderWord(records, title) {
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: `导出时间：${new Date().toLocaleString('zh-CN')}`, color: '666666' })] }),
  ];
  records.forEach((record, index) => {
    children.push(
      new Paragraph({ text: recordTitle(record, index), heading: HeadingLevel.HEADING_1 }),
      new Paragraph(`时间：${new Date(record.createdAt).toLocaleString('zh-CN')}`),
      new Paragraph(`模型：${record.model || '未知'}`),
      new Paragraph(`来源：${record.sourceApp || 'Windows'}`),
      new Paragraph({ text: '原文', heading: HeadingLevel.HEADING_2 }),
      new Paragraph(record.selectedText || ''),
      new Paragraph({ text: 'AI 结果', heading: HeadingLevel.HEADING_2 }),
      ...stripMarkdown(record.answerMarkdown).split(/\r?\n/).map((line) => new Paragraph(line))
    );
  });
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

async function exportHistoryRecords({ records, format, fileName, directory }) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('没有可导出的历史记录。');
  if (!FORMAT_EXTENSIONS[format]) throw new Error('不支持的导出格式。');
  if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error('导出文件夹不存在。');

  const title = sanitizeFileName(fileName);
  const target = uniqueFilePath(directory, title, FORMAT_EXTENSIONS[format]);
  const content = format === 'markdown'
    ? renderMarkdown(records, title)
    : format === 'txt'
      ? renderText(records, title)
      : await renderWord(records, title);
  fs.writeFileSync(target, content, format === 'word' ? undefined : 'utf8');
  return target;
}

module.exports = { FORMAT_EXTENSIONS, sanitizeFileName, uniqueFilePath, stripMarkdown, renderMarkdown, renderText, renderWord, exportHistoryRecords };
