import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPreset, PRESETS } from '../src/core/presets.js';
import { solveAlignment } from '../src/core/alignment.js';
import {
  diagnoseTwistSource,
  replayLoft,
  verifyDiagnosisAgainstReplayRecord,
  createEvidenceChain,
  LoftDiagnosticService,
} from '../src/core/diagnostics.js';
import { checkResultDependencies } from '../src/core/history.js';
import { sampleAssemblyLine } from '../src/core/geometryChecks.js';
import {
  createMiddleKnotScenario,
  createUnevenSpacingScenario,
  createStaleUndoScenario,
} from '../src/core/diagnosticScenarios.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'artifacts');
mkdirSync(outDir, { recursive: true });

const runs = [];
function recordRun(name, diagnosis, extra = {}) {
  const verification = verifyDiagnosisAgainstReplayRecord(diagnosis);
  runs.push({
    name,
    cause: diagnosis.cause,
    healthy: diagnosis.healthy,
    localization: diagnosis.localization ?? null,
    verification,
    evidenceLogCost: diagnosis.evidence?.logCost ?? null,
    ...extra,
  });
  return verification;
}

for (const id of ['circle-ellipse', 'eccentric', 'symmetric', 'flipped-start', 'reverse']) {
  const preset = getPreset(id);
  const alignment = solveAlignment(preset.sections, preset.options);
  const diagnosis = diagnoseTwistSource(preset.sections, {
    presetId: id,
    alignment,
    candidateId: preset.options.candidateId ?? alignment.recommendedId,
  });
  const verification = recordRun(`preset:${id}`, diagnosis);
  if (!verification.verified) {
    throw new Error(`旧样例 ${id} 诊断核验失败: ${JSON.stringify(verification.contradictions)}`);
  }
  if (diagnosis.cause !== 'healthy') {
    throw new Error(`旧样例 ${id} 被对应追踪伪报为 ${diagnosis.cause}: ${diagnosis.message}`);
  }
}

const corrScenario = createMiddleKnotScenario('correspondence');
const corrAlignment = solveAlignment(corrScenario.sections, corrScenario.options);
const corrDiagnosis = diagnoseTwistSource(corrScenario.sections, {
  presetId: corrScenario.id,
  alignment: corrAlignment,
  candidateId: 'custom-correspondence',
  parameterSnapshot: corrScenario.parameterSnapshot,
});
const corrVerification = recordRun('scenario:middle-correspondence-knot', corrDiagnosis);
if (corrDiagnosis.cause !== 'input-correspondence' || !corrVerification.verified) {
  throw new Error(`中间对应打结归因错误: ${corrDiagnosis.cause} ${JSON.stringify(corrVerification.contradictions)}`);
}

const oppositeScenario = createMiddleKnotScenario('opposite-direction');
const oppositeAlignment = solveAlignment(oppositeScenario.sections, oppositeScenario.options);
const oppositeDiagnosis = diagnoseTwistSource(oppositeScenario.sections, {
  presetId: oppositeScenario.id,
  alignment: oppositeAlignment,
  candidateId: 'custom-correspondence',
  parameterSnapshot: oppositeScenario.parameterSnapshot,
});
recordRun('scenario:opposite-direction', oppositeDiagnosis);
if (oppositeDiagnosis.cause !== 'input-correspondence') {
  throw new Error(`异向截面归因错误: ${oppositeDiagnosis.cause}`);
}

const frameScenario = createMiddleKnotScenario('frame');
const frameAlignment = solveAlignment(frameScenario.sections, frameScenario.options);
const frameDiagnosis = diagnoseTwistSource(frameScenario.sections, {
  presetId: frameScenario.id,
  alignment: frameAlignment,
  frames: frameScenario.oldFrames,
  parameterSnapshot: frameScenario.parameterSnapshot,
});
const frameVerification = recordRun('scenario:middle-frame-flip', frameDiagnosis);
if (frameDiagnosis.cause !== 'frame-flip' || !frameVerification.verified) {
  throw new Error(`标架翻面归因错误: ${frameDiagnosis.cause} ${JSON.stringify(frameVerification.contradictions)}`);
}

const spacingScenario = createUnevenSpacingScenario();
const spacingAlignment = solveAlignment(spacingScenario.sections, spacingScenario.options);
const spacingDiagnosis = diagnoseTwistSource(spacingScenario.sections, {
  presetId: spacingScenario.id,
  alignment: spacingAlignment,
  parameterSnapshot: spacingScenario.parameterSnapshot,
});
const spacingVerification = recordRun('scenario:uneven-spacing', spacingDiagnosis);
if (spacingDiagnosis.cause !== 'interpolation-ill-conditioning' || !spacingVerification.verified) {
  throw new Error(`不均匀间距归因错误: ${spacingDiagnosis.cause} ${JSON.stringify(spacingVerification.contradictions)}`);
}

const pointOrderAlignment = solveAlignment(corrScenario.sections, {});
const locked = pointOrderAlignment.candidates.find((c) => c.id === 'locked');
const baselineReplay = replayLoft({
  sections: corrScenario.sections,
  alignment: pointOrderAlignment,
  candidate: locked,
  mode: 'baseline',
  includeSurface: true,
});
const lockedLine = sampleAssemblyLine(baselineReplay.surface, pointOrderAlignment.anchorU, 64);
const pointOrderReplay = replayLoft({
  sections: corrScenario.sections,
  alignment: pointOrderAlignment,
  candidate: locked,
  mode: 'point-order-only',
  pointOrderEdits: { KNOT: { shift: 10 } },
  baselineAssemblyLine: lockedLine,
});
const frameOnlyReplay = replayLoft({
  sections: frameScenario.sections,
  alignment: frameAlignment,
  candidate: frameAlignment.candidates.find((c) => c.id === frameAlignment.recommendedId),
  mode: 'frame-only',
  frameCorrections: frameDiagnosis.diagnosisParameters.frameCorrections,
});

const staleScenario = createStaleUndoScenario();
const staleCheck = checkResultDependencies(staleScenario.lateResult, staleScenario.remainingSections);
if (!staleCheck.stale || !staleCheck.missingSectionIds.includes(staleScenario.insertedSectionId)) {
  throw new Error('撤销后旧标架失效识别失败');
}
const service = new LoftDiagnosticService();
service.commitEdit({ type: 'insert-section', sectionId: staleScenario.insertedSectionId, index: 2 });
service.commitEdit({ type: 'undo-insert-section', sectionId: staleScenario.insertedSectionId });
const task = service.tasks.create({ sections: staleScenario.sections, historyRevision: 1 });
const lateAccept = service.acceptTaskResult(task.id, staleScenario.lateResult, staleScenario.remainingSections);
if (lateAccept.accepted || lateAccept.code !== 'RESULT_DEPENDENCY_SECTION_MISSING') {
  throw new Error('迟到旧标架任务未被诊断器拒绝');
}

const limitedLog = createEvidenceChain({ maxEntries: 48 });
for (let i = 0; i < 500; i++) limitedLog.record('diagnostic', 'stress', 'info', { i, twistAmount: i / 500 });
if (limitedLog.entries.length > 48) throw new Error('诊断日志未遵守成本上限');

const replayRecord = {
  schema: 'loft-twist-diagnostic-run/v1',
  generatedAt: new Date().toISOString(),
  launch: {
    ui: 'npm run dev',
    uiUrl: 'http://127.0.0.1:5173/',
    checkUi: 'npm run check:ui',
    note: '浏览器打开 Vite 地址；右侧“扭转来源诊断”可运行复跑，左侧可撤销/拖动截面并修改对应。',
  },
  runs,
  explicitReplayComparison: {
    pointOrderOnly: {
      selfIntersectionCount: pointOrderReplay.selfIntersectionCount,
      assemblyLine: pointOrderReplay.assemblyLine,
      parameters: pointOrderReplay.parameters,
    },
    frameOnly: {
      selfIntersectionCount: frameOnlyReplay.selfIntersectionCount,
      assemblyLine: frameOnlyReplay.assemblyLine,
      parameters: frameOnlyReplay.parameters,
    },
  },
  staleUndo: { staleCheck, lateAccept: { accepted: lateAccept.accepted, code: lateAccept.code } },
  logCostStress: limitedLog.toJSON().logCost,
  records: {
    correspondence: corrDiagnosis.replayRecord,
    frame: frameDiagnosis.replayRecord,
    spacing: spacingDiagnosis.replayRecord,
  },
};

writeFileSync(resolve(outDir, 'twist-diagnostic-replay.json'), JSON.stringify(replayRecord, null, 2));
console.log(JSON.stringify({
  ok: true,
  artifact: resolve(outDir, 'twist-diagnostic-replay.json'),
  runs: runs.map((r) => ({ name: r.name, cause: r.cause, verified: r.verification.verified })),
  pointOrderDrift: pointOrderReplay.assemblyLine.maxDrift,
  stale: staleCheck.code,
  logEntries: limitedLog.entries.length,
}, null, 2));
