const state = {
  files: [],
  preflight: null,
  result: null,
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
  auditButton: $('#auditButton'), cancelButton: $('#cancelButton'), settingsButton: $('#settingsButton'),
  apiStatus: $('#apiStatus'), modelLabel: $('#modelLabel'), effortLabel: $('#effortLabel'),
  apiModeLabel: $('#apiModeLabel'),
  emptyState: $('#emptyState'), preflightSection: $('#preflightSection'), preflightMetrics: $('#preflightMetrics'),
  preflightBadge: $('#preflightBadge'), preflightWarnings: $('#preflightWarnings'), loadingSection: $('#loadingSection'),
  loadingText: $('#loadingText'), reportSection: $('#reportSection'), settingsDialog: $('#settingsDialog'),
  auditErrorSection: $('#auditErrorSection'), auditErrorMessage: $('#auditErrorMessage'), auditErrorHint: $('#auditErrorHint'),
  errorSettingsButton: $('#errorSettingsButton'), retryButton: $('#retryButton'),
  settingsForm: $('#settingsForm'), closeSettings: $('#closeSettings'), apiKeyInput: $('#apiKeyInput'),
  baseUrlInput: $('#baseUrlInput'),
  modelSelect: $('#modelSelect'), customModelField: $('#customModelField'), customModelInput: $('#customModelInput'),
  clearKeyButton: $('#clearKeyButton'), overallScore: $('#overallScore'), scoreRing: $('#scoreRing'),
  verdictBadge: $('#verdictBadge'), reportTitle: $('#reportTitle'), reportSummary: $('#reportSummary'),
  reportTimestamp: $('#reportTimestamp'), reportModel: $('#reportModel'), dimensionGrid: $('#dimensionGrid'),
  userValidationBadge: $('#userValidationBadge'), userValidationContent: $('#userValidationContent'),
  unsupportedClaims: $('#unsupportedClaims'), keyFindings: $('#keyFindings'), limitations: $('#limitations'),
  traceFacts: $('#traceFacts'), downloadButton: $('#downloadButton'), printButton: $('#printButton'), toast: $('#toast')
};

const effortNames = { low: '低', medium: '中', high: '高' };
let toastTimer;

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

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderSettingsState() {
  const configured = Boolean(state.settings.apiKey);
  elements.apiStatus.textContent = configured ? 'API 已配置' : 'API 未配置';
  elements.apiStatus.className = `status-pill ${configured ? 'status-on' : 'status-off'}`;
  elements.modelLabel.textContent = state.settings.model;
  elements.effortLabel.textContent = effortNames[state.settings.effort] || state.settings.effort;
  elements.apiModeLabel.textContent = state.settings.apiMode === 'chat' ? 'Chat Completions' : 'Responses API';
  elements.auditButton.disabled = state.files.length === 0 || !configured || Boolean(state.controller);
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

function renderFiles() {
  clear(elements.fileList);
  elements.fileCount.textContent = `${state.files.length} / 1`;
  if (state.files.length === 0) {
    elements.fileList.append(create('p', 'empty-list', '尚未添加文件'));
  } else {
    state.files.forEach((file, index) => {
      const item = create('div', 'file-item');
      item.append(create('span', 'file-type', 'JSONL'));
      const meta = create('div', 'file-meta');
      meta.append(create('strong', '', file.name), create('span', '', `${formatBytes(file.size)} · ${file.lines} 行`));
      const remove = create('button', 'remove-file', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除 ${file.name}`);
      remove.addEventListener('click', () => removeFile(index));
      item.append(meta, remove);
      elements.fileList.append(item);
    });
  }
  renderSettingsState();
}

function markPreviousReport() {
  if (!state.result) return;
  const generated = new Date(state.result.metadata.analyzed_at).toLocaleString('zh-CN');
  elements.reportTimestamp.textContent = `上一份成功报告 · ${generated}`;
}

async function addFiles(fileList) {
  const incoming = [...fileList].filter((file) => /\.(jsonl|json)$/i.test(file.name));
  if (!incoming.length) return showToast('请选择 .jsonl 或 .json 文件', 'error');
  if (incoming.length > 1) return showToast('每次只能审核一个轨迹文件', 'error');

  const file = incoming[0];
  const content = await file.text();
  const replacing = state.files.length === 1;
  state.files = [{ name: file.name, size: file.size, lastModified: file.lastModified, content, lines: content.split(/\r?\n/).filter(Boolean).length }];
  markPreviousReport();
  renderFiles();
  await runPreflight();
  if (replacing) showToast('已替换为新的轨迹文件');
}

function removeFile(index) {
  state.files.splice(index, 1);
  state.preflight = null;
  markPreviousReport();
  renderFiles();
  if (state.files.length) runPreflight();
  else {
    elements.preflightSection.classList.add('hidden');
    elements.emptyState.classList.remove('hidden');
  }
}

function requestFiles() {
  return state.files.map(({ name, content }) => ({ name, content }));
}

function metric(label, value) {
  const item = create('div', 'metric');
  item.append(create('strong', '', String(value)), create('span', '', label));
  return item;
}

function renderPreflight(summary) {
  state.preflight = summary;
  elements.emptyState.classList.add('hidden');
  elements.preflightSection.classList.remove('hidden');
  clear(elements.preflightMetrics);
  [
    ['结构分', summary.structuralScore],
    ['有效事件', summary.validEvents.toLocaleString()],
    ['工具调用 / 结果', `${summary.toolCallCount} / ${summary.toolResultCount}`],
    ['用户验证信号', summary.userValidationSignalCount],
    ['文件数', summary.files.length],
    ['轨迹体积', formatBytes(summary.totalBytes)],
    ['修改路径', summary.uniqueModifiedPaths],
    ['构建 / 测试信号', summary.buildSignalCount]
  ].forEach(([label, value]) => elements.preflightMetrics.append(metric(label, value)));

  const issueCount = summary.invalidLineCount + summary.unmatchedCallCount + summary.unmatchedResultCount
    + summary.cycleCount + summary.duplicateEventIdCount + summary.invalidTimestampCount;
  elements.preflightBadge.textContent = issueCount ? `${issueCount} 项结构异常` : '结构检查通过';
  elements.preflightBadge.className = `status-pill ${issueCount ? 'status-warn' : 'status-good'}`;
  elements.preflightWarnings.classList.toggle('hidden', issueCount === 0);
  elements.preflightWarnings.textContent = issueCount
    ? `发现无效行 ${summary.invalidLineCount}、孤立调用 ${summary.unmatchedCallCount}、孤立结果 ${summary.unmatchedResultCount}、重复事件 ${summary.duplicateEventIdCount}、循环父链 ${summary.cycleCount}、无效时间戳 ${summary.invalidTimestampCount}。模型审核会进一步判断影响。`
    : '';
}

async function runPreflight() {
  elements.preflightSection.classList.remove('hidden');
  elements.emptyState.classList.add('hidden');
  elements.preflightBadge.textContent = '正在检查';
  elements.preflightBadge.className = 'status-pill status-neutral';
  try {
    const response = await fetch('/api/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: requestFiles() })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '预检失败');
    renderPreflight(payload.summary);
  } catch (error) {
    elements.preflightBadge.textContent = '检查失败';
    elements.preflightBadge.className = 'status-pill status-bad';
    showToast(error.message, 'error');
  }
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
  stats.append(
    create('span', 'mini-stat', `验证轮次 ${data.rounds}`),
    create('span', 'mini-stat', `修复后确认 ${data.post_fix_confirmation ? '有' : '无'}`)
  );
  elements.userValidationContent.append(create('p', '', data.reason), stats);
  if (data.evidence?.length) appendList(elements.userValidationContent, data.evidence);
}

function renderUnsupportedClaims(claims) {
  clear(elements.unsupportedClaims);
  if (!claims?.length) {
    elements.unsupportedClaims.append(create('p', 'empty-result', '没有识别到明显的未支持声明。'));
    return;
  }
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

function renderFacts(summary, metadata) {
  clear(elements.traceFacts);
  const facts = [
    ['总行数', summary.totalLines.toLocaleString()],
    ['有效事件', summary.validEvents.toLocaleString()],
    ['无效行', summary.invalidLineCount],
    ['会话数', summary.sessionCount],
    ['工具调用', summary.toolCallCount],
    ['孤立调用', summary.unmatchedCallCount],
    ['孤立结果', summary.unmatchedResultCount],
    ['时间倒序', summary.chronologicalRegressions],
    ['重复事件 ID', summary.duplicateEventIdCount],
    ['缺失父事件', summary.missingParentCount],
    ['成功声明', summary.modelSuccessClaimCount],
    ['用户消息', summary.externalUserMessageCount],
    ['证据包片段', metadata.evidence_pack.included_sections],
    ['省略片段', metadata.evidence_pack.omitted_sections]
  ];
  for (const [label, value] of facts) {
    const fact = create('div', 'fact');
    fact.append(create('span', '', label), create('strong', '', String(value)));
    elements.traceFacts.append(fact);
  }
}

function renderReport(result) {
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
  elements.reportTimestamp.textContent = `生成时间 ${new Date(metadata.analyzed_at).toLocaleString('zh-CN')}`;
  renderDimensions(report, metadata);
  renderUserValidation(report.user_validation_assessment);
  renderUnsupportedClaims(report.unsupported_claims);
  renderSimpleList(elements.keyFindings, report.key_findings);
  renderSimpleList(elements.limitations, report.limitations);
  renderFacts(deterministic, metadata);
  elements.reportSection.classList.remove('hidden');
  elements.reportSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function runAudit() {
  if (!state.settings.apiKey) return openSettings();
  if (!state.files.length) return showToast('请先添加轨迹文件', 'error');
  state.controller = new AbortController();
  renderSettingsState();
  elements.cancelButton.classList.remove('hidden');
  elements.loadingSection.classList.remove('hidden');
  elements.auditErrorSection.classList.add('hidden');
  elements.loadingText.textContent = '正在压缩证据并调用模型，长轨迹可能需要一到数分钟...';

  try {
    const response = await fetch('/api/audit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenAI-API-Key': state.settings.apiKey
      },
      body: JSON.stringify({
        files: requestFiles(),
        model: state.settings.model,
        effort: state.settings.effort,
        baseUrl: state.settings.baseUrl,
        apiMode: state.settings.apiMode
      }),
      signal: state.controller.signal
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '机审失败');
    renderReport(payload);
    showToast('机审报告已生成');
  } catch (error) {
    if (error.name !== 'AbortError') {
      const message = error.message || '未知错误';
      elements.auditErrorMessage.textContent = message;
      elements.auditErrorHint.textContent = /content-type|finish_reason|没有返回|有效 JSON/i.test(message)
        ? '中转站已经响应，但格式或输出长度与标准接口不同。保留本错误信息可继续定位；也可切换另一种接口协议重试。'
        : /504|timeout|timed out|超时/i.test(message)
          ? '中转站处理长轨迹时超时。工具已限制单文件证据包体积；建议使用低推理强度后重试。'
        : /model|模型|does not exist|access/i.test(message)
        ? '请确认 gpt-5.4-mini 是中转站支持的实际模型 ID；不一致时在 API 设置中填写自定义模型名。'
        : /404|not found|responses|chat\/completions|unsupported/i.test(message)
          ? '中转站可能不支持当前接口协议。请在 API 设置中切换 Responses API 或 Chat Completions。'
        : /key|auth|401|quota|billing|credit/i.test(message)
          ? '请检查 API Key、项目额度和账单状态。ChatGPT 订阅不等同于 API 额度。'
          : '结构预检结果仍然有效。检查网络和 API 设置后可直接重试，无需重新上传文件。';
      elements.auditErrorSection.classList.remove('hidden');
      showToast(message, 'error');
    } else {
      showToast('审核已取消');
    }
  } finally {
    state.controller = null;
    elements.cancelButton.classList.add('hidden');
    elements.loadingSection.classList.add('hidden');
    renderSettingsState();
  }
}

function downloadReport() {
  if (!state.result) return;
  const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `trajectory-audit-${new Date().toISOString().slice(0, 10)}.json`;
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
  const effort = 'low';
  const apiMode = 'responses';
  state.settings = { apiKey, model, effort, baseUrl, apiMode };
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
elements.downloadButton.addEventListener('click', downloadReport);
elements.printButton.addEventListener('click', () => window.print());

renderFiles();
