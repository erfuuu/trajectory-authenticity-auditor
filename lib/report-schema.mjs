const dimension = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'verdict', 'reason', 'evidence', 'deductions', 'recommendation'],
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    verdict: { type: 'string', enum: ['高', '中', '低'] },
    reason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    deductions: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    recommendation: { type: 'string' }
  }
};

export const DIMENSIONS = [
  { id: 'structural_integrity', name: '结构完整性', weight: 20 },
  { id: 'execution_grounding', name: '执行落地', weight: 20 },
  { id: 'causal_consistency', name: '因果一致性', weight: 15 },
  { id: 'claim_support', name: '声明证据', weight: 20 },
  { id: 'user_validation', name: '用户验证', weight: 15 },
  { id: 'tamper_resistance', name: '防篡改溯源', weight: 10 }
];

export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title', 'verdict', 'summary', 'dimensions', 'unsupported_claims',
    'user_validation_assessment', 'key_findings', 'limitations'
  ],
  properties: {
    title: { type: 'string' },
    verdict: { type: 'string', enum: ['高可信', '中等可信', '低可信', '无法判定'] },
    summary: { type: 'string' },
    dimensions: {
      type: 'object',
      additionalProperties: false,
      required: DIMENSIONS.map((item) => item.id),
      properties: Object.fromEntries(DIMENSIONS.map((item) => [item.id, dimension]))
    },
    unsupported_claims: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence_level', 'reason'],
        properties: {
          claim: { type: 'string' },
          evidence_level: { type: 'string', enum: ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6'] },
          reason: { type: 'string' }
        }
      }
    },
    user_validation_assessment: {
      type: 'object',
      additionalProperties: false,
      required: ['present', 'rounds', 'post_fix_confirmation', 'reason', 'evidence'],
      properties: {
        present: { type: 'boolean' },
        rounds: { type: 'integer', minimum: 0 },
        post_fix_confirmation: { type: 'boolean' },
        reason: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' }, maxItems: 8 }
      }
    },
    key_findings: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    limitations: { type: 'array', items: { type: 'string' }, maxItems: 10 }
  }
};

export function calculateOverallScore(report) {
  const total = DIMENSIONS.reduce((sum, item) => {
    const score = Number(report.dimensions?.[item.id]?.score || 0);
    return sum + score * item.weight;
  }, 0);
  return Math.round(total / 100);
}
