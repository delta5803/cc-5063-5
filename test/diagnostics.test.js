import test from 'node:test';
import assert from 'node:assert/strict';

import { getPreset } from '../src/core/presets.js';
import { solveAlignment } from '../src/core/alignment.js';
import {
  diagnoseTwistSource,
  replayLoft,
  verifyDiagnosisAgainstReplayRecord,
  createEvidenceChain,
  LoftDiagnosticService,
} from '../src/core/diagnostics.js';
import {
  SectionEditHistory,
  checkResultDependencies,
} from '../src/core/history.js';
import { sampleAssemblyLine } from '../src/core/geometryChecks.js';
import {
  createMiddleKnotScenario,
  createUnevenSpacingScenario,
  createStaleUndoScenario,
} from '../src/core/diagnosticScenarios.js';

test('correspondence tracker does not falsely report existing healthy lofts', () => {
  for (const id of ['circle-ellipse', 'eccentric', 'symmetric', 'flipped-start', 'reverse']) {
    const preset = getPreset(id);
    const alignment = solveAlignment(preset.sections, preset.options);
    const diagnosis = diagnoseTwistSource(preset.sections, {
      presetId: id,
      alignment,
      candidateId: preset.options.candidateId ?? alignment.recommendedId,
    });
    assert.equal(diagnosis.cause, 'healthy', `${id}: ${diagnosis.message}`);
    assert.equal(diagnosis.verification.verified, true, JSON.stringify(diagnosis.verification.contradictions));
    assert.equal(diagnosis.diagnosisParameters.globalFlipApplied, false);
    assert.ok(diagnosis.trace.rows.every((row) => Array.isArray(row.frame.normal)));
    assert.ok(diagnosis.trace.intervals.every((interval) => Number.isFinite(interval.twistAmount)));
  }
});

test('edit history identifies a late frame whose inserted section was undone', () => {
  const scenario = createStaleUndoScenario();
  const history = new SectionEditHistory();
  history.commit({ type: 'insert-section', sectionId: scenario.insertedSectionId });
  history.undo();

  const stale = checkResultDependencies(scenario.lateResult, scenario.remainingSections);
  assert.equal(stale.valid, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.code, 'RESULT_DEPENDENCY_SECTION_MISSING');
  assert.deepEqual(stale.missingSectionIds, [scenario.insertedSectionId]);
  assert.match(stale.message, /已不存在/);

  const service = new LoftDiagnosticService();
  const task = service.tasks.create({ sections: scenario.sections });
  const accepted = service.acceptTaskResult(task.id, scenario.lateResult, scenario.remainingSections);
  assert.equal(accepted.accepted, false);
  assert.equal(accepted.code, 'RESULT_DEPENDENCY_SECTION_MISSING');
});

test('middle inserted knot is attributed to localized input correspondence', () => {
  const scenario = createMiddleKnotScenario('correspondence');
  const alignment = solveAlignment(scenario.sections, scenario.options);
  const diagnosis = diagnoseTwistSource(scenario.sections, {
    alignment,
    candidateId: 'custom-correspondence',
  });

  assert.equal(diagnosis.cause, 'input-correspondence');
  assert.equal(diagnosis.localization.sectionId, 'KNOT');
  assert.ok(diagnosis.trace.totals.maxLockResidualU > 0.2);
  assert.ok(diagnosis.trace.totals.maxTwist > 1);
  assert.equal(diagnosis.verification.verified, true);
  assert.equal(diagnosis.diagnosisParameters.globalFlipApplied, false);

  const replayRecordCheck = verifyDiagnosisAgainstReplayRecord(diagnosis.replayRecord);
  assert.equal(replayRecordCheck.verified, true, JSON.stringify(replayRecordCheck.contradictions));
});

test('opposite-direction section is distinguished from interpolation trouble', () => {
  const scenario = createMiddleKnotScenario('opposite-direction');
  const alignment = solveAlignment(scenario.sections, scenario.options);
  const diagnosis = diagnoseTwistSource(scenario.sections, {
    alignment,
    candidateId: 'custom-correspondence',
  });
  assert.equal(diagnosis.cause, 'input-correspondence');
  const interval = diagnosis.trace.intervals.find((x) => x.rawOrientationChange);
  assert.ok(interval, 'expected raw orientation change evidence');
  assert.match(diagnosis.stage, /correspondence/);
});

test('frozen correspondence and recomputed frames attribute a frame flip', () => {
  const scenario = createMiddleKnotScenario('frame');
  const alignment = solveAlignment(scenario.sections, scenario.options);
  const diagnosis = diagnoseTwistSource(scenario.sections, {
    alignment,
    frames: scenario.oldFrames,
  });

  assert.equal(diagnosis.cause, 'frame-flip');
  assert.equal(diagnosis.localization.sectionId, 'KNOT');
  assert.ok(diagnosis.frames.diffs.some((d) => d.sectionId === 'KNOT' && d.flip));
  assert.ok(diagnosis.replays.frameOnly);
  assert.equal(diagnosis.verification.verified, true);
});

test('closed correctly matched sections with uneven spacing classify interpolation pathology', () => {
  const scenario = createUnevenSpacingScenario();
  const alignment = solveAlignment(scenario.sections, scenario.options);
  const diagnosis = diagnoseTwistSource(scenario.sections, { alignment });

  assert.equal(diagnosis.cause, 'interpolation-ill-conditioning');
  assert.equal(diagnosis.stage, 'spacing');
  assert.ok(diagnosis.spacing.nonUniform);
  assert.ok(Math.max(...diagnosis.sectionResiduals.map((r) => r.maxError)) < 0.02);
  assert.ok(diagnosis.replays.spacingUniform);
  assert.equal(diagnosis.verification.verified, true);
});

test('frame-only and point-order-only replays compare self intersections and locked assembly line', () => {
  const scenario = createMiddleKnotScenario('correspondence');
  const alignment = solveAlignment(scenario.sections, {});
  const locked = alignment.candidates.find((c) => c.id === 'locked');

  const baseline = replayLoft({
    sections: scenario.sections,
    alignment,
    candidate: locked,
    mode: 'baseline',
    includeSurface: true,
  });
  const lockedLine = sampleAssemblyLine(baseline.surface, alignment.anchorU, 64);
  const pointOrder = replayLoft({
    sections: scenario.sections,
    alignment,
    candidate: locked,
    mode: 'point-order-only',
    pointOrderEdits: { KNOT: { shift: 10 } },
    baselineAssemblyLine: lockedLine,
  });
  const frameOnly = replayLoft({
    sections: scenario.sections,
    alignment,
    candidate: locked,
    mode: 'frame-only',
    frameCorrections: { KNOT: { angle: Math.PI } },
    baselineAssemblyLine: lockedLine,
  });

  assert.equal(typeof baseline.selfIntersectionCount, 'number');
  assert.equal(typeof pointOrder.selfIntersectionCount, 'number');
  assert.equal(typeof frameOnly.selfIntersectionCount, 'number');
  assert.ok(pointOrder.assemblyLine.maxDrift > 0.5);
  assert.ok(frameOnly.assemblyLine.maxDrift > 0.5);
  assert.equal(pointOrder.parameters.mode, 'point-order-only');
  assert.equal(frameOnly.parameters.mode, 'frame-only');
});

test('low cost drag diagnosis stays pending until full replay runs', () => {
  const preset = getPreset('circle-ellipse');
  const alignment = solveAlignment(preset.sections, preset.options);
  const diagnosis = diagnoseTwistSource(preset.sections, {
    alignment,
    candidateId: preset.options.candidateId ?? alignment.recommendedId,
    replays: false,
    checkSelfIntersection: false,
  });

  assert.equal(diagnosis.replayStatus, 'deferred');
  assert.equal(diagnosis.verification.verified, false);
  assert.equal(diagnosis.verification.pending, true);
  assert.equal(diagnosis.verification.status, 'pending-full-replay');
  assert.equal(diagnosis.verification.contradictions.length, 0);
});

test('diagnostic evidence log is bounded for low logging cost', () => {
  const evidence = createEvidenceChain({ maxEntries: 32 });
  for (let i = 0; i < 500; i++) {
    evidence.metric('twist', 'sample', { abnormal: i % 37 === 0, twistAmount: i / 500, sectionResidual: 0.1 });
  }
  assert.ok(evidence.entries.length <= 32);
  assert.equal(evidence.logCost.entryCount, evidence.entries.length);
  assert.ok(evidence.logCost.estimatedBytes > 0);
});
