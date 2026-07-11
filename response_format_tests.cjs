const assert = require('assert');
const { inferResponseFormat, formatPolicy } = require('./electron/response-format.cjs');

const skill = (userPrompt, systemPrompt = '') => ({ userPrompt, systemPrompt });

assert.equal(inferResponseFormat(skill('请解释 JSON 的工作原理')), 'rich');
assert.equal(inferResponseFormat(skill('只返回合法 JSON，不要 Markdown')), 'json');
assert.equal(inferResponseFormat(skill('请输出 JSON 格式的对象')), 'json');
assert.equal(inferResponseFormat(skill('只输出代码，不要解释')), 'code');
assert.equal(inferResponseFormat(skill('解释这段代码为什么会报错')), 'rich');
assert.equal(inferResponseFormat(skill('请用纯文本回答，不要使用 Markdown')), 'plain');
assert.equal(inferResponseFormat(skill('介绍 Markdown 的常见用法')), 'rich');
assert.equal(inferResponseFormat(skill('严格按照下面的模板回答：\n结论：\n原因：')), 'template');
assert.equal(inferResponseFormat(skill('只返回 CSV，不要补充解释')), 'template');
assert.equal(inferResponseFormat(skill('解释 XML 和 HTML 的区别')), 'rich');
assert.equal(inferResponseFormat(skill('请总结核心要点')), 'rich');
assert.match(formatPolicy('rich'), /短回答直接给出正文/);
assert.match(formatPolicy('json'), /不要使用 Markdown 代码围栏/);
assert.match(formatPolicy('template'), /严格遵循用户任务/);

console.log('response format tests passed');
