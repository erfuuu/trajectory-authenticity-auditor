import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOverallScore, calculateVerdict, DIMENSIONS } from '../lib/report-schema.mjs';

function reportWithScores(score, overrides = {}) {
  return {
    verdict: '高质量',
    major_flaws: [],
    dimensions: Object.fromEntries(DIMENSIONS.map((item) => [item.id, { score }])),
    ...overrides
  };
}

test('quality dimension weights total 100', () => {
  assert.equal(DIMENSIONS.length, 9);
  assert.equal(DIMENSIONS.reduce((sum, item) => sum + item.weight, 0), 100);
});

test('calculates weighted score and high quality verdict', () => {
  const report = reportWithScores(90);
  assert.equal(calculateOverallScore(report), 90);
  assert.equal(calculateVerdict(report), '高质量');
});

test('major flaw and weak critical dimension gate the verdict', () => {
  const withFlaw = reportWithScores(90, { major_flaws: [{ finding: '虚假成功' }] });
  assert.equal(calculateVerdict(withFlaw), '存在重大瑕疵');

  const weakVerification = reportWithScores(90);
  weakVerification.dimensions.verification_quality.score = 59;
  assert.equal(calculateVerdict(weakVerification), '存在重大瑕疵');
});

test('preserves unable-to-determine verdict', () => {
  const report = reportWithScores(80, { verdict: '无法判定' });
  assert.equal(calculateVerdict(report), '无法判定');
});
