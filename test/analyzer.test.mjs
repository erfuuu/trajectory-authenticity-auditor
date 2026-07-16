import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFiles, buildEvidencePack } from '../lib/analyzer.mjs';

const events = [
  { type: 'user', uuid: 'u1', parentUuid: null, sessionId: 's1', timestamp: '2026-01-01T00:00:00Z', userType: 'external', message: { content: '请实现功能' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's1', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'user', uuid: 'r1', parentUuid: 'a1', sessionId: 's1', timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Tests run: 3 passed', is_error: false }] } },
  { type: 'user', uuid: 'u2', parentUuid: 'r1', sessionId: 's1', timestamp: '2026-01-01T00:00:03Z', userType: 'external', message: { content: '我运行后发现页面报错' } }
];

test('analyzes matching calls and user validation', () => {
  const content = events.map((event) => JSON.stringify(event)).join('\n');
  const analysis = analyzeFiles([{ name: 'trace.jsonl', content }]);
  assert.equal(analysis.summary.validEvents, 4);
  assert.equal(analysis.summary.toolCallCount, 1);
  assert.equal(analysis.summary.toolResultCount, 1);
  assert.equal(analysis.summary.unmatchedCallCount, 0);
  assert.equal(analysis.summary.userValidationSignalCount, 1);
  assert.equal(analysis.summary.buildSignalCount, 1);
  assert.equal(analysis.summary.verificationCallCount, 1);
  assert.equal(analysis.summary.verificationResultCount, 1);
  assert.equal(analysis.summary.verificationFailureCount, 0);
  assert.equal(analysis.summary.duplicateEventIdCount, 0);
  assert.equal(analysis.summary.structuralScore, 100);
});

test('detects duplicated event ids and invalid timestamps', () => {
  const first = { type: 'user', uuid: 'same', timestamp: 'invalid', message: { content: 'one' } };
  const second = { type: 'user', uuid: 'same', timestamp: '2026-01-01T00:00:00Z', message: { content: 'two' } };
  const analysis = analyzeFiles([{ name: 'duplicate.jsonl', content: `${JSON.stringify(first)}\n${JSON.stringify(second)}` }]);
  assert.equal(analysis.summary.duplicateEventIdCount, 1);
  assert.equal(analysis.summary.invalidTimestampCount, 1);
  assert.ok(analysis.summary.structuralScore < 100);
});

test('detects invalid lines and orphaned tool calls', () => {
  const content = `${JSON.stringify(events[1])}\nnot-json`;
  const analysis = analyzeFiles([{ name: 'broken.jsonl', content }]);
  assert.equal(analysis.summary.invalidLineCount, 1);
  assert.equal(analysis.summary.unmatchedCallCount, 1);
  assert.ok(analysis.summary.structuralScore < 100);
});

test('evidence pack omits raw write content and keeps its hash', () => {
  const writeEvent = {
    type: 'assistant',
    uuid: 'a2',
    timestamp: '2026-01-01T00:00:00Z',
    message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/tmp/a.txt', content: 'secret source text' } }] }
  };
  const analysis = analyzeFiles([{ name: 'write.jsonl', content: JSON.stringify(writeEvent) }]);
  const pack = buildEvidencePack(analysis);
  assert.match(pack.text, /content_sha256/);
  assert.doesNotMatch(pack.text, /secret source text/);
});

test('detects failed verification output, repeated commands, and destructive commands', () => {
  const trace = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Tests failed: 2', is_error: false }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Tests failed: 1', is_error: false }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'rm -rf build' } }] } }
  ];
  const analysis = analyzeFiles([{ name: 'signals.jsonl', content: trace.map(JSON.stringify).join('\n') }]);
  assert.equal(analysis.summary.verificationCallCount, 2);
  assert.equal(analysis.summary.verificationFailureCount, 2);
  assert.equal(analysis.summary.toolErrorCount, 2);
  assert.equal(analysis.summary.repeatedCommandCount, 1);
  assert.equal(analysis.summary.destructiveCommandSignalCount, 1);
});

test('keeps selected evidence in original trace order', () => {
  const trace = [
    { type: 'user', message: { content: 'first user requirement' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'routine explanation '.repeat(200) }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Tests run: 3 passed', is_error: false }] } }
  ];
  const analysis = analyzeFiles([{ name: 'ordered.jsonl', content: trace.map(JSON.stringify).join('\n') }]);
  const pack = buildEvidencePack(analysis, 1000);
  assert.ok(pack.text.indexOf('first user requirement') < pack.text.indexOf('npm test'));
  assert.ok(pack.text.indexOf('npm test') < pack.text.indexOf('Tests run: 3 passed'));
});

test('analyzes Codex CLI rollout response items', () => {
  const trace = [
    { timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { id: 'codex-session' } },
    { timestamp: '2026-01-01T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '实现功能并运行测试' }] } },
    { timestamp: '2026-01-01T00:00:02Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}', call_id: 'call-1' } },
    { timestamp: '2026-01-01T00:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Tests run: 3 passed' } },
    { timestamp: '2026-01-01T00:00:04Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'All tasks complete successfully' }] } }
  ];
  const analysis = analyzeFiles([{ name: 'codex-rollout.jsonl', content: trace.map((event) => JSON.stringify(event)).join('\n') }]);
  assert.equal(analysis.summary.detectedFormat, 'codex_rollout');
  assert.equal(analysis.summary.formatSupport, 'full');
  assert.equal(analysis.summary.sessionCount, 1);
  assert.equal(analysis.summary.externalUserMessageCount, 1);
  assert.equal(analysis.summary.toolCallCount, 1);
  assert.equal(analysis.summary.toolResultCount, 1);
  assert.equal(analysis.summary.verificationCallCount, 1);
  assert.equal(analysis.summary.verificationFailureCount, 0);
  assert.equal(analysis.summary.modelSuccessClaimCount, 1);
});

test('recognizes non-zero Codex function output as an error', () => {
  const trace = [
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}', call_id: 'call-1' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Process exited with code 1\n2 tests failed' } }
  ];
  const analysis = analyzeFiles([{ name: 'codex-failure.jsonl', content: trace.map((event) => JSON.stringify(event)).join('\n') }]);
  assert.equal(analysis.summary.toolErrorCount, 1);
  assert.equal(analysis.summary.verificationFailureCount, 1);
});

test('analyzes Codex exec --json command lifecycle', () => {
  const trace = [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'item-1', type: 'command_execution', command: 'node --test', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item-1', type: 'command_execution', command: 'node --test', aggregated_output: 'Tests run: 4 passed', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item-2', type: 'file_change', changes: [{ path: 'lib/a.mjs', kind: 'update' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'item-3', type: 'agent_message', text: '已完成并验证' } },
    { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }
  ];
  const analysis = analyzeFiles([{ name: 'codex-exec.jsonl', content: trace.map((event) => JSON.stringify(event)).join('\n') }]);
  assert.equal(analysis.summary.detectedFormat, 'codex_exec_json');
  assert.equal(analysis.summary.validEvents, 7);
  assert.equal(analysis.summary.sessionCount, 1);
  assert.equal(analysis.summary.toolCallCount, 2);
  assert.equal(analysis.summary.toolResultCount, 2);
  assert.equal(analysis.summary.unmatchedCallCount, 0);
  assert.equal(analysis.summary.verificationCallCount, 1);
  assert.equal(analysis.summary.uniqueModifiedPaths, 1);
  assert.equal(analysis.summary.modelSuccessClaimCount, 1);
});
