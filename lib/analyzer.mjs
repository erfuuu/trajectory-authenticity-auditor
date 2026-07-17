import { createHash } from 'node:crypto';

const USER_VALIDATION_PATTERN = /(我|用户).{0,12}(运行|启动|上传|下载|打开|测试|验证|发现|控制台|报错)|无法启动|编译错误|返回错误|实际测试/;
const SUCCESS_CLAIM_PATTERN = /(全部|已经|已).{0,10}(完成|修复|成功|可用)|BUILD SUCCESS|fully set up|all tasks complete|complete successfully/i;
const PLAN_PATTERN = /(计划|步骤|阶段|待办|下一步|接下来|先.{0,20}再|我先|todo|in progress)/i;
const STATUS_PATTERN = /(正在|已完成|目前|进展|接下来|检查后|定位到|验证后|下一步)/i;
const VERIFICATION_COMMAND_PATTERN = /(^|\s|\/)(npm|pnpm|yarn)\s+(test|run\s+(test|build|lint|check|e2e))\b|\b(pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|playwright|cypress|curl\s|npm\s+start|node\s+--test)\b/i;
const DESTRUCTIVE_COMMAND_PATTERN = /\brm\s+-[^\n]*r[^\n]*f|\bgit\s+(reset\s+--hard|clean\s+-[^\n]*[df])|\bsudo\b|\bchmod\s+-R\s+777\b|\bDROP\s+(TABLE|DATABASE)\b/i;
const FAILURE_OUTPUT_PATTERN = /(^|\b)(fail(?:ed|ure)?|error|exception|traceback|not ok|command failed|build failed)(\b|:)|(?:process\s+)?exit(?:ed)?\s+(?:with\s+)?code\s*[=:]?\s*[1-9]|["']?exit_code["']?\s*:\s*[1-9]/i;

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

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textValue(content?.text || content?.message || '');
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return part?.text || part?.content || part?.message || '';
  }).filter(Boolean).join('\n');
}

function parseToolArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { raw_arguments: shorten(value, 1600) };
  }
}

function codexToolName(name) {
  if (['exec_command', 'shell', 'local_shell'].includes(name)) return 'Bash';
  if (name === 'apply_patch') return 'ApplyPatch';
  if (name === 'update_plan') return 'Plan';
  return name || 'unknown';
}

function codexResponseItem(payload) {
  const type = payload?.type;
  if (type === 'message') {
    const text = extractContentText(payload.content);
    if (!text || !['user', 'assistant'].includes(payload.role)) return [];
    return payload.role === 'user'
      ? [{ type: 'user', userType: 'external', message: { content: text } }]
      : [{ type: 'assistant', message: { content: [{ type: 'text', text }] } }];
  }
  if (type === 'agent_message') {
    const text = extractContentText(payload.message || payload.text || payload.content);
    return text ? [{ type: 'assistant', message: { content: [{ type: 'text', text }] } }] : [];
  }
  if (type === 'reasoning') {
    const text = extractContentText(payload.summary || payload.content);
    return text ? [{ type: 'assistant', message: { content: [{ type: 'text', text: `[推理摘要] ${text}` }] } }] : [];
  }
  if (['function_call', 'custom_tool_call'].includes(type)) {
    const id = payload.call_id || payload.id;
    if (!id) return [];
    const name = codexToolName(payload.name);
    const input = parseToolArguments(payload.arguments ?? payload.input);
    if (name === 'Bash' && !input.command) input.command = input.cmd || input.command_line || '';
    return [{
      type: 'assistant',
      message: { content: [{
        type: 'tool_use',
        id,
        name,
        input
      }] }
    }];
  }
  if (['function_call_output', 'custom_tool_call_output'].includes(type)) {
    const id = payload.call_id || payload.id;
    if (!id) return [];
    const output = textValue(payload.output ?? payload.content);
    return [{
      type: 'user',
      message: { content: [{
        type: 'tool_result',
        tool_use_id: id,
        content: output,
        is_error: isFailedToolResult({ content: output })
      }] }
    }];
  }
  if (type === 'local_shell_call') {
    const id = payload.call_id || payload.id;
    if (!id) return [];
    return [{
      type: 'assistant',
      message: { content: [{
        type: 'tool_use', id, name: 'Bash', input: { command: payload.action?.command || payload.command || payload.action }
      }] }
    }];
  }
  return [];
}

function codexExecItem(rawEvent) {
  const item = rawEvent.item || {};
  const id = item.id || rawEvent.item_id;
  const completed = rawEvent.type === 'item.completed';
  if (item.type === 'user_message' && completed) {
    const text = extractContentText(item.text || item.content);
    return text ? [{ type: 'user', userType: 'external', message: { content: text } }] : [];
  }
  if (['agent_message', 'reasoning'].includes(item.type) && completed) {
    const text = extractContentText(item.text || item.content);
    return text ? [{ type: 'assistant', message: { content: [{ type: 'text', text }] } }] : [];
  }
  if (item.type === 'command_execution' && id) {
    if (!completed) {
      return [{ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: item.command } }] } }];
    }
    return [{
      type: 'user',
      message: { content: [{
        type: 'tool_result',
        tool_use_id: id,
        content: item.aggregated_output || item.output || '',
        is_error: item.status === 'failed' || (Number.isInteger(item.exit_code) && item.exit_code !== 0)
      }] }
    }];
  }
  if (item.type === 'file_change' && completed && id) {
    const input = { changes: item.changes || item.files || [], status: item.status };
    return [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'FileChange', input }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: textValue(input), is_error: item.status === 'failed' }] } }
    ];
  }
  if (['mcp_tool_call', 'web_search'].includes(item.type) && id) {
    if (!completed) {
      return [{ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: item.type, input: item.arguments || item.query || {} }] } }];
    }
    return [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: textValue(item.result || item.output), is_error: item.status === 'failed' }] } }];
  }
  return [];
}

function normalizeTraceEvent(event) {
  if (['user', 'assistant'].includes(event.type)) return [event];
  if (event.type === 'response_item') return codexResponseItem(event.payload);
  if (['item.started', 'item.completed'].includes(event.type)) return codexExecItem(event);
  return [];
}

function traceFormatFor(event) {
  if (['user', 'assistant'].includes(event.type)) return 'claude_code';
  if (['session_meta', 'response_item', 'event_msg', 'turn_context', 'compacted'].includes(event.type)) return 'codex_rollout';
  if (/^(thread|turn|item)\./.test(event.type || '')) return 'codex_exec_json';
  return 'unknown';
}

function isVerificationCommand(command) {
  return VERIFICATION_COMMAND_PATTERN.test(String(command || ''));
}

function isFailedToolResult(result) {
  return Boolean(result?.isError) || FAILURE_OUTPUT_PATTERN.test(String(result?.content || ''));
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
  if (name === 'ApplyPatch') {
    return {
      patch: shorten(input.patch ?? input.raw_arguments ?? input.input, 1600)
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
  const prompts = [];
  const userValidationMessages = [];
  const buildSignals = [];
  const bashCommandCounts = new Map();
  const traceFormatCounts = new Map();
  let totalBytes = 0;
  let totalLines = 0;
  let chronologicalRegressions = 0;
  let invalidTimestampCount = 0;
  let assistantTextCount = 0;
  let assistantTextChars = 0;
  let planningSignalCount = 0;
  let statusUpdateSignalCount = 0;
  let destructiveCommandSignalCount = 0;

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
      const type = event.type || 'unknown';
      eventTypes[type] = (eventTypes[type] || 0) + 1;
      const traceFormat = traceFormatFor(event);
      traceFormatCounts.set(traceFormat, (traceFormatCounts.get(traceFormat) || 0) + 1);
      const sessionId = event.sessionId || event.thread_id || event.payload?.session_id
        || (event.type === 'session_meta' ? event.payload?.id : null);
      if (sessionId) sessionIds.add(sessionId);
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

      for (const normalizedEvent of normalizeTraceEvent(event)) {
        records.push({ file: name, line: lineNumber, ref, event: normalizedEvent });
        if (normalizedEvent.type === 'assistant') {
          for (const part of normalizeContent(normalizedEvent.message?.content)) {
            if (part.type === 'tool_use' && part.id) {
              if (toolCalls.has(part.id)) duplicateToolCalls.add(part.id);
              toolCalls.set(part.id, { ref, name: part.name || 'unknown', input: part.input || {} });
              if (part.name === 'Write' && part.input?.file_path) writePaths.add(part.input.file_path);
              if (part.name === 'Edit' && part.input?.file_path) writePaths.add(part.input.file_path);
              if (part.name === 'FileChange') {
                for (const change of part.input?.changes || []) {
                  const path = change.path || change.file_path;
                  if (path) writePaths.add(path);
                }
              }
              if (part.name === 'Bash') {
                const command = String(part.input?.command || '').trim();
                if (command) bashCommandCounts.set(command, (bashCommandCounts.get(command) || 0) + 1);
                if (DESTRUCTIVE_COMMAND_PATTERN.test(command)) destructiveCommandSignalCount += 1;
              }
            }
            if (part.type === 'text') {
              const statement = String(part.text || '');
              assistantTextCount += 1;
              assistantTextChars += statement.length;
              if (PLAN_PATTERN.test(statement)) planningSignalCount += 1;
              if (STATUS_PATTERN.test(statement)) statusUpdateSignalCount += 1;
              if (SUCCESS_CLAIM_PATTERN.test(statement)) {
                modelClaims.push({ ref, text: shorten(statement, 500) });
              }
            }
          }
        }

        if (normalizedEvent.type === 'user') {
          if (typeof normalizedEvent.message?.content === 'string') {
            const message = { ref, text: shorten(normalizedEvent.message.content, 1200), userType: normalizedEvent.userType || 'unknown' };
            externalUserMessages.push(message);
            prompts.push({
              round: prompts.length + 1,
              ref,
              file: name,
              timestamp: event.timestamp || null,
              sessionId: sessionId || null,
              userType: normalizedEvent.userType || 'unknown',
              text: normalizedEvent.message.content
            });
            if (USER_VALIDATION_PATTERN.test(normalizedEvent.message.content)) userValidationMessages.push(message);
          }
          for (const part of normalizeContent(normalizedEvent.message?.content)) {
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
  const verificationCalls = [...toolCalls.entries()].filter(([, call]) => call.name === 'Bash' && isVerificationCommand(call.input?.command));
  const verificationResultCount = verificationCalls.filter(([id]) => toolResults.has(id)).length;
  const verificationFailureCount = verificationCalls.filter(([id]) => isFailedToolResult(toolResults.get(id))).length;
  const toolErrorCount = [...toolResults.values()].filter(isFailedToolResult).length;
  const repeatedCommandCount = [...bashCommandCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const recognizedFormats = [...traceFormatCounts.entries()]
    .filter(([format, count]) => format !== 'unknown' && count > 0)
    .sort((a, b) => b[1] - a[1]);
  const detectedFormat = recognizedFormats.length > 1 ? 'mixed' : (recognizedFormats[0]?.[0] || 'unknown');
  const unsupportedEventCount = traceFormatCounts.get('unknown') || 0;
  const formatSupport = detectedFormat === 'unknown'
    ? 'unknown'
    : (unsupportedEventCount > 0 || records.length === 0 ? 'partial' : 'full');

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
    validEvents: fileSummaries.reduce((sum, file) => sum + file.valid, 0),
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
    promptCount: prompts.length,
    userValidationSignalCount: userValidationMessages.length,
    modelSuccessClaimCount: modelClaims.length,
    buildSignalCount: buildSignals.length,
    assistantTextCount,
    assistantTextChars,
    planningSignalCount,
    statusUpdateSignalCount,
    toolErrorCount,
    verificationCallCount: verificationCalls.length,
    verificationResultCount,
    verificationFailureCount,
    repeatedCommandCount,
    destructiveCommandSignalCount,
    detectedFormat,
    formatSupport,
    unsupportedEventCount,
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
    prompts,
    toolCalls,
    toolResults
  };
}

export function buildEvidencePack(analysis, maxChars = 180_000) {
  const sections = [];
  const append = (priority, ref, label, content) => {
    sections.push({ priority, order: sections.length, text: `[${ref}] ${label}\n${content}` });
  };

  for (const record of analysis.records) {
    const { event, ref } = record;
    if (event.type === 'user' && typeof event.message?.content === 'string') {
      append(0, ref, `EXTERNAL USER MESSAGE userType=${event.userType || 'unknown'}`, shorten(event.message.content, 1800));
    }

    if (event.type === 'assistant') {
      for (const part of normalizeContent(event.message?.content)) {
        if (part.type === 'text') {
          const priority = SUCCESS_CLAIM_PATTERN.test(part.text || '')
            ? 1
            : (PLAN_PATTERN.test(part.text || '') || STATUS_PATTERN.test(part.text || '') ? 2 : 3);
          append(priority, ref, 'ASSISTANT STATEMENT', shorten(part.text, 1200));
        }
        if (part.type === 'tool_use') {
          const command = part.name === 'Bash' ? part.input?.command : '';
          const priority = DESTRUCTIVE_COMMAND_PATTERN.test(String(command || '')) || isVerificationCommand(command)
            ? 1
            : (['Bash', 'Edit', 'Write', 'Agent'].includes(part.name) ? 2 : 4);
          append(priority, ref, `TOOL CALL id=${part.id} name=${part.name}`, JSON.stringify(summarizeToolInput(part.name, part.input), null, 2));
        }
      }
    }

    if (event.type === 'user') {
      for (const part of normalizeContent(event.message?.content)) {
        if (part.type !== 'tool_result') continue;
        const call = analysis.toolCalls.get(part.tool_use_id);
        const result = analysis.toolResults.get(part.tool_use_id);
        const priority = call?.name === 'Bash' || isFailedToolResult(result) ? 1 : 3;
        append(priority, ref, `TOOL RESULT for=${part.tool_use_id} name=${call?.name || 'unknown'} is_error=${Boolean(part.is_error)}`, shorten(part.content, call?.name === 'Bash' ? 1800 : 800));
      }
    }
  }

  const rankedSections = [...sections].sort((a, b) => a.priority - b.priority || a.order - b.order);
  let used = 0;
  const selected = [];
  for (const section of rankedSections) {
    if (used + section.text.length > maxChars) continue;
    selected.push(section);
    used += section.text.length;
  }
  selected.sort((a, b) => a.order - b.order);

  return {
    text: selected.map((section) => section.text).join('\n\n'),
    includedSections: selected.length,
    omittedSections: sections.length - selected.length,
    characters: used
  };
}
