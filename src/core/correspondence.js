import { V, wrap01, circularDistance, shortestCyclicDelta } from './vec.js';
import {
  ANCHOR_U,
  prepareSectionGeometry,
  markCanonicalU,
  getMarkArc,
} from './alignment.js';
import { nearestCurveParameter } from './curves.js';

export const CORRESPONDENCE_IMPLEMENTATION = Object.freeze({
  REBUILD_BY_SECTION: 'rebuild-correspondence-by-section',
  TRACK_LOCKED_FRAME_FLIP: 'locked-alignment-track-frame-flip',
});

function signedPlaneAngle(a, b, normal) {
  const n = V.normalize(normal);
  const aa = V.sub(a, V.scale(n, V.dot(a, n)));
  const bb = V.sub(b, V.scale(n, V.dot(b, n)));
  if (V.norm(aa) < 1e-10 || V.norm(bb) < 1e-10) return 0;
  const aN = V.normalize(aa);
  const bN = V.normalize(bb);
  return Math.atan2(V.dot(V.cross(aN, bN), n), V.dot(aN, bN));
}

export function sectionFrame(section, mapping = null, anchorU = ANCHOR_U) {
  const prep = prepareSectionGeometry(section);
  const effectiveMapping = mapping ?? {
    offset: prep.markArc - prep.orientation * anchorU,
    orientation: prep.orientation,
  };
  const arc = wrap01(effectiveMapping.offset + effectiveMapping.orientation * anchorU);
  const anchorPoint = prep.arc.pointAt(arc);
  const normal = V.norm(prep.normal) > 0.5 ? V.normalize(prep.normal) : [0, 0, 1];
  let radial = V.sub(anchorPoint, prep.centroid);
  radial = V.sub(radial, V.scale(normal, V.dot(radial, normal)));
  if (V.norm(radial) < 1e-8) radial = [1, 0, 0];
  radial = V.normalize(radial);
  const transported = V.normalize(V.cross(normal, radial));
  const tangentAxis = effectiveMapping.orientation < 0 ? V.scale(transported, -1) : transported;

  return {
    sectionId: section.id,
    revision: section.editRevision ?? null,
    origin: [...prep.centroid],
    normal,
    radialAxis: radial,
    tangentAxis,
    orientation: effectiveMapping.orientation,
    anchorU,
    anchorArc: arc,
    anchorPoint: [...anchorPoint],
  };
}

export function recomputeSectionFrames(sections, options = {}) {
  const anchorU = options.anchorU ?? ANCHOR_U;
  return sections.map((section) => {
    const prep = prepareSectionGeometry(section);
    const mapping = {
      offset: prep.markArc - prep.orientation * anchorU,
      orientation: prep.orientation,
    };
    return sectionFrame(section, mapping, anchorU);
  });
}

export function diffFramePair(oldFrame, freshFrame) {
  if (!oldFrame || !freshFrame || oldFrame.sectionId !== freshFrame.sectionId) {
    return { sectionId: freshFrame?.sectionId ?? oldFrame?.sectionId ?? null, missing: true };
  }
  const normalDot = V.dot(V.normalize(oldFrame.normal), V.normalize(freshFrame.normal));
  const normalAngle = Math.acos(Math.max(-1, Math.min(1, normalDot)));
  const axisAngle = signedPlaneAngle(oldFrame.radialAxis, freshFrame.radialAxis, freshFrame.normal);
  const originDrift = V.dist(oldFrame.origin, freshFrame.origin);
  const flip = normalDot < -0.4 || Math.abs(axisAngle) > Math.PI * 0.72;
  return {
    sectionId: freshFrame.sectionId,
    missing: false,
    normalDot,
    normalAngle,
    axisAngle,
    correctionAngle: axisAngle,
    originDrift,
    flip,
  };
}

export function diffFrames(oldFrames, freshFrames) {
  const oldMap = new Map((oldFrames ?? []).map((f) => [f.sectionId, f]));
  return (freshFrames ?? []).map((fresh) => diffFramePair(oldMap.get(fresh.sectionId), fresh));
}

export function freezeCorrespondence(alignment, candidateId = alignment?.recommendedId) {
  if (!alignment) throw new Error('freezeCorrespondence 需要 alignment');
  const candidate = alignment.candidates.find((c) => c.id === candidateId)
    ?? alignment.candidates.find((c) => c.recommended);
  if (!candidate) throw new Error('没有可冻结的对齐候选');
  return {
    frozenAt: new Date(0).toISOString().replace('1970-01-01T00:00:00.000Z', 'replay'),
    anchorU: alignment.anchorU ?? ANCHOR_U,
    candidateId: candidate.id,
    orderedIds: [...alignment.orderedIds],
    pairs: candidate.mappings.map((m) => ({
      sectionId: m.sectionId,
      offset: m.offset,
      orientation: m.orientation,
    })),
  };
}

export function freezePointOrder(sections, alignment, candidate, sampleCount = 96) {
  const ordered = alignment.orderedIds.map((id) => sections.find((s) => s.id === id)).filter(Boolean);
  return {
    sampleCount,
    rows: ordered.map((section) => {
      const mapping = candidate.mappings.find((m) => m.sectionId === section.id);
      const prep = prepareSectionGeometry(section);
      return {
        sectionId: section.id,
        order: Array.from({ length: sampleCount }, (_, j) => {
          const u = j / sampleCount;
          const arc = wrap01(mapping.offset + mapping.orientation * u);
          return { index: j, u, arc, point: prep.arc.pointAt(arc) };
        }),
      };
    }),
  };
}

function markParameterResidual(section, prep, mark) {
  if (mark.arc != null) return { parameterResidual: 0, pointResidual: 0 };
  if (mark.parameter != null && mark.point) {
    const arcFromParameter = prep.arc.fractionAtRawParameter(mark.parameter);
    const hit = nearestCurveParameter(prep.curve, mark.point, 384);
    const arcFromPoint = prep.arc.fractionAtRawParameter(hit.u);
    const pointOnParameter = prep.arc.pointAt(arcFromParameter);
    return {
      parameterResidual: circularDistance(arcFromParameter, arcFromPoint),
      pointResidual: V.dist(pointOnParameter, mark.point),
    };
  }
  return { parameterResidual: 0, pointResidual: 0 };
}

export function traceCorrespondence(sections, alignment, candidate, options = {}) {
  const K = options.samples ?? 72;
  const ordered = alignment.orderedIds
    .map((id) => sections.find((s) => s.id === id))
    .filter(Boolean);
  const mappings = ordered.map((section) => candidate.mappings.find((m) => m.sectionId === section.id));
  const preps = ordered.map(prepareSectionGeometry);
  const frames = ordered.map((section, i) => sectionFrame(section, mappings[i], alignment.anchorU ?? ANCHOR_U));

  const rows = ordered.map((section, i) => {
    const prep = preps[i];
    const mapping = mappings[i];
    const startArc = prep.arc.fractionAtRawParameter(0);
    const startU = wrap01(mapping.orientation * (startArc - mapping.offset));
    const primaryMark = section.marks?.find((m) => m.primary) ?? section.marks?.[0] ?? section.locks?.[0];
    let lockResidual = 0;
    let parameterResidual = 0;
    let pointResidual = 0;
    if (primaryMark) {
      const arc = getMarkArc(section, primaryMark);
      const u = markCanonicalU(mapping, arc);
      lockResidual = circularDistance(u, primaryMark.canonicalU ?? alignment.anchorU ?? ANCHOR_U);
      const residual = markParameterResidual(section, prep, primaryMark);
      parameterResidual = residual.parameterResidual;
      pointResidual = residual.pointResidual;
    }

    return {
      index: i,
      sectionId: section.id,
      name: section.name ?? section.id,
      revision: section.editRevision ?? null,
      z: section.z ?? null,
      start: {
        rawParameter: 0,
        sourceArc: startArc,
        canonicalU: startU,
        point: prep.arc.pointAt(startArc),
      },
      direction: {
        rawOrientation: prep.orientation,
        appliedOrientation: mapping.orientation,
        corrected: prep.orientation !== mapping.orientation && candidate.id !== 'raw-index',
        orientationConflict: prep.orientation !== mapping.orientation && candidate.id === 'raw-index',
      },
      mapping: {
        offset: mapping.offset,
        orientation: mapping.orientation,
        manual: mapping.manual ?? false,
        reason: mapping.reason ?? null,
      },
      frame: frames[i],
      lockResidualU: lockResidual,
      parameterResidual,
      pointResidual,
      sectionResidual: Math.max(pointResidual, lockResidual * 0),
    };
  });

  const paramsV = options.parametersV ?? alignment.parametersV ?? ordered.map((_, i, arr) => i / Math.max(1, arr.length - 1));
  const intervals = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    let twistSq = 0;
    let residualSq = 0;
    let residualMax = 0;
    let twistMax = 0;
    let count = 0;

    for (let j = 0; j < K; j++) {
      const u = j / K;
      const arcA = wrap01(mappings[i].offset + mappings[i].orientation * u);
      const arcB = wrap01(mappings[i + 1].offset + mappings[i + 1].orientation * u);
      const pA = preps[i].arc.pointAt(arcA);
      const pB = preps[i + 1].arc.pointAt(arcB);
      const rA = V.sub(pA, preps[i].centroid);
      const rB = V.sub(pB, preps[i + 1].centroid);
      const scaleA = V.norm(rA) || 1;
      const scaleB = V.norm(rB) || 1;
      const normalizedA = V.scale(rA, 1 / scaleA);
      const normalizedB = V.scale(rB, 1 / scaleB);
      const residual = V.dist(normalizedA, normalizedB);
      residualSq += residual * residual;
      residualMax = Math.max(residualMax, residual);

      const twist = signedPlaneAngle(rA, rB, V.normalize(V.add(frames[i].normal, frames[i + 1].normal)));
      twistSq += twist * twist;
      twistMax = Math.max(twistMax, Math.abs(twist));
      count++;
    }

    const frameTwist = signedPlaneAngle(frames[i].radialAxis, frames[i + 1].radialAxis, V.normalize(V.add(frames[i].normal, frames[i + 1].normal)));
    const spacing = Math.max(1e-6, (paramsV[i + 1] ?? (i + 1)) - (paramsV[i] ?? i));
    const rawOrientationChange = preps[i].orientation * preps[i + 1].orientation < 0;
    intervals.push({
      index: i,
      between: [ordered[i].id, ordered[i + 1].id],
      vRange: [paramsV[i] ?? i / Math.max(1, ordered.length - 1), paramsV[i + 1] ?? (i + 1) / Math.max(1, ordered.length - 1)],
      spacing,
      startJumpU: Math.abs(shortestCyclicDelta(a.start.canonicalU, b.start.canonicalU)),
      frameTwistRadians: frameTwist,
      twistAmount: Math.sqrt(twistSq / count),
      twistMaxRadians: twistMax,
      twistDegrees: Math.abs(frameTwist) * 180 / Math.PI,
      correspondenceResidual: Math.sqrt(residualSq / count),
      residualMax,
      sectionResidual: Math.max(a.sectionResidual, b.sectionResidual),
      lockResidualU: Math.max(a.lockResidualU, b.lockResidualU),
      rawOrientationChange,
      appliedOrientationChange: mappings[i].orientation * mappings[i + 1].orientation < 0,
      frameFlipSuspected: Math.abs(frameTwist) > 2.1 || twistMax > 2.4,
    });
  }

  const lockErrors = rows.map((r) => r.lockResidualU);
  return {
    candidateId: candidate.id,
    anchorU: alignment.anchorU ?? ANCHOR_U,
    orderedIds: alignment.orderedIds,
    rows,
    frames,
    intervals,
    totals: {
      maxLockResidualU: lockErrors.length ? Math.max(...lockErrors) : 0,
      rmsLockResidualU: lockErrors.length
        ? Math.sqrt(lockErrors.reduce((sum, x) => sum + x * x, 0) / lockErrors.length)
        : 0,
      maxTwist: intervals.length ? Math.max(...intervals.map((x) => x.twistAmount)) : 0,
      maxFrameTwistDegrees: intervals.length ? Math.max(...intervals.map((x) => x.twistDegrees)) : 0,
      maxCorrespondenceResidual: intervals.length ? Math.max(...intervals.map((x) => x.correspondenceResidual)) : 0,
      maxParameterResidual: rows.length ? Math.max(...rows.map((r) => r.parameterResidual)) : 0,
      parameterResidual: rows.length ? Math.max(...rows.map((r) => r.parameterResidual)) : 0,
      orientationChanges: intervals.filter((x) => x.rawOrientationChange).length,
    },
  };
}

export function compareCorrespondenceCosts(sections, alignment, candidate, options = {}) {
  const sectionCount = sections.length;
  const marks = sections.reduce((n, s) => n + (s.marks?.length ?? 0), 0);
  const searchSamples = options.searchSamples ?? 384;
  const scoreSamples = options.scoreSamples ?? 72;
  const rebuildOps = sectionCount * marks * searchSamples + sectionCount * scoreSamples * sectionCount * 4;
  const frameOps = sectionCount * 48 + Math.max(1, sectionCount - 1) * scoreSamples * 4;

  let rebuildMs = 0;
  let frameMs = 0;
  try {
    const t0 = performance.now();
    if (options.benchmark !== false) {
      for (const section of sections) prepareSectionGeometry(section);
    }
    rebuildMs = performance.now() - t0;
    const t1 = performance.now();
    traceCorrespondence(sections, alignment, candidate, { samples: 32 });
    frameMs = performance.now() - t1;
  } catch {
    // performance is available in browsers and Node >=16; timing is observational only.
  }

  const lockedUsable = candidate?.usable !== false
    && (candidate?.scores?.lockError ?? 0) < (alignment?.lockTolerance ?? 0.05);
  const selected = lockedUsable
    ? CORRESPONDENCE_IMPLEMENTATION.TRACK_LOCKED_FRAME_FLIP
    : CORRESPONDENCE_IMPLEMENTATION.REBUILD_BY_SECTION;

  return {
    rebuildBySection: {
      implementation: CORRESPONDENCE_IMPLEMENTATION.REBUILD_BY_SECTION,
      estimatedOperations: rebuildOps,
      elapsedMs: Number(rebuildMs.toFixed(3)),
    },
    trackFrameFlips: {
      implementation: CORRESPONDENCE_IMPLEMENTATION.TRACK_LOCKED_FRAME_FLIP,
      estimatedOperations: frameOps,
      elapsedMs: Number(frameMs.toFixed(3)),
    },
    ratio: rebuildOps / Math.max(1, frameOps),
    selectedImplementation: selected,
    reason: lockedUsable
      ? '锁点对应已冻结且残差合格；逐截面全量重建起点/参数代价更高，因此只追踪标架翻面与增量扭转。'
      : '锁住对齐残差不合格，不能安全冻结；需要按截面重建起点、方向和参数对应。',
  };
}
