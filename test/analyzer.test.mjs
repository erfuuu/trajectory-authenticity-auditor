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
