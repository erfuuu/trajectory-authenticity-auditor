const dimension = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'verdict', 'reason', 'evidence', 'deductions', 'recommendation'],
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    verdict: { type: 'string', enum: ['优秀', '合格', '有瑕疵', '重大瑕疵', '证据不足'] },
    reason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    deductions: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    recommendation: { type: 'string' }
  }
};

export const DIMENSIONS = [
  { id: 'delivery_completeness', name: '交付完整性', weight: 18 },
  { id: 'user_experience', name: '用户体验', weight: 8 },
  { id: 'instruction_following', name: '指令遵循', weight: 14 },
  { id: 'task_planning', name: '任务规划', weight: 10 },
  { id: 'reasoning_quality', name: '推理能力', weight: 14 },
  { id: 'boundary_respect', name: '边界感', weight: 8 },
  { id: 'change_quality', name: '修改质量', weight: 10 },
  { id: 'verification_quality', name: '验证质量', weight: 12 },
  { id: 'tool_efficiency', name: '工具与效率', weight: 6 }
];

export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'title', 'verdict', 'summary', 'result_assessment', 'dimensions', 'major_flaws',
    'unsupported_claims', 'user_validation_assessment', 'key_findings', 'limitations'
  ],
  properties: {
    title: { type: 'string' },
    verdict: { type: 'string', enum: ['高质量', '基本合格', '存在重大瑕疵', '无法判定'] },
    summary: { type: 'string' },
    result_assessment: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'reason', 'evidence'],
      properties: {
        status: { type: 'string', enum: ['已证实成功', '部分证实', '未证实', '已证实失败', '无法判定'] },
        reason: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' }, maxItems: 8 }
      }
    },
    dimensions: {
      type: 'object',
      additionalProperties: false,
      required: DIMENSIONS.map((item) => item.id),
      properties: Object.fromEntries(DIMENSIONS.map((item) => [item.id, dimension]))
    },
    major_flaws: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dimension', 'finding', 'evidence', 'impact'],
        properties: {
          dimension: { type: 'string', enum: DIMENSIONS.map((item) => item.id) },
          finding: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' }, maxItems: 6 },
          impact: { type: 'string' }
        }
      }
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

export function calculateVerdict(report, overallScore = calculateOverallScore(report)) {
  if (report.verdict === '无法判定') return '无法判定';

  const criticalScores = [
    report.dimensions?.delivery_completeness?.score,
    report.dimensions?.instruction_following?.score,
    report.dimensions?.verification_quality?.score
  ].map(Number);
  const hasMajorFlaw = (report.major_flaws?.length || 0) > 0;

  if (hasMajorFlaw || overallScore < 70 || criticalScores.some((score) => !Number.isFinite(score) || score < 60)) {
    return '存在重大瑕疵';
  }
  if (overallScore >= 85 && DIMENSIONS.every((item) => Number(report.dimensions?.[item.id]?.score) >= 70)) {
    return '高质量';
  }
  return '基本合格';
}
