import { V, wrap01, circularDistance } from './vec.js';
import { curvePoint, makeArcLengthCurve, nearestCurveParameter } from './curves.js';
import { sectionLoops } from './topology.js';

export const ANCHOR_U = 0.22;

export function prepareSectionGeometry(section) {
  if (section._prepared) return section._prepared;
  const loop = sectionLoops(section)[0];
  const curve = loop?.curve ?? section.curve;
  if (!curve) throw new Error(`截面 ${section.id} 缺少曲线`);
  const arc = makeArcLengthCurve(curve);
  const samples = Array.from({ length: 96 }, (_, i) => curvePoint(curve, i / 96));
  const centroid = V.centroid(samples);

  let area2 = [0, 0, 0];
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % samples.length];
    area2 = V.add(area2, V.cross(a, b));
  }
  const normalHint = section.planeNormal ?? [0, 0, 1];
  const orientation = V.dot(area2, normalHint) < 0 ? -1 : 1;

  const primaryMark = section.marks?.find((m) => m.primary) ?? section.marks?.[0] ?? section.locks?.[0];
  let markArc = 0;
  if (primaryMark) {
    if (primaryMark.arc != null) markArc = wrap01(primaryMark.arc);
    else if (primaryMark.parameter != null) markArc = arc.fractionAtRawParameter(primaryMark.parameter);
    else if (primaryMark.point) {
      const hit = nearestCurveParameter(curve, primaryMark.point, 768);
      markArc = arc.fractionAtRawParameter(hit.u);
    }
  }

  const prepared = { curve, arc, centroid, orientation, markArc, normal: V.normalize(area2) };
  Object.defineProperty(section, '_prepared', { value: prepared, enumerable: false });
  return prepared;
}

export function markCanonicalU(mapping, markArc) {
  return wrap01(mapping.orientation * (markArc - mapping.offset));
}

export function getMarkArc(section, mark) {
  const prep = prepareSectionGeometry(section);
  if (mark.arc != null) return wrap01(mark.arc);
  if (mark.parameter != null) return prep.arc.fractionAtRawParameter(mark.parameter);
  if (mark.point) {
    const hit = nearestCurveParameter(prep.curve, mark.point, 768);
    return prep.arc.fractionAtRawParameter(hit.u);
  }
  return prep.markArc;
}

function radialPoint(mapping, u) {
  const a = wrap01(mapping.offset + mapping.orientation * u);
  return mapping.arc.pointAt(a);
}

function angleAroundZ(p, c) {
  return Math.atan2(p[1] - c[1], p[0] - c[0]);
}

function unwrapAngleDifference(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function evaluateCandidate(orderedSections, mappings, options = {}) {
  const K = options.scoreSamples ?? 72;
  const prepared = orderedSections.map(prepareSectionGeometry);
  let radialEnergy = 0;
  let pairCount = 0;
  let twistSq = 0;
  let twistSamples = 0;
  let secondDifference = 0;

  const sampled = mappings.map((m, i) => {
    const row = [];
    for (let j = 0; j <= K; j++) row.push(radialPoint(m, j / K));
    return row;
  });

  for (let i = 0; i < orderedSections.length - 1; i++) {
    for (let j = 0; j < K; j++) {
      const u = j / K;
      const a = sampled[i][j];
      const b = sampled[i + 1][j];
      const ra = V.sub(a, prepared[i].centroid);
      const rb = V.sub(b, prepared[i + 1].centroid);
      radialEnergy += V.norm2(V.sub(ra, rb));
      pairCount++;

      if (Math.abs(prepared[i].normal[2]) > 0.7 && Math.abs(prepared[i + 1].normal[2]) > 0.7) {
        const aa = angleAroundZ(a, prepared[i].centroid);
        const ab = angleAroundZ(b, prepared[i + 1].centroid);
        const d = unwrapAngleDifference(ab, aa);
        twistSq += d * d;
        twistSamples++;
      }
    }
  }

  for (let i = 1; i < orderedSections.length - 1; i++) {
    for (let j = 0; j < K; j++) {
      const p0 = sampled[i - 1][j];
      const p1 = sampled[i][j];
      const p2 = sampled[i + 1][j];
      const d2 = V.add(V.sub(p0, V.scale(p1, 2)), p2);
      secondDifference += V.norm2(d2);
    }
  }

  const lockErrors = [];
  orderedSections.forEach((section, i) => {
    const prep = prepared[i];
    const marks = section.marks?.length ? section.marks : (section.locks ?? []);
    for (const mark of marks) {
      let arc = prep.markArc;
      if (!mark.primary && mark.arc != null) arc = wrap01(mark.arc);
      else if (mark.parameter != null) arc = prep.arc.fractionAtRawParameter(mark.parameter);
      const u = markCanonicalU(mappings[i], arc);
      const target = mark.canonicalU ?? ANCHOR_U;
      lockErrors.push(circularDistance(u, target));
    }
  });

  const lockError = lockErrors.length ? Math.max(...lockErrors) : 0;
  const lockRms = lockErrors.length
    ? Math.sqrt(lockErrors.reduce((a, b) => a + b * b, 0) / lockErrors.length)
    : 0;
  const geometric = radialEnergy / Math.max(1, pairCount);
  const twist = twistSamples ? Math.sqrt(twistSq / twistSamples) : Math.sqrt(secondDifference / Math.max(1, K * Math.max(1, orderedSections.length - 2)));
  const fairness = secondDifference / Math.max(1, K * Math.max(1, orderedSections.length - 2));

  return {
    lockError,
    lockRms,
    geometric,
    twist,
    fairness,
    total: lockRms * 12 + geometric * 0.35 + fairness * 0.08 + twist * 0.15,
  };
}

function makeMapping(section, mode, options) {
  const prep = prepareSectionGeometry(section);
  const orientation = options.forceRawDirection ? 1 : prep.orientation;
  let offset = 0;
  if (mode === 'locked' || mode === 'half') {
    offset = prep.markArc - orientation * ANCHOR_U;
  }
  if (mode === 'half') offset += options.halfShift ?? 0.5;
  if (mode === 'raw-oriented') offset = 0;
  return {
    sectionId: section.id,
    arc: prep.arc,
    orientation,
    offset: wrap01(offset),
    sourceDegree: prep.curve.degree,
    sourceKnots: prep.curve.knots,
  };
}

export function solveAlignment(sections, options = {}) {
  const ordered = options.orderIds
    ? options.orderIds.map((id) => sections.find((s) => s.id === id)).filter(Boolean)
    : [...sections];

  const symmetricId = options.symmetricSectionId ?? ordered.find((s) => s.symmetryOrder && s.symmetryOrder > 1)?.id;
  const symmetryShift = options.symmetryShift ?? 0.5;

  const candidateDefs = [
    { id: 'raw-index', label: '原始数组下标支（不校正起点）', mode: 'raw', forceRawDirection: true },
    { id: 'raw-oriented', label: '仅统一方向、保留原始起点', mode: 'raw-oriented' },
    { id: 'locked', label: '锁点/记号对齐支', mode: 'locked' },
  ];
  if (symmetricId) {
    candidateDefs.push({ id: 'symmetry-half', label: '对称歧义：全局错半圈 UV 支（几何等价）', mode: 'half' });
  }

  const candidates = candidateDefs.map((def) => {
    const mappings = ordered.map((section) => makeMapping(section, def.mode, {
      ...options,
      halfShift: symmetryShift,
      forceRawDirection: def.forceRawDirection,
    }));
    const scores = evaluateCandidate(ordered, mappings, options);
    return {
      id: def.id,
      label: def.label,
      mappings,
      scores,
      usable: scores.lockError < (options.lockTolerance ?? 0.05),
    };
  });

  if (symmetricId) {
    const a = candidates.find((c) => c.id === 'locked');
    const b = candidates.find((c) => c.id === 'symmetry-half');
    if (a && b) {
      const commonTwist = Math.min(a.scores.twist, b.scores.twist);
      const commonGeo = Math.min(a.scores.geometric, b.scores.geometric);
      a.scores.symmetryReducedTwist = commonTwist;
      b.scores.symmetryReducedTwist = commonTwist;
      a.scores.symmetryReducedGeometric = commonGeo;
      b.scores.symmetryReducedGeometric = commonGeo;
      a.scores.geometryTie = true;
      b.scores.geometryTie = true;
      b.halfTurnResidual = symmetryShift;
    }
  }

  const usable = candidates.filter((c) => c.usable);
  const pool = usable.length ? usable : candidates;
  const recommended = [...pool].sort((a, b) => {
    const tw = (a.scores.symmetryReducedTwist ?? a.scores.twist) - (b.scores.symmetryReducedTwist ?? b.scores.twist);
    if (Math.abs(tw) > 0.03) return tw;
    return a.scores.lockRms - b.scores.lockRms || a.scores.total - b.scores.total;
  })[0];
  recommended.recommended = true;
  recommended.decisionReason = buildDecisionReason(recommended, candidates, symmetricId);

  return {
    anchorU: ANCHOR_U,
    orderedIds: ordered.map((s) => s.id),
    candidates,
    recommendedId: recommended.id,
    symmetricId,
    lockTolerance: options.lockTolerance ?? 0.05,
  };
}

function buildDecisionReason(selected, candidates, symmetricId) {
  const raw = candidates.find((c) => c.id === 'raw-index');
  const half = candidates.find((c) => c.id === 'symmetry-half');
  const parts = [];
  if (selected.id === 'locked') {
    parts.push('锁点残差最小，手绘记号在展开图中落在同一条竖直线上。');
    if (raw && raw.scores.lockError > selected.scores.lockError + 0.05) {
      parts.push(`翻转/不一致起点若按下标直连，锁点偏差为 ${raw.scores.lockError.toFixed(3)} 圈、扭转指标 ${raw.scores.twist.toFixed(3)}；因此换用锁点对齐支。`);
    }
    if (half && symmetricId) {
      parts.push(`对称截面 ${symmetricId} 触发二重歧义：全局错半圈支只是 UV/纹理相位换支，几何与扭转和锁点支相同；但其记号相对固定纹理锁线偏差 ${half.scores.lockError.toFixed(3)} 圈，展开反馈否决该支。`);
    }
  } else {
    parts.push(`当前选择 ${selected.id}，但锁点残差不是最优；请检查截面锁点。`);
  }
  return parts.join(' ');
}
