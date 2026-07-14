import { createHash } from 'node:crypto';

const USER_VALIDATION_PATTERN = /(我|用户).{0,12}(运行|启动|上传|下载|打开|测试|验证|发现|控制台|报错)|无法启动|编译错误|返回错误|实际测试/;
const SUCCESS_CLAIM_PATTERN = /(全部|已经|已).{0,10}(完成|修复|成功|可用)|BUILD SUCCESS|fully set up|all tasks complete|complete successfully/i;

function textValue(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function shorten(value, max = 1000) {
  const text = textValue(value).replace(/\u0000/g, '').trim();
  if (text.length <= max) return text;
  const tail = Math.min(260, Math.floor(max / 3));
  return `${text.slice(0, max - tail)}\n...[truncated ${text.length - max} chars]...\n${text.slice(-tail)}`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeContent(content) {
  return Array.isArray(content) ? content : [];
}

function summarizeToolInput(name, input = {}) {
  if (name === 'Write') {
    const content = textValue(input.content);
    return {
      file_path: input.file_path,
      content_bytes: Buffer.byteLength(content),
      content_sha256: hash(content)
    };
  }
  if (name === 'Edit') {
    return {
      file_path: input.file_path,
      replace_all: Boolean(input.replace_all),
      old_string: shorten(input.old_string, 320),
      new_string: shorten(input.new_string, 500)
    };
  }
  if (name === 'Bash') {
    return {
      command: shorten(input.command, 1600),
      timeout: input.timeout,
      description: input.description
    };
  }
  if (name === 'Read') {
    return {
      file_path: input.file_path,
      offset: input.offset,
      limit: input.limit
    };
  }

  const safe = { ...input };
  for (const key of ['content', 'prompt', 'description']) {
    if (key in safe) safe[key] = shorten(safe[key], key === 'prompt' ? 700 : 500);
  }
  return safe;
}

function detectCycles(parentById) {
  const cyclic = new Set();
  for (const start of parentById.keys()) {
    const path = new Set();
    let current = start;
    while (current && parentById.has(current)) {
      if (path.has(current)) {
        cyclic.add(current);
        break;
      }
      path.add(current);
      current = parentById.get(current);
    }
  }
  return cyclic.size;
}

export function analyzeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('至少需要一个轨迹文件');
  }

  const records = [];
  const invalidLines = [];
  const fileSummaries = [];
  const eventTypes = {};
  const sessionIds = new Set();
  const uuids = new Set();
  const duplicateEventIds = new Set();
  const parentById = new Map();
  const missingParentCandidates = [];
  const toolCalls = new Map();
  const toolResults = new Map();
  const duplicateToolCalls = new Set();
  const duplicateToolResults = new Set();
  const writePaths = new Set();
  const modelClaims = [];
  const externalUserMessages = [];
  const userValidationMessages = [];
  const buildSignals = [];
  let totalBytes = 0;
  let totalLines = 0;
  let chronologicalRegressions = 0;
  let invalidTimestampCount = 0;

  for (const file of files) {
    const name = String(file.name || 'unnamed.jsonl');
    const content = String(file.content || '');
    const bytes = Buffer.byteLength(content);
    const lines = content.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    totalBytes += bytes;
    totalLines += lines.length;
    let valid = 0;
    let previousTime = null;

    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        invalidLines.push({ file: name, line: lineNumber, reason: error.message });
        return;
      }

      valid += 1;
      const ref = `${name}:L${lineNumber}`;
      const record = { file: name, line: lineNumber, ref, event };
      records.push(record);
      const type = event.type || 'unknown';
      eventTypes[type] = (eventTypes[type] || 0) + 1;
      if (event.sessionId) sessionIds.add(event.sessionId);
      if (event.uuid) {
        if (uuids.has(event.uuid)) duplicateEventIds.add(event.uuid);
        uuids.add(event.uuid);
        parentById.set(event.uuid, event.parentUuid || null);
      }
      if (event.parentUuid) missingParentCandidates.push({ parent: event.parentUuid, ref });

      const time = Date.parse(event.timestamp);
      if (Number.isFinite(time)) {
        if (previousTime != null && time < previousTime) chronologicalRegressions += 1;
        previousTime = time;
      } else if (event.timestamp != null) {
        invalidTimestampCount += 1;
      }

      if (type === 'assistant') {
        for (const part of normalizeContent(event.message?.content)) {
          if (part.type === 'tool_use' && part.id) {
            if (toolCalls.has(part.id)) duplicateToolCalls.add(part.id);
            toolCalls.set(part.id, { ref, name: part.name || 'unknown', input: part.input || {} });
            if (part.name === 'Write' && part.input?.file_path) writePaths.add(part.input.file_path);
            if (part.name === 'Edit' && part.input?.file_path) writePaths.add(part.input.file_path);
          }
          if (part.type === 'text' && SUCCESS_CLAIM_PATTERN.test(part.text || '')) {
            modelClaims.push({ ref, text: shorten(part.text, 500) });
          }
        }
      }

      if (type === 'user') {
        if (typeof event.message?.content === 'string') {
          const message = { ref, text: shorten(event.message.content, 1200), userType: event.userType || 'unknown' };
          externalUserMessages.push(message);
          if (USER_VALIDATION_PATTERN.test(event.message.content)) userValidationMessages.push(message);
        }
        for (const part of normalizeContent(event.message?.content)) {
          if (part.type !== 'tool_result' || !part.tool_use_id) continue;
          if (toolResults.has(part.tool_use_id)) duplicateToolResults.add(part.tool_use_id);
          const resultText = textValue(part.content);
          toolResults.set(part.tool_use_id, {
            ref,
            isError: Boolean(part.is_error),
            content: resultText
          });
          if (/BUILD SUCCESS|Tests run:|npm.*built in|compiled successfully/i.test(resultText)) {
            buildSignals.push({ ref, text: shorten(resultText, 500) });
          }
        }
      }
    });

    fileSummaries.push({ name, bytes, lines: lines.length, valid, sha256: hash(content) });
  }

  const unmatchedCalls = [...toolCalls.keys()].filter((id) => !toolResults.has(id));
  const unmatchedResults = [...toolResults.keys()].filter((id) => !toolCalls.has(id));
  const missingParents = missingParentCandidates.filter((item) => !uuids.has(item.parent));
  const cycleCount = detectCycles(parentById);
  const toolsByName = {};
  for (const call of toolCalls.values()) toolsByName[call.name] = (toolsByName[call.name] || 0) + 1;

  const structuralScore = Math.max(0, Math.round(100
    - Math.min(35, invalidLines.length * 8)
    - Math.min(20, unmatchedCalls.length * 4)
    - Math.min(20, unmatchedResults.length * 4)
    - Math.min(10, duplicateToolCalls.size * 5)
    - Math.min(10, duplicateToolResults.size * 5)
    - Math.min(10, duplicateEventIds.size * 3)
    - Math.min(10, missingParents.length * 2)
    - Math.min(10, cycleCount * 5)
    - Math.min(5, chronologicalRegressions)
    - Math.min(5, invalidTimestampCount)));

  const summary = {
    files: fileSummaries,
    totalBytes,
    totalLines,
    validEvents: records.length,
    invalidLineCount: invalidLines.length,
    invalidLines: invalidLines.slice(0, 20),
    sessionCount: sessionIds.size,
    eventTypes,
    toolCallCount: toolCalls.size,
    toolResultCount: toolResults.size,
    unmatchedCallCount: unmatchedCalls.length,
    unmatchedResultCount: unmatchedResults.length,
    duplicateToolCallCount: duplicateToolCalls.size,
    duplicateToolResultCount: duplicateToolResults.size,
    duplicateEventIdCount: duplicateEventIds.size,
    missingParentCount: missingParents.length,
    cycleCount,
    chronologicalRegressions,
    invalidTimestampCount,
    toolsByName,
    uniqueModifiedPaths: writePaths.size,
    externalUserMessageCount: externalUserMessages.length,
    userValidationSignalCount: userValidationMessages.length,
    modelSuccessClaimCount: modelClaims.length,
    buildSignalCount: buildSignals.length,
    structuralScore
  };

  return {
    summary,
    records,
    evidence: {
      externalUserMessages,
      userValidationMessages,
      modelClaims,
      buildSignals
    },
    toolCalls,
    toolResults
  };
}

export function buildEvidencePack(analysis, maxChars = 180_000) {
  const sections = [];
  const append = (priority, ref, label, content) => {
    sections.push({ priority, text: `[${ref}] ${label}\n${content}` });
  };

  for (const record of analysis.records) {
    const { event, ref } = record;
    if (event.type === 'user' && typeof event.message?.content === 'string') {
      append(1, ref, `EXTERNAL USER MESSAGE userType=${event.userType || 'unknown'}`, shorten(event.message.content, 1800));
    }

    if (event.type === 'assistant') {
      for (const part of normalizeContent(event.message?.content)) {
        if (part.type === 'text') {
          append(SUCCESS_CLAIM_PATTERN.test(part.text || '') ? 1 : 3, ref, 'ASSISTANT STATEMENT', shorten(part.text, 1200));
        }
        if (part.type === 'tool_use') {
          const priority = ['Bash', 'Edit', 'Write', 'Agent'].includes(part.name) ? 2 : 4;
          append(priority, ref, `TOOL CALL id=${part.id} name=${part.name}`, JSON.stringify(summarizeToolInput(part.name, part.input), null, 2));
        }
      }
    }

    if (event.type === 'user') {
      for (const part of normalizeContent(event.message?.content)) {
        if (part.type !== 'tool_result') continue;
        const call = analysis.toolCalls.get(part.tool_use_id);
        const result = analysis.toolResults.get(part.tool_use_id);
        const priority = call?.name === 'Bash' || result?.isError ? 1 : 3;
        append(priority, ref, `TOOL RESULT for=${part.tool_use_id} name=${call?.name || 'unknown'} is_error=${Boolean(part.is_error)}`, shorten(part.content, call?.name === 'Bash' ? 1800 : 800));
      }
    }
  }

  sections.sort((a, b) => a.priority - b.priority);
  let used = 0;
  const selected = [];
  for (const section of sections) {
    if (used + section.text.length > maxChars) continue;
    selected.push(section.text);
    used += section.text.length;
  }

  return {
    text: selected.join('\n\n'),
    includedSections: selected.length,
    omittedSections: sections.length - selected.length,
    characters: used
  };
}
