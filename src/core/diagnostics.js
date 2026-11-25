import { V } from './vec.js';
import { solveAlignment } from './alignment.js';
import {
  buildLoftSurface,
  chordParameters,
} from './surface.js';
import { validateTopology } from './topology.js';
import {
  traceCorrespondence,
  compareCorrespondenceCosts,
  freezeCorrespondence,
  recomputeSectionFrames,
  diffFrames,
} from './correspondence.js';
import {
  countSurfaceSelfIntersections,
  sampleAssemblyLine,
  compareAssemblyLines,
} from './geometryChecks.js';
import {
  SectionEditHistory,
  SurfaceGenerationTasks,
  checkResultDependencies,
} from './history.js';

export const DIAGNOSTIC_STAGES = Object.freeze([
  'history',
  'topology',
  'correspondence',
  'frame',
  'point-order',
  'spacing',
  'interpolation',
  'self-intersection',
  'assembly-line',
  'attribution',
]);

export function createEvidenceChain(options = {}) {
  const maxEntries = options.maxEntries ?? 160;
  const entries = [];
  const counts = { debug: 0, info: 0, warn: 0, error: 0 };
  let estimatedBytes = 0;
  let seq = 0;

  function append(stage, event, severity, fields = {}) {
    counts[severity] += 1;
    if (severity === 'debug' && options.verbose !== true) return null;
    const entry = {
      seq: ++seq,
      stage,
      event,
      severity,
      ...fields,
    };
    const bytes = JSON.stringify(entry).length;
    entry.bytes = bytes;
    entries.push(entry);
    estimatedBytes += bytes;

    while (entries.length > maxEntries) {
      const removableIndex = entries.findIndex((e) => e.severity === 'debug' || e.severity === 'info');
      const idx = removableIndex >= 0 ? removableIndex : 0;
      const [removed] = entries.splice(idx, 1);
      estimatedBytes -= removed.bytes ?? JSON.stringify(removed).length;
    }
    return entry;
  }

  return {
    entries,
    counts,
    maxEntries,
    record: (stage, event, severity = 'info', fields = {}) => append(stage, event, severity, fields),
    metric(stage, event, metric = {}) {
      const severity = metric.severity ?? (metric.abnormal ? 'warn' : 'info');
      return append(stage, event, severity, {
        intervalIndex: metric.intervalIndex ?? null,
        sectionId: metric.sectionId ?? null,
        twistAmount: metric.twistAmount ?? null,
        sectionResidual: metric.sectionResidual ?? null,
        ...metric,
      });
    },
    toJSON() {
      return {
        entries: this.entries,
        counts: this.counts,
        logCost: { entryCount: entries.length, maxEntries, estimatedBytes },
      };
    },
    get logCost() {
      return { entryCount: entries.length, maxEntries, estimatedBytes };
    },
  };
}

export function centripetalParameters(sections) {
  const centroids = sections.map((s) => {
    if (s.centroid) return s.centroid;
    return [s.cx ?? 0, s.cy ?? 0, s.z ?? 0];
  });
  const distances = [0];
  let total = 0;
  for (let i = 1; i < sections.length; i++) {
    total += Math.sqrt(Math.max(1e-10, V.dist(centroids[i - 1], centroids[i])));
    distances.push(total);
  }
  if (total < 1e-8) return sections.map((_, i) => i / Math.max(1, sections.length - 1));
  return distances.map((d) => d / total);
}

export function measureSectionResiduals(surface, sections, alignment, candidate, samples = 80) {
  const ordered = alignment.orderedIds.map((id) => sections.find((s) => s.id === id)).filter(Boolean);
  return ordered.map((section, i) => {
    const mapping = candidate.mappings.find((m) => m.sectionId === section.id);
    const prep = mapping.arc ? { arc: mapping.arc } : null;
    let maxError = 0;
    let sumSq = 0;
    for (let j = 0; j < samples; j++) {
      const u = j / samples;
      const arc = ((mapping.offset + mapping.orientation * u) % 1 + 1) % 1;
      const expected = prep?.arc?.pointAt
        ? prep.arc.pointAt(arc)
        : section.curve.pointAt(arc);
      const got = surface.point(u, surface.parametersV[i]);
      const error = V.dist(expected, got);
      maxError = Math.max(maxError, error);
      sumSq += error * error;
    }
    return {
      sectionId: section.id,
      index: i,
      v: surface.parametersV[i],
      maxError,
      rmsError: Math.sqrt(sumSq / samples),
    };
  });
}

export function measureIntervalWaviness(surface, options = {}) {
  const K = options.samples ?? 48;
  const paramsV = surface.parametersV;
  const intervals = [];
  for (let i = 0; i < paramsV.length - 1; i++) {
    const v0 = paramsV[i];
    const v1 = paramsV[i + 1];
    const mid = (v0 + v1) / 2;
    const h = Math.max(1e-4, (v1 - v0) * 0.12);
    let secondMax = 0;
    let secondSq = 0;
    let bowMax = 0;
    let bowSq = 0;
    let count = 0;

    for (let j = 0; j < K; j++) {
      const u = j / K;
      const pm = surface.point(u, mid);
      const minus = surface.point(u, Math.max(0, mid - h));
      const plus = surface.point(u, Math.min(1, mid + h));
      const second = V.sub(V.add(minus, plus), V.scale(pm, 2));
      const secondNorm = V.norm(second);
      secondMax = Math.max(secondMax, secondNorm);
      secondSq += secondNorm * secondNorm;

      const a = surface.point(u, v0);
      const b = surface.point(u, v1);
      const chord = V.lerp(a, b, 0.5);
      const bow = V.dist(pm, chord);
      bowMax = Math.max(bowMax, bow);
      bowSq += bow * bow;
      count++;
    }

    intervals.push({
      index: i,
      vRange: [v0, v1],
      secondDifferenceMax: secondMax,
      wavinessRms: Math.sqrt(secondSq / count),
      bowMax,
      bowRms: Math.sqrt(bowSq / count),
    });
  }
  return intervals;
}

export function analyzeSpacing(paramsV) {
  const gaps = [];
  for (let i = 1; i < paramsV.length; i++) gaps.push(paramsV[i] - paramsV[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 1 / Math.max(1, paramsV.length - 1);
  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);
  const mean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  const cv = mean > 0 ? Math.sqrt(gaps.reduce((s, x) => s + (x - mean) ** 2, 0) / gaps.length) / mean : 0;
  return {
    gaps,
    median,
    minGap,
    maxGap,
    ratio: maxGap / Math.max(1e-8, minGap),
    coefficientOfVariation: cv,
    nonUniform: gaps.length > 1 && (maxGap / Math.max(1e-8, median) > 2.4 || cv > 0.55),
    denseIntervals: gaps.map((g, index) => (g < median * 0.45 ? index : null)).filter((x) => x != null),
    sparseIntervals: gaps.map((g, index) => (g > median * 2.1 ? index : null)).filter((x) => x != null),
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function maxIndexBy(items, value) {
  if (!items.length) return null;
  let best = 0;
  for (let i = 1; i < items.length; i++) if (value(items[i]) > value(items[best])) best = i;
  return best;
}

export function replayLoft(spec = {}) {
  const {
    sections,
    alignment,
    candidate,
    candidateId,
    mode = 'baseline',
    frameCorrections,
    pointOrderEdits,
    vParameters,
    baselineAssemblyLine,
    anchorU = alignment?.anchorU ?? 0.22,
    selfIntersection = {},
    uControlCount = 48,
    buildOptions = {},
    waviness = false,
  } = spec;

  const chosen = candidate
    ?? alignment.candidates.find((c) => c.id === (candidateId ?? alignment.recommendedId))
    ?? alignment.candidates.find((c) => c.recommended);

  const parameters = {
    mode,
    candidateId: chosen.id,
    uControlCount,
    frameCorrections: frameCorrections ?? undefined,
    pointOrderEdits: pointOrderEdits ?? undefined,
    vParameters: vParameters ? vParameters.map((x) => Number(x.toFixed(6))) : undefined,
    ...buildOptions,
  };

  const surface = buildLoftSurface(sections, alignment, {
    candidateId: chosen.id,
    uControlCount,
    ...buildOptions,
    frameCorrections: mode === 'frame-only' ? frameCorrections : buildOptions.frameCorrections,
    pointOrderEdits: mode === 'point-order-only' ? (pointOrderEdits ?? {}) : buildOptions.pointOrderEdits,
    vParameters: mode === 'spacing' && vParameters ? vParameters : buildOptions.vParameters,
  });

  const intersection = countSurfaceSelfIntersections(surface, {
    uSegments: selfIntersection.uSegments ?? 20,
    vSegments: selfIntersection.vSegments ?? 10,
    includePairs: false,
  });
  const assemblyLine = sampleAssemblyLine(surface, anchorU, 64);
  const assemblyComparison = baselineAssemblyLine
    ? compareAssemblyLines(baselineAssemblyLine, assemblyLine)
    : { maxDrift: 0, rmsDrift: 0, samples: assemblyLine.length };
  const waves = waviness ? measureIntervalWaviness(surface, { samples: 32 }) : null;

  return {
    mode,
    parameters,
    sectionIds: surface.sectionIds,
    selfIntersectionCount: intersection.selfIntersectionCount,
    sampledTriangles: intersection.sampledTriangles,
    assemblyLine: {
      anchorU,
      pointCount: assemblyLine.length,
      ...assemblyComparison,
    },
    maxWaviness: waves ? Math.max(...waves.map((x) => x.wavinessRms)) : null,
    waviness: waves ?? undefined,
    surface: spec.includeSurface === true ? surface : undefined,
  };
}

export function diagnoseTwistSource(sections, options = {}) {
  const evidence = options.evidence ?? createEvidenceChain(options.evidenceOptions);
  const started = Date.now();
  const history = options.history ?? null;
  const dependencySource = options.dependencyResult ?? options.task ?? options.result ?? null;

  if (history || dependencySource) {
    const dependencyCheck = checkResultDependencies(dependencySource ?? { sectionIds: sections.map((s) => s.id) }, sections);
    if (!dependencyCheck.valid) {
      evidence.record('history', 'stale_dependency_rejected', 'error', {
        code: dependencyCheck.code,
        sectionId: dependencyCheck.missingSectionIds[0] ?? null,
        missingSectionIds: dependencyCheck.missingSectionIds,
      });
      return {
        ok: false,
        healthy: false,
        stale: true,
        cause: 'stale-section-dependency',
        code: dependencyCheck.code,
        message: dependencyCheck.message,
        dependencyCheck,
        evidence: evidence.toJSON(),
        diagnosisParameters: options.parameterSnapshot ?? {},
      };
    }
    evidence.record('history', 'dependency_current', 'info', {
      historyRevision: history?.revision ?? null,
    });
  }

  const topology = validateTopology(sections);
  if (!topology.ok) {
    evidence.record('topology', 'loft_rejected', 'error', {
      code: topology.errors[0]?.code,
      sectionId: topology.errors[0]?.sectionId ?? null,
    });
    return {
      ok: false,
      healthy: false,
      cause: 'topology-rejected',
      topology,
      evidence: evidence.toJSON(),
      message: topology.errors.map((e) => e.message).join('\n'),
    };
  }

  const alignment = options.alignment ?? solveAlignment(sections, options.alignmentOptions ?? {});
  const candidate = options.candidate
    ?? alignment.candidates.find((c) => c.id === (options.candidateId ?? alignment.recommendedId))
    ?? alignment.candidates.find((c) => c.recommended);
  const anchorU = alignment.anchorU ?? 0.22;
  const trace = traceCorrespondence(sections, alignment, candidate, {
    samples: options.traceSamples ?? 72,
    parametersV: options.parametersV,
  });
  const costs = compareCorrespondenceCosts(sections, alignment, candidate, { benchmark: options.benchmarkCosts ?? false });
  const frozen = freezeCorrespondence(alignment, candidate.id);

  const surface = options.surface ?? buildLoftSurface(sections, alignment, {
    candidateId: candidate.id,
    uControlCount: options.uControlCount ?? 64,
    ...(options.surfaceOptions ?? {}),
  });
  const sectionResiduals = measureSectionResiduals(surface, sections, alignment, candidate, 72);
  const waviness = measureIntervalWaviness(surface, { samples: options.wavinessSamples ?? 40 });
  const paramsV = surface.parametersV;
  const spacing = analyzeSpacing(paramsV);

  trace.rows.forEach((row) => {
    const residual = sectionResiduals.find((x) => x.sectionId === row.sectionId);
    row.surfaceResidual = residual?.maxError ?? null;
    row.sectionResidual = Math.max(row.sectionResidual, residual?.maxError ?? 0);
  });

  const capturedFrames = options.frames ?? trace.frames;
  const freshFrames = recomputeSectionFrames(sections, { anchorU });
  const frameDiffs = diffFrames(capturedFrames, freshFrames);
  const frameCorrections = Object.fromEntries(frameDiffs
    .filter((d) => d.sectionId && Number.isFinite(d.axisAngle) && Math.abs(d.axisAngle) > 1e-5)
    .map((d) => [d.sectionId, { angle: d.axisAngle, translation: [0, 0, 0] }]));

  const baselineAssemblyLine = sampleAssemblyLine(surface, anchorU, 64);
  let selfIntersection = null;
  if (options.checkSelfIntersection !== false) {
    selfIntersection = countSurfaceSelfIntersections(surface, options.selfIntersectionOptions ?? {
      uSegments: 24,
      vSegments: 12,
    });
    evidence.metric('self-intersection', 'baseline_self_intersection', {
      severity: selfIntersection.selfIntersectionCount > 0 ? 'error' : 'info',
      sectionResidual: null,
      count: selfIntersection.selfIntersectionCount,
    });
  }

  const maxTwistIndex = maxIndexBy(trace.intervals, (x) => x.twistAmount);
  const maxLockIndex = maxIndexBy(trace.rows, (x) => x.lockResidualU);
  const maxResidualIntervalIndex = maxIndexBy(trace.intervals, (x) => x.correspondenceResidual);
  const maxWaveIndex = maxIndexBy(waviness, (x) => x.wavinessRms);
  const twistMedian = median(trace.intervals.map((x) => x.twistAmount));
  const maxTwist = trace.totals.maxTwist;
  const twistSpikeRatio = maxTwist / (twistMedian + 0.035);
  const maxLock = trace.totals.maxLockResidualU;
  const maxSectionResidual = Math.max(...sectionResiduals.map((x) => x.maxError));
  const maxWave = Math.max(...waviness.map((x) => x.wavinessRms));
  const waveMedian = median(waviness.map((x) => x.wavinessRms));
  const waveSpikeRatio = maxWave / (waveMedian + 0.012);
  const frameFlip = frameDiffs.find((d) => d.flip);
  const orientationConflictRow = trace.rows.find((r) => r.direction.orientationConflict);

  trace.intervals.forEach((interval) => {
    if (interval.twistAmount > 0.55 || interval.lockResidualU > 0.12) {
      evidence.metric('correspondence', 'abnormal_interval_metric', {
        intervalIndex: interval.index,
        sectionId: interval.between[1],
        abnormal: true,
        twistAmount: Number(interval.twistAmount.toFixed(6)),
        sectionResidual: Number(interval.lockResidualU.toFixed(6)),
        code: interval.rawOrientationChange ? 'OPPOSITE_DIRECTION_SECTION' : 'START_OR_PARAMETER_JUMP',
      });
    }
  });

  if (frameFlip) {
    evidence.metric('frame', 'frame_flip_detected', {
      sectionId: frameFlip.sectionId,
      abnormal: true,
      twistAmount: Number(Math.abs(frameFlip.axisAngle).toFixed(6)),
      sectionResidual: Number(frameFlip.normalAngle.toFixed(6)),
      code: 'FRAME_AXIS_FLIP',
    });
  }

  let replays = null;
  let verification = null;
  if (options.replays !== false) {
    const replayOptions = {
      sections,
      alignment,
      candidate,
      anchorU,
      baselineAssemblyLine,
      selfIntersection: options.replaySelfIntersection ?? { uSegments: 18, vSegments: 9 },
      uControlCount: options.replayUControlCount ?? 40,
    };
    const baselineReplay = replayLoft({ ...replayOptions, mode: 'baseline' });
    const frameOnly = replayLoft({
      ...replayOptions,
      mode: 'frame-only',
      frameCorrections: options.frameCorrections ?? frameCorrections,
    });
    const pointOrderOnly = replayLoft({
      ...replayOptions,
      mode: 'point-order-only',
      pointOrderEdits: options.pointOrderEdits ?? {},
    });

    let spacingUniform = null;
    if (spacing.nonUniform || options.includeSpacingReplay) {
      spacingUniform = replayLoft({
        ...replayOptions,
        mode: 'spacing',
        vParameters: options.uniformParameters ?? sections.map((_, i) => i / Math.max(1, sections.length - 1)),
        waviness: true,
      });
    }

    replays = {
      baseline: baselineReplay,
      frameOnly,
      pointOrderOnly,
      spacingUniform,
    };

    evidence.record('frame', 'frame_only_replay', Math.abs(frameOnly.assemblyLine.maxDrift) > 0.05 ? 'warn' : 'info', {
      selfIntersectionCount: frameOnly.selfIntersectionCount,
      assemblyLineDrift: Number(frameOnly.assemblyLine.maxDrift.toFixed(6)),
    });
    evidence.record('point-order', 'point_order_only_replay', pointOrderOnly.selfIntersectionCount > 0 ? 'warn' : 'info', {
      selfIntersectionCount: pointOrderOnly.selfIntersectionCount,
      assemblyLineDrift: Number(pointOrderOnly.assemblyLine.maxDrift.toFixed(6)),
    });
  }

  const strongCorrespondence = maxLock > (alignment.lockTolerance ?? 0.05) * 2.2
    || trace.totals.parameterResidual > 0.04
    || Boolean(orientationConflictRow);
  const frameReplaySignal = replays && (
    Math.abs(replays.frameOnly.assemblyLine.maxDrift) > 0.08
    || replays.frameOnly.selfIntersectionCount !== replays.baseline.selfIntersectionCount
    || Boolean(frameFlip)
  );
  const spacingImproves = replays?.spacingUniform
    && replays.spacingUniform.maxWaviness != null
    && maxWave > 0
    && replays.spacingUniform.maxWaviness < maxWave * 0.72;
  const interpolationSignal = maxSectionResidual < 0.01 && maxWave > 0.08
    && (waveSpikeRatio > 1.35 || Boolean(spacingImproves));

  let cause = 'healthy';
  let stage = null;
  let confidence = 0.9;
  let message = '起点、方向、参数对应和纵向插值均未发现超出阈值的扭转来源。';
  let localization = null;

  if ((selfIntersection?.selfIntersectionCount ?? 0) > 0 && !strongCorrespondence && !frameFlip) {
    cause = 'solid-self-intersection';
    stage = 'self-intersection';
    confidence = 0.82;
    message = `放样曲面/实体采样网格存在 ${selfIntersection.selfIntersectionCount} 对自交三角形，但对应追踪未发现显式错配。`;
  } else if (frameFlip && frameReplaySignal && !strongCorrespondence) {
    cause = 'frame-flip';
    stage = 'frame';
    confidence = 0.88;
    localization = { sectionId: frameFlip.sectionId };
    message = `冻结对应后单独重算标架，截面 ${frameFlip.sectionId} 的轴发生翻面/大角度旋转；两次重放差分将突然打结归因于标架阶段。`;
  } else if (strongCorrespondence && (maxLock > 0.1 || orientationConflictRow || maxTwist > 0.5)) {
    cause = 'input-correspondence';
    stage = orientationConflictRow ? 'correspondence.direction' : 'correspondence.start-parameter';
    confidence = 0.9;
    const sectionId = orientationConflictRow?.sectionId ?? (maxLockIndex != null ? trace.rows[maxLockIndex].sectionId : null);
    localization = {
      sectionId,
      intervalIndex: maxTwistIndex,
      between: maxTwistIndex != null ? trace.intervals[maxTwistIndex].between : null,
    };
    message = `闭合截面的起点/方向/参数对应在 ${sectionId ?? '相邻截面'} 处失配：锁点残差 ${maxLock.toFixed(3)} 圈，最大扭转 ${maxTwist.toFixed(3)} rad；密集间隔不会消除该残差，故不是插值病态。`;
  } else if (interpolationSignal && (spacing.nonUniform || spacingImproves)) {
    cause = 'interpolation-ill-conditioning';
    stage = 'spacing';
    confidence = spacingImproves ? 0.87 : 0.72;
    localization = {
      intervalIndex: maxWaveIndex,
      between: maxWaveIndex != null ? trace.intervals[maxWaveIndex]?.between : null,
      denseIntervals: spacing.denseIntervals,
    };
    message = `截面残差很低但区间波度突增，V 参数间距 max/min=${spacing.ratio.toFixed(1)}；均匀/密化间距重放降低波度，归因于不均匀间距触发的插值病态，而非输入对应错误。`;
  } else if (maxTwist > 0.7 && twistSpikeRatio > 1.8) {
    cause = 'possible-correspondence-or-frame';
    stage = 'attribution';
    confidence = 0.55;
    localization = { intervalIndex: maxTwistIndex };
    message = '局部扭转异常明显，但重放差分证据不足；已保留可重放参数，需要检查该区间的异向截面或加密间隔。';
  }

  if (cause !== 'healthy') {
    evidence.metric(stage ?? 'attribution', 'cause_attributed', {
      abnormal: true,
      sectionId: localization?.sectionId ?? null,
      intervalIndex: localization?.intervalIndex ?? null,
      twistAmount: Number(maxTwist.toFixed(6)),
      sectionResidual: Number(maxSectionResidual.toFixed(6)),
      code: cause,
    });
  }

  const diagnosisParameters = {
    presetId: options.presetId ?? null,
    candidateId: candidate.id,
    orderedIds: alignment.orderedIds,
    anchorU,
    uControlCount: options.uControlCount ?? 64,
    traceSamples: options.traceSamples ?? 72,
    replayUControlCount: options.replayUControlCount ?? 40,
    thresholds: {
      lockTolerance: alignment.lockTolerance ?? 0.05,
      strongLockMultiple: 2.2,
      twistWarn: 0.55,
      wave: 0.08,
    },
    frameCorrections,
    pointOrderEdits: options.pointOrderEdits ?? {},
    vParameters: paramsV.map((x) => Number(x.toFixed(6))),
    historyRevision: history?.revision ?? options.historyRevision ?? null,
    taskId: options.task?.id ?? options.taskId ?? null,
    globalFlipApplied: false,
    ...(options.parameterSnapshot ?? {}),
  };

  const replayStatus = options.replays === false ? 'deferred' : 'complete';
  const result = {
    ok: true,
    healthy: cause === 'healthy',
    cause,
    stage,
    message,
    confidence,
    localization,
    replayStatus,
    selectedImplementation: costs.selectedImplementation,
    costs,
    frozenCorrespondence: frozen,
    trace,
    frames: { captured: capturedFrames, fresh: freshFrames, diffs: frameDiffs },
    sectionResiduals,
    waviness,
    spacing,
    selfIntersection,
    replays,
    evidence: evidence.toJSON(),
    diagnosisParameters,
    replayRecord: {
      schema: 'loft-twist-diagnostic-replay/v1',
      createdAt: new Date(0).toISOString().replace('1970-01-01T00:00:00.000Z', 'deterministic-record'),
      diagnosisCause: cause,
      replayStatus,
      diagnosisParameters,
      costs,
      traceSummary: {
        totals: trace.totals,
        maxTwistIndex,
        maxLockIndex,
        maxWaveIndex,
      },
      replays,
      evidence: evidence.toJSON(),
    },
    elapsedMs: Date.now() - started,
  };
  result.verification = verifyDiagnosisAgainstReplayRecord(result);
  return result;
}

export function verifyDiagnosisAgainstReplayRecord(record) {
  const d = record?.trace || record?.cause ? record : record?.diagnosis ?? null;
  const replay = record?.schema?.startsWith?.('loft-twist')
    ? record
    : record?.replayRecord ?? d?.replayRecord ?? null;
  const cause = d?.cause ?? replay?.diagnosisCause ?? record?.diagnosisCause;
  const evidence = d?.evidence ?? replay?.evidence;
  const parameters = replay?.diagnosisParameters ?? d?.diagnosisParameters;
  const replays = d?.replays ?? replay?.replays;
  const totals = d?.trace?.totals ?? replay?.traceSummary?.totals;
  const checks = [];
  const add = (id, ok, detail = '') => checks.push({ id, ok: Boolean(ok), detail });

  if (!cause || !replay) {
    return {
      verified: false,
      checks: [{ id: 'record-shape', ok: false, detail: '缺少诊断结论或复跑记录' }],
      contradictions: [{ id: 'record-shape' }],
    };
  }

  const replayStatus = d?.replayStatus ?? replay?.replayStatus ?? (replays ? 'complete' : 'deferred');

  if (replayStatus === 'deferred' || !replays) {
    const checks = [{
      id: 'full-replay-pending',
      ok: false,
      pending: true,
      detail: '低成本对应追踪已完成；完整复跑尚未比较实体自交数与锁定装配线。',
    }];
    return {
      verified: false,
      pending: true,
      status: 'pending-full-replay',
      checks,
      contradictions: [],
    };
  }

  if (cause === 'topology-rejected') {
    add('topology-rejection-evidence', Boolean(d?.topology?.errors?.length && evidence?.entries?.some((e) => e.stage === 'topology')), '拓扑/顺序不合法时保留拒绝证据');
    return { verified: checks.every((c) => c.ok), checks, contradictions: checks.filter((c) => !c.ok) };
  }

  add('evidence-chain-present', evidence?.entries?.some((e) => e.event === 'cause_attributed' || cause === 'healthy' || cause === 'stale-section-dependency'), '执行证据链包含归因或健康结论');
  add('replay-parameters-saved', Boolean(parameters?.candidateId && parameters?.orderedIds), '保存可重放参数');

  if (cause === 'stale-section-dependency') {
    add('stale-section-identified', Boolean(d?.dependencyCheck?.missingSectionIds?.length || evidence?.entries?.some((e) => e.code === 'RESULT_DEPENDENCY_SECTION_MISSING')), '识别结果依赖截面已不存在');
  } else if (cause === 'healthy') {
    const selfCount = d?.selfIntersection?.selfIntersectionCount ?? replays?.baseline?.selfIntersectionCount ?? 0;
    add('healthy-no-self-intersection', selfCount === 0, `自交数 ${selfCount}`);
    add('healthy-no-correspondence-false-report', (totals?.maxLockResidualU ?? 0) < (parameters?.thresholds?.lockTolerance ?? 0.05) * 2.2, `最大锁点残差 ${totals?.maxLockResidualU}`);
  } else if (cause === 'input-correspondence') {
    add('correspondence-localized', Boolean(d?.localization?.sectionId || d?.localization?.between || replay?.traceSummary?.maxLockIndex != null || replay?.traceSummary?.maxTwistIndex != null), '定位截面或区间');
    add('lock-or-direction-evidence', (totals?.maxLockResidualU ?? 0) > 0.08 || evidence?.entries?.some((e) => e.code === 'OPPOSITE_DIRECTION_SECTION'), '起点/方向/参数证据');
    add('not-global-flip-mask', parameters?.globalFlipApplied === false, '不自动全局翻转');
  } else if (cause === 'frame-flip') {
    add('frame-diff-evidence', Boolean(d?.frames?.diffs?.some((x) => x.flip) || evidence?.entries?.some((e) => e.event === 'frame_flip_detected')), '冻结对应后重算标架检到翻面');
    add('frame-replay-differential', Boolean(replays?.frameOnly), '存在只替换标架重放');
  } else if (cause === 'interpolation-ill-conditioning') {
    add('low-section-residual', d ? Math.max(...d.sectionResiduals.map((x) => x.maxError)) < 0.02 : true, '截面配点残差低');
    add('spacing-or-wave-evidence', Boolean(d?.spacing?.nonUniform || replays?.spacingUniform || evidence?.entries?.some((e) => e.stage === 'spacing')), '间距/波度证据');
  }

  if (replays) {
    add('self-intersection-compared', Number.isFinite(replays.baseline?.selfIntersectionCount) && Number.isFinite(replays.pointOrderOnly?.selfIntersectionCount), '比较实体自交数');
    add('assembly-line-compared', Number.isFinite(replays.baseline?.assemblyLine?.maxDrift) && Number.isFinite(replays.frameOnly?.assemblyLine?.maxDrift), '比较原锁定装配线');
  }

  const verified = checks.every((c) => c.ok);
  return {
    verified,
    pending: false,
    status: verified ? 'verified' : 'contradiction',
    checks,
    contradictions: checks.filter((c) => !c.ok),
  };
}

export const verifyTwistDiagnosis = verifyDiagnosisAgainstReplayRecord;

export class LoftDiagnosticService {
  constructor(options = {}) {
    this.options = options;
    this.history = options.history ?? new SectionEditHistory();
    this.tasks = options.tasks ?? new SurfaceGenerationTasks();
    this.records = [];
    this.maxRecords = options.maxRecords ?? 30;
  }

  commitEdit(edit) {
    return this.history.commit(edit);
  }

  undoEdit() {
    return this.history.undo();
  }

  checkCurrentResult(result, sections) {
    return checkResultDependencies(result, sections);
  }

  acceptTaskResult(taskId, result, sections) {
    return this.tasks.acceptResult(taskId, result, sections);
  }

  runGeneration(input = {}) {
    const sections = input.sections;
    const task = this.tasks.create({
      sections,
      historyRevision: this.history.revision,
      parameters: input.parameterSnapshot ?? {},
      taskId: input.taskId,
    });
    try {
      const diagnosis = diagnoseTwistSource(sections, {
        ...this.options,
        ...input.diagnosticOptions,
        history: this.history,
        task,
        presetId: input.presetId,
        parameterSnapshot: input.parameterSnapshot,
      });
      if (diagnosis.stale) {
        this.tasks.markFailed(task.id, { code: diagnosis.code, message: diagnosis.message });
        return { task, diagnosis, accepted: false, stale: true };
      }
      const result = {
        diagnosis,
        replayRecord: diagnosis.replayRecord,
        dependencies: { sectionIds: task.dependencies.sectionIds, historyRevision: this.history.revision },
      };
      const accepted = this.tasks.acceptResult(task.id, result, sections);
      this.records.push(diagnosis.replayRecord);
      if (this.records.length > this.maxRecords) this.records.shift();
      return { task, diagnosis, result: accepted.result, accepted: true };
    } catch (error) {
      this.tasks.markFailed(task.id, error);
      throw error;
    }
  }

  verifyLatest() {
    const record = this.records[this.records.length - 1];
    return record ? verifyDiagnosisAgainstReplayRecord(record) : { verified: false, checks: [] };
  }
}

export function createLoftDiagnosticService(options) {
  return new LoftDiagnosticService(options);
}
