const HISTORY_DB = 'traceaudit-history';
const HISTORY_STORE = 'audits';
const MAX_QUEUE_FILES = 50;
const MAX_FILE_BYTES = 31 * 1024 * 1024;
const MAX_QUEUE_BYTES = 256 * 1024 * 1024;

const state = {
  files: [],
  history: [],
  result: null,
  activeHistoryId: null,
  controller: null,
  settings: {
    apiKey: sessionStorage.getItem('traceaudit_api_key') || '',
    model: sessionStorage.getItem('traceaudit_model') || 'gpt-5.4-mini',
    effort: 'low',
    baseUrl: sessionStorage.getItem('traceaudit_base_url') || 'https://api.openai.com/v1',
    apiMode: 'responses'
  }
};

if (['gpt-5.5', 'gpt-4.1-mini'].includes(state.settings.model)) {
  state.settings.model = 'gpt-5.4-mini';
  sessionStorage.setItem('traceaudit_model', state.settings.model);
}

const $ = (selector) => document.querySelector(selector);
const elements = {
  fileInput: $('#fileInput'), dropZone: $('#dropZone'), fileList: $('#fileList'), fileCount: $('#fileCount'),
  auditButton: $('#auditButton'), cancelButton: $('#cancelButton'), clearQueueButton: $('#clearQueueButton'),
  settingsButton: $('#settingsButton'), apiStatus: $('#apiStatus'), modelLabel: $('#modelLabel'),
  effortLabel: $('#effortLabel'), apiModeLabel: $('#apiModeLabel'), emptyState: $('#emptyState'),
  preflightSection: $('#preflightSection'), preflightMetrics: $('#preflightMetrics'), preflightBadge: $('#preflightBadge'),
  preflightWarnings: $('#preflightWarnings'), loadingSection: $('#loadingSection'), loadingText: $('#loadingText'),
  historySection: $('#historySection'), historyList: $('#historyList'), historyCount: $('#historyCount'),
  clearHistoryButton: $('#clearHistoryButton'), reportSection: $('#reportSection'), settingsDialog: $('#settingsDialog'),
  auditErrorSection: $('#auditErrorSection'), auditErrorMessage: $('#auditErrorMessage'), auditErrorHint: $('#auditErrorHint'),
  errorSettingsButton: $('#errorSettingsButton'), retryButton: $('#retryButton'), settingsForm: $('#settingsForm'),
  closeSettings: $('#closeSettings'), apiKeyInput: $('#apiKeyInput'), baseUrlInput: $('#baseUrlInput'),
  modelSelect: $('#modelSelect'), customModelField: $('#customModelField'), customModelInput: $('#customModelInput'),
  clearKeyButton: $('#clearKeyButton'), overallScore: $('#overallScore'), scoreRing: $('#scoreRing'),
  verdictBadge: $('#verdictBadge'), reportTitle: $('#reportTitle'), reportSummary: $('#reportSummary'),
  reportTimestamp: $('#reportTimestamp'), reportModel: $('#reportModel'), dimensionGrid: $('#dimensionGrid'),
  resultStatusBadge: $('#resultStatusBadge'), resultAssessment: $('#resultAssessment'),
  majorFlawBadge: $('#majorFlawBadge'), majorFlaws: $('#majorFlaws'), userValidationBadge: $('#userValidationBadge'),
  userValidationContent: $('#userValidationContent'), unsupportedClaims: $('#unsupportedClaims'),
  keyFindings: $('#keyFindings'), limitations: $('#limitations'), promptCountBadge: $('#promptCountBadge'),
  promptList: $('#promptList'), traceFacts: $('#traceFacts'), downloadButton: $('#downloadButton'),
  printButton: $('#printButton'), toast: $('#toast')
};

const effortNames = { low: '低', medium: '中', high: '高' };
const statusNames = {
  reading: '读取中', checking: '预检中', ready: '等待审核', auditing: '审核中',
  completed: '已完成', preflight_failed: '预检失败', audit_failed: '审核失败'
};
let toastTimer;
let historyDbPromise;

function showToast(message, type = 'default') {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast visible${type === 'error' ? ' error' : ''}`;
  toastTimer = setTimeout(() => { elements.toast.className = 'toast'; }, 3600);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatTraceFormat(format) {
  return ({
    claude_code: 'Claude Code', codex_rollout: 'Codex CLI rollout', codex_exec_json: 'Codex exec --json',
    mixed: '混合格式', unknown: '未识别'
  })[format] || format;
}

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pendingFiles() {
  return state.files.filter((file) => ['ready', 'preflight_failed', 'audit_failed'].includes(file.status));
}

function renderSettingsState() {
  const configured = Boolean(state.settings.apiKey);
  const pending = pendingFiles().length;
  elements.apiStatus.textContent = configured ? 'API 已配置' : 'API 未配置';
  elements.apiStatus.className = `status-pill ${configured ? 'status-on' : 'status-off'}`;
  elements.modelLabel.textContent = state.settings.model;
  elements.effortLabel.textContent = effortNames[state.settings.effort] || state.settings.effort;
  elements.apiModeLabel.textContent = 'Responses API';
  elements.auditButton.textContent = pending ? `开始机审（${pending} 份）` : '开始机审';
  elements.auditButton.disabled = pending === 0 || !configured || Boolean(state.controller);
  elements.clearQueueButton.disabled = state.files.length === 0 || Boolean(state.controller);
}

function openSettings() {
  elements.apiKeyInput.value = state.settings.apiKey;
  elements.baseUrlInput.value = state.settings.baseUrl;
  const known = ['gpt-5.4-mini'];
  elements.modelSelect.value = known.includes(state.settings.model) ? state.settings.model : 'custom';
  elements.customModelInput.value = known.includes(state.settings.model) ? '' : state.settings.model;
  elements.customModelField.classList.toggle('hidden', elements.modelSelect.value !== 'custom');
  elements.settingsDialog.showModal();
  setTimeout(() => elements.apiKeyInput.focus(), 0);
}

function statusClass(status) {
  if (status === 'completed') return 'status-good';
  if (status.endsWith('failed')) return 'status-bad';
  if (['checking', 'auditing', 'reading'].includes(status)) return 'status-neutral';
  return 'status-warn';
}

function renderFiles() {
  clear(elements.fileList);
  elements.fileCount.textContent = `${state.files.length} 份`;
  if (!state.files.length) {
    elements.fileList.append(create('p', 'empty-list', '尚未添加文件'));
  } else {
    for (const file of state.files) {
      const item = create('div', `file-item${file.status === 'auditing' ? ' active' : ''}`);
      item.append(create('span', 'file-type', /\.json$/i.test(file.name) ? 'JSON' : 'JSONL'));
      const meta = create('div', 'file-meta');
      meta.append(create('strong', '', file.name), create('span', '', `${formatBytes(file.size)} · ${file.lines} 行`));
      const controls = create('div', 'file-controls');
      const status = create('span', `queue-status ${statusClass(file.status)}`, statusNames[file.status] || file.status);
      controls.append(status);
      if (file.status === 'completed' && file.result) {
        const view = create('button', 'file-action', '查看');
        view.type = 'button';
        view.addEventListener('click', () => renderReport(file.result));
        controls.append(view);
      }
      const remove = create('button', 'remove-file', '×');
      remove.type = 'button';
      remove.disabled = Boolean(state.controller);
      remove.setAttribute('aria-label', `移除 ${file.name}`);
      remove.addEventListener('click', () => removeFile(file.id));
      controls.append(remove);
      item.append(meta, controls);
      if (file.error) item.title = file.error;
      elements.fileList.append(item);
    }
  }
  renderSettingsState();
  renderBatchOverview();
}

function aggregatePreflight() {
  const summaries = state.files.map((file) => file.preflight).filter(Boolean);
  return summaries.reduce((total, summary) => {
    total.validEvents += summary.validEvents || 0;
    total.totalBytes += summary.totalBytes || 0;
    total.promptCount += summary.promptCount || 0;
    total.toolCallCount += summary.toolCallCount || 0;
    total.verificationCallCount += summary.verificationCallCount || 0;
    total.verificationFailureCount += summary.verificationFailureCount || 0;
    total.issueCount += (summary.invalidLineCount || 0) + (summary.unmatchedCallCount || 0)
      + (summary.unmatchedResultCount || 0) + (summary.formatSupport === 'full' ? 0 : 1);
    return total;
  }, { validEvents: 0, totalBytes: 0, promptCount: 0, toolCallCount: 0, verificationCallCount: 0, verificationFailureCount: 0, issueCount: 0 });
}

function metric(label, value) {
  const item = create('div', 'metric');
  item.append(create('strong', '', String(value)), create('span', '', label));
  return item;
}

function renderBatchOverview() {
  const hasFiles = state.files.length > 0;
  elements.preflightSection.classList.toggle('hidden', !hasFiles);
  elements.emptyState.classList.toggle('hidden', hasFiles || state.history.length > 0 || Boolean(state.result));
  if (!hasFiles) return;
  const totals = aggregatePreflight();
  const checking = state.files.filter((file) => ['reading', 'checking'].includes(file.status)).length;
  const ready = state.files.filter((file) => file.status === 'ready').length;
  const completed = state.files.filter((file) => file.status === 'completed').length;
  const failed = state.files.filter((file) => file.status.endsWith('failed')).length;
  clear(elements.preflightMetrics);
  [
    ['队列文件', state.files.length], ['已完成 / 失败', `${completed} / ${failed}`],
    ['Prompt 轮次', totals.promptCount], ['有效事件', totals.validEvents.toLocaleString()],
    ['轨迹体积', formatBytes(totals.totalBytes)], ['工具调用', totals.toolCallCount],
    ['验证调用 / 失败', `${totals.verificationCallCount} / ${totals.verificationFailureCount}`],
    ['等待 / 检查中', `${ready} / ${checking}`]
  ].forEach(([label, value]) => elements.preflightMetrics.append(metric(label, value)));
  elements.preflightBadge.textContent = checking ? `${checking} 份正在预检` : (failed ? `${failed} 份异常` : '批次已就绪');
  elements.preflightBadge.className = `status-pill ${checking ? 'status-neutral' : failed ? 'status-warn' : 'status-good'}`;
  elements.preflightWarnings.classList.toggle('hidden', totals.issueCount === 0 && failed === 0);
  elements.preflightWarnings.textContent = failed
    ? `有 ${failed} 份轨迹处理失败，可以保留在队列中重试；其余文件不受影响。`
    : (totals.issueCount ? `批次中发现 ${totals.issueCount} 项结构或格式风险，模型审核将逐份判断影响。` : '');
}

async function addFiles(fileList) {
  const incoming = [...fileList].filter((file) => /\.(jsonl|json)$/i.test(file.name));
  if (!incoming.length) return showToast('请选择 .jsonl 或 .json 文件', 'error');
  const keys = new Set(state.files.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  const accepted = incoming.filter((file) => !keys.has(`${file.name}:${file.size}:${file.lastModified}`));
  if (state.files.length + accepted.length > MAX_QUEUE_FILES) return showToast(`队列最多保留 ${MAX_QUEUE_FILES} 份文件`, 'error');
  const oversized = accepted.find((file) => file.size > MAX_FILE_BYTES);
  if (oversized) return showToast(`${oversized.name} 超过 31 MB 单文件限制`, 'error');
  const queueBytes = state.files.reduce((sum, file) => sum + file.size, 0) + accepted.reduce((sum, file) => sum + file.size, 0);
  if (queueBytes > MAX_QUEUE_BYTES) return showToast('队列文件总体积不能超过 256 MB', 'error');
  if (!accepted.length) return showToast('所选文件已在队列中');

  const added = await Promise.all(accepted.map(async (file) => {
    const entry = { id: makeId(), name: file.name, size: file.size, lastModified: file.lastModified, content: '', lines: 0, status: 'reading', preflight: null, result: null, error: '' };
    try {
      entry.content = await file.text();
      entry.lines = entry.content.split(/\r?\n/).filter(Boolean).length;
      entry.status = 'checking';
    } catch (error) {
      entry.status = 'preflight_failed';
      entry.error = error.message || '文件读取失败';
    }
    return entry;
  }));
  state.files.push(...added);
  renderFiles();
  for (const file of added.filter((item) => item.status === 'checking')) await runPreflight(file);
  showToast(`已添加 ${added.length} 份轨迹`);
}

async function runPreflight(file) {
  file.status = 'checking';
  file.error = '';
  renderFiles();
  try {
    const response = await fetch('/api/preflight', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ name: file.name, content: file.content }] })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '预检失败');
    file.preflight = payload.summary;
    file.status = 'ready';
  } catch (error) {
    file.status = 'preflight_failed';
    file.error = error.message || '预检失败';
  }
  renderFiles();
}

function removeFile(id) {
  state.files = state.files.filter((file) => file.id !== id);
  renderFiles();
}

function scoreColor(score) {
  if (score >= 80) return '#176b4d';
  if (score >= 60) return '#9b6214';
  return '#a33d3d';
}

function appendList(container, items, className = '') {
  const list = create('ul', `evidence-list ${className}`.trim());
  for (const item of items || []) list.append(create('li', '', item));
  container.append(list);
}

function renderDimensions(report, metadata) {
  clear(elements.dimensionGrid);
  for (const definition of metadata.dimensions) {
    const data = report.dimensions[definition.id];
    const card = create('section', 'dimension-card');
    const heading = create('div', 'dimension-heading');
    const name = create('div', 'dimension-name');
    name.append(create('h3', '', definition.name), create('span', '', `权重 ${definition.weight}%`));
    const score = create('strong', 'dimension-score', `${data.score}`);
    score.style.color = scoreColor(data.score);
    heading.append(name, score);
    const track = create('div', 'score-track');
    const bar = create('span');
    bar.style.width = `${data.score}%`;
    bar.style.background = scoreColor(data.score);
    track.append(bar);
    card.append(heading, track, create('p', 'dimension-reason', data.reason));
    if (data.evidence?.length) {
      const group = create('div', 'evidence-group');
      group.append(create('h4', '', '支持证据'));
      appendList(group, data.evidence);
      card.append(group);
    }
    if (data.deductions?.length) {
      const group = create('div', 'evidence-group');
      group.append(create('h4', '', '扣分原因'));
      appendList(group, data.deductions, 'deduction-list');
      card.append(group);
    }
    card.append(create('p', 'recommendation', `补证建议：${data.recommendation}`));
    elements.dimensionGrid.append(card);
  }
}

function renderUserValidation(data) {
  elements.userValidationBadge.textContent = data.present ? '存在用户验证' : '未发现用户验证';
  elements.userValidationBadge.className = `status-pill ${data.present ? 'status-good' : 'status-warn'}`;
  clear(elements.userValidationContent);
  const stats = create('div', 'validation-meta');
  stats.append(create('span', 'mini-stat', `验证轮次 ${data.rounds}`), create('span', 'mini-stat', `修复后确认 ${data.post_fix_confirmation ? '有' : '无'}`));
  elements.userValidationContent.append(create('p', '', data.reason), stats);
  if (data.evidence?.length) appendList(elements.userValidationContent, data.evidence);
}

function renderResultAssessment(data) {
  const successful = data.status === '已证实成功';
  const failed = data.status === '已证实失败';
  elements.resultStatusBadge.textContent = data.status;
  elements.resultStatusBadge.className = `status-pill ${successful ? 'status-good' : failed ? 'status-bad' : 'status-warn'}`;
  clear(elements.resultAssessment);
  elements.resultAssessment.append(create('p', '', data.reason));
  if (data.evidence?.length) appendList(elements.resultAssessment, data.evidence);
}

function renderMajorFlaws(flaws, metadata) {
  clear(elements.majorFlaws);
  const definitions = new Map(metadata.dimensions.map((item) => [item.id, item.name]));
  elements.majorFlawBadge.textContent = flaws?.length ? `${flaws.length} 项` : '未发现';
  elements.majorFlawBadge.className = `status-pill ${flaws?.length ? 'status-bad' : 'status-good'}`;
  if (!flaws?.length) return elements.majorFlaws.append(create('p', 'empty-result', '没有识别到达到重大瑕疵门槛的问题。'));
  const list = create('div', 'claim-list');
  for (const flaw of flaws) {
    const item = create('div', 'claim-item major-flaw-item');
    item.append(create('strong', '', `${definitions.get(flaw.dimension) || flaw.dimension} · ${flaw.finding}`), create('p', '', `影响：${flaw.impact}`));
    if (flaw.evidence?.length) appendList(item, flaw.evidence, 'deduction-list');
    list.append(item);
  }
  elements.majorFlaws.append(list);
}

function renderUnsupportedClaims(claims) {
  clear(elements.unsupportedClaims);
  if (!claims?.length) return elements.unsupportedClaims.append(create('p', 'empty-result', '没有识别到明显的未支持声明。'));
  const list = create('div', 'claim-list');
  for (const claim of claims) {
    const item = create('div', 'claim-item');
    item.append(create('strong', '', `${claim.evidence_level} · ${claim.claim}`), create('p', '', claim.reason));
    list.append(item);
  }
  elements.unsupportedClaims.append(list);
}

function renderSimpleList(container, items) {
  clear(container);
  for (const item of items || []) container.append(create('li', '', item));
}

function renderPrompts(prompts = []) {
  clear(elements.promptList);
  elements.promptCountBadge.textContent = `${prompts.length} 轮`;
  elements.promptCountBadge.className = `status-pill ${prompts.length ? 'status-neutral' : 'status-warn'}`;
  if (!prompts.length) return elements.promptList.append(create('p', 'empty-result prompt-empty', '轨迹中没有解析到外部用户 Prompt。'));
  for (const prompt of prompts) {
    const details = create('details', 'prompt-item');
    if (prompt.round === 1) details.open = true;
    const summary = create('summary');
    const title = create('strong', '', `第 ${prompt.round} 轮`);
    const preview = prompt.text.replace(/\s+/g, ' ').trim();
    summary.append(title, create('span', 'prompt-preview', preview.slice(0, 100) || '空 Prompt'), create('span', 'prompt-ref', prompt.ref));
    const meta = create('div', 'prompt-meta');
    meta.append(create('span', '', `类型 ${prompt.userType || 'unknown'}`));
    if (prompt.timestamp) meta.append(create('span', '', new Date(prompt.timestamp).toLocaleString('zh-CN')));
    if (prompt.sessionId) meta.append(create('span', '', `会话 ${prompt.sessionId}`));
    details.append(summary, meta, create('pre', 'prompt-text', prompt.text));
    elements.promptList.append(details);
  }
}

function renderFacts(summary, metadata) {
  clear(elements.traceFacts);
  const facts = [
    ['源文件', metadata.source_file?.name || summary.files?.[0]?.name || '未知'],
    ['总行数', summary.totalLines.toLocaleString()], ['轨迹格式', formatTraceFormat(summary.detectedFormat)],
    ['Prompt 轮次', summary.promptCount || 0], ['有效事件', summary.validEvents.toLocaleString()],
    ['无效行', summary.invalidLineCount], ['会话数', summary.sessionCount], ['工具调用', summary.toolCallCount],
    ['孤立调用', summary.unmatchedCallCount], ['孤立结果', summary.unmatchedResultCount],
    ['时间倒序', summary.chronologicalRegressions], ['重复事件 ID', summary.duplicateEventIdCount],
    ['缺失父事件', summary.missingParentCount], ['成功声明', summary.modelSuccessClaimCount],
    ['用户消息', summary.externalUserMessageCount], ['工具失败', summary.toolErrorCount],
    ['验证调用', summary.verificationCallCount], ['验证失败', summary.verificationFailureCount],
    ['重复命令', summary.repeatedCommandCount], ['危险命令信号', summary.destructiveCommandSignalCount],
    ['证据包片段', metadata.evidence_pack.included_sections], ['省略片段', metadata.evidence_pack.omitted_sections]
  ];
  for (const [label, value] of facts) {
    const fact = create('div', 'fact');
    fact.append(create('span', '', label), create('strong', '', String(value)));
    elements.traceFacts.append(fact);
  }
}

function renderReport(result, options = {}) {
  const { report, metadata, deterministic } = result;
  state.result = result;
  const color = scoreColor(report.overall_score);
  elements.overallScore.textContent = report.overall_score;
  elements.scoreRing.style.setProperty('--score', report.overall_score);
  elements.scoreRing.style.setProperty('--score-color', color);
  elements.scoreRing.setAttribute('aria-label', `综合得分 ${report.overall_score} 分`);
  elements.verdictBadge.textContent = report.verdict;
  elements.verdictBadge.style.color = color;
  elements.verdictBadge.style.background = `${color}18`;
  elements.reportTitle.textContent = report.title;
  elements.reportSummary.textContent = report.summary;
  elements.reportModel.textContent = `${metadata.model} · 推理强度 ${effortNames[metadata.effort] || metadata.effort}`;
  const source = metadata.source_file?.name ? ` · ${metadata.source_file.name}` : '';
  elements.reportTimestamp.textContent = `生成时间 ${new Date(metadata.analyzed_at).toLocaleString('zh-CN')}${source}`;
  renderResultAssessment(report.result_assessment);
  renderMajorFlaws(report.major_flaws, metadata);
  renderDimensions(report, metadata);
  renderUserValidation(report.user_validation_assessment);
  renderUnsupportedClaims(report.unsupported_claims);
  renderSimpleList(elements.keyFindings, report.key_findings);
  renderSimpleList(elements.limitations, report.limitations);
  renderPrompts(deterministic.prompts || []);
  renderFacts(deterministic, metadata);
  elements.reportSection.classList.remove('hidden');
  elements.emptyState.classList.add('hidden');
  if (options.scroll !== false) elements.reportSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function errorHint(message) {
  if (/content-type|finish_reason|没有返回|有效 JSON/i.test(message)) return '中转站已响应，但输出格式或长度与标准接口不一致。';
  if (/504|timeout|timed out|超时/i.test(message)) return '上游处理超时，失败文件已保留在队列中，可单独重试。';
  if (/model|模型|does not exist|access/i.test(message)) return '请确认模型 ID 是中转站实际支持的名称。';
  if (/key|auth|401|quota|billing|credit/i.test(message)) return '请检查 API Key、项目额度和账单状态。';
  return '失败不会阻断队列中其他文件，可在修正配置后重试。';
}

async function auditFile(file, signal) {
  const response = await fetch('/api/audit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OpenAI-API-Key': state.settings.apiKey },
    body: JSON.stringify({
      files: [{ name: file.name, content: file.content }], model: state.settings.model,
      effort: state.settings.effort, baseUrl: state.settings.baseUrl, apiMode: state.settings.apiMode
    }),
    signal
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '机审失败');
  payload.metadata.source_file = { name: file.name, size: file.size, last_modified: file.lastModified };
  return payload;
}

async function runAudit() {
  if (!state.settings.apiKey) return openSettings();
  if (!state.files.length) return showToast('请先添加轨迹文件', 'error');
  for (const file of state.files.filter((item) => item.status === 'preflight_failed')) await runPreflight(file);
  const queue = state.files.filter((file) => ['ready', 'audit_failed'].includes(file.status));
  if (!queue.length) return showToast('队列中没有待审文件');

  state.controller = new AbortController();
  elements.cancelButton.classList.remove('hidden');
  elements.loadingSection.classList.remove('hidden');
  elements.auditErrorSection.classList.add('hidden');
  renderFiles();
  let completed = 0;
  let failed = 0;
  let lastResult = null;
  let lastError = '';

  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    if (state.controller.signal.aborted) break;
    file.status = 'auditing';
    file.error = '';
    elements.loadingText.textContent = `正在审核 ${index + 1} / ${queue.length}：${file.name}；已完成 ${completed}，失败 ${failed}`;
    renderFiles();
    try {
      const result = await auditFile(file, state.controller.signal);
      file.status = 'completed';
      file.result = result;
      lastResult = result;
      completed += 1;
      await saveHistory(file, result);
    } catch (error) {
      if (error.name === 'AbortError') {
        file.status = 'ready';
        break;
      }
      file.status = 'audit_failed';
      file.error = error.message || '未知错误';
      lastError = file.error;
      failed += 1;
    }
    renderFiles();
  }

  const cancelled = state.controller.signal.aborted;
  state.controller = null;
  elements.cancelButton.classList.add('hidden');
  elements.loadingSection.classList.add('hidden');
  renderFiles();
  if (lastResult) renderReport(lastResult, { scroll: true });
  if (lastError) {
    elements.auditErrorMessage.textContent = `本批次有 ${failed} 份失败。最后一个错误：${lastError}`;
    elements.auditErrorHint.textContent = errorHint(lastError);
    elements.auditErrorSection.classList.remove('hidden');
  }
  showToast(cancelled ? `已取消，本次完成 ${completed} 份` : `批次结束：完成 ${completed} 份，失败 ${failed} 份`, failed ? 'error' : 'default');
}

function openHistoryDb() {
  if (historyDbPromise) return historyDbPromise;
  historyDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(HISTORY_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
      store.createIndex('analyzedAt', 'analyzedAt');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return historyDbPromise;
}

async function historyOperation(mode, value) {
  const db = await openHistoryDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HISTORY_STORE, mode === 'getAll' ? 'readonly' : 'readwrite');
    const store = transaction.objectStore(HISTORY_STORE);
    const request = mode === 'put' ? store.put(value) : mode === 'delete' ? store.delete(value) : mode === 'clear' ? store.clear() : store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadHistory() {
  try {
    state.history = (await historyOperation('getAll')).sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt));
    renderHistory();
  } catch {
    showToast('浏览器历史存储不可用', 'error');
  }
}

async function saveHistory(file, result) {
  const entry = {
    id: makeId(), fileName: file.name, fileSize: file.size, analyzedAt: result.metadata.analyzed_at,
    score: result.report.overall_score, verdict: result.report.verdict, result
  };
  try {
    await historyOperation('put', entry);
    state.history.unshift(entry);
    renderHistory();
  } catch {
    showToast(`${file.name} 的报告已生成，但未能写入本地历史`, 'error');
  }
}

function renderHistory() {
  const hasHistory = state.history.length > 0;
  elements.historySection.classList.toggle('hidden', !hasHistory);
  elements.historyCount.textContent = `${state.history.length} 份`;
  clear(elements.historyList);
  for (const entry of state.history) {
    const row = create('div', `history-row${entry.id === state.activeHistoryId ? ' active' : ''}`);
    const score = create('strong', 'history-score', String(entry.score));
    score.style.color = scoreColor(entry.score);
    const meta = create('div', 'history-meta');
    meta.append(create('strong', '', entry.fileName), create('span', '', `${entry.verdict} · ${new Date(entry.analyzedAt).toLocaleString('zh-CN')}`));
    const actions = create('div', 'history-row-actions');
    const view = create('button', 'button button-secondary', '查看');
    view.type = 'button';
    view.addEventListener('click', () => {
      state.activeHistoryId = entry.id;
      renderHistory();
      renderReport(entry.result);
    });
    const remove = create('button', 'icon-button history-delete', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `删除 ${entry.fileName} 的历史报告`);
    remove.addEventListener('click', async () => {
      await historyOperation('delete', entry.id);
      state.history = state.history.filter((item) => item.id !== entry.id);
      if (state.activeHistoryId === entry.id) state.activeHistoryId = null;
      renderHistory();
      renderBatchOverview();
    });
    actions.append(view, remove);
    row.append(score, meta, actions);
    elements.historyList.append(row);
  }
  renderBatchOverview();
}

function downloadReport() {
  if (!state.result) return;
  const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const source = state.result.metadata.source_file?.name?.replace(/\.(jsonl|json)$/i, '').replace(/[^\w.-]+/g, '-') || 'trajectory';
  link.href = url;
  link.download = `${source}-quality-audit.json`;
  link.click();
  URL.revokeObjectURL(url);
}

elements.fileInput.addEventListener('change', (event) => {
  addFiles(event.target.files);
  event.target.value = '';
});
for (const eventName of ['dragenter', 'dragover']) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add('dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove('dragging');
  });
}
elements.dropZone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
elements.settingsButton.addEventListener('click', openSettings);
elements.errorSettingsButton.addEventListener('click', openSettings);
elements.retryButton.addEventListener('click', runAudit);
elements.closeSettings.addEventListener('click', () => elements.settingsDialog.close());
elements.modelSelect.addEventListener('change', () => elements.customModelField.classList.toggle('hidden', elements.modelSelect.value !== 'custom'));
elements.settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const apiKey = elements.apiKeyInput.value.trim();
  const baseUrl = elements.baseUrlInput.value.trim().replace(/\/$/, '');
  const model = elements.modelSelect.value === 'custom' ? elements.customModelInput.value.trim() : elements.modelSelect.value;
  if (!apiKey) return showToast('请输入 API Key', 'error');
  try {
    const parsed = new URL(baseUrl);
    const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new Error();
  } catch {
    return showToast('Base URL 必须是 HTTPS 地址；仅本机地址允许 HTTP', 'error');
  }
  if (!/^[a-zA-Z0-9._:-]{2,100}$/.test(model)) return showToast('模型名称格式不正确', 'error');
  state.settings = { apiKey, model, effort: 'low', baseUrl, apiMode: 'responses' };
  sessionStorage.setItem('traceaudit_api_key', apiKey);
  sessionStorage.setItem('traceaudit_model', model);
  sessionStorage.setItem('traceaudit_base_url', baseUrl);
  elements.settingsDialog.close();
  renderSettingsState();
  showToast('API 配置已保存到当前会话');
});
elements.clearKeyButton.addEventListener('click', () => {
  state.settings.apiKey = '';
  sessionStorage.removeItem('traceaudit_api_key');
  elements.apiKeyInput.value = '';
  renderSettingsState();
  showToast('API Key 已清除');
});
elements.auditButton.addEventListener('click', runAudit);
elements.cancelButton.addEventListener('click', () => state.controller?.abort());
elements.clearQueueButton.addEventListener('click', () => {
  state.files = [];
  renderFiles();
});
elements.clearHistoryButton.addEventListener('click', async () => {
  if (!confirm('确定清空所有本地历史机审结果？')) return;
  await historyOperation('clear');
  state.history = [];
  state.activeHistoryId = null;
  renderHistory();
  showToast('历史机审结果已清空');
});
elements.downloadButton.addEventListener('click', downloadReport);
elements.printButton.addEventListener('click', () => window.print());

renderFiles();
loadHistory();
