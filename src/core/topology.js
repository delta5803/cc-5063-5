import { V } from './vec.js';
import { curvePoint } from './curves.js';

export function sectionLoops(section) {
  if (Array.isArray(section.loops) && section.loops.length) return section.loops;
  if (section.curve) return [{ role: 'outer', curve: section.curve }];
  if (section.curves?.length) {
    return section.curves.map((curve, i) => ({ role: i === 0 ? 'outer' : 'hole', curve }));
  }
  return [];
}

export function topologySignature(section) {
  const loops = sectionLoops(section);
  return {
    loopCount: loops.length,
    holeCount: loops.filter((l) => l.role === 'hole').length,
    roles: loops.map((l) => l.role ?? 'outer'),
    orientations: loops.map((l) => l.orientation ?? 'unknown'),
  };
}

function sameCyclicOrder(a, b) {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const doubled = [...b, ...b].map(String);
  const target = a.map(String).join('|');
  for (let i = 0; i < b.length; i++) {
    if (doubled.slice(i, i + a.length).join('|') === target) return true;
  }
  const rev = [...b].reverse();
  const revDoubled = [...rev, ...rev].map(String);
  for (let i = 0; i < rev.length; i++) {
    if (revDoubled.slice(i, i + a.length).join('|') === target) return true;
  }
  return false;
}

function segmentsIntersect2D(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const rxs = r[0] * s[1] - r[1] * s[0];
  const qpxr = (c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0];
  if (Math.abs(rxs) < 1e-10 || Math.abs(qpxr) > 1e-8) return false;
  const qpxs = (c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0];
  const t = qpxs / rxs;
  const u = qpxr / rxs;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
}

export function curveHasSelfIntersection(curve, samples = 96) {
  const pts = Array.from({ length: samples }, (_, i) => curvePoint(curve, i / samples));
  for (let i = 0; i < samples; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % samples];
    for (let j = i + 2; j < samples; j++) {
      if (i === 0 && j === samples - 1) continue;
      const c = pts[j];
      const d = pts[(j + 1) % samples];
      if (segmentsIntersect2D(a, b, c, d)) return true;
    }
  }
  return false;
}

export function validateTopology(sections, options = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(sections) || sections.length < 2) {
    return {
      ok: false,
      errors: [{ code: 'TOO_FEW_SECTIONS', message: '多截面放样至少需要 2 个有序截面。' }],
      warnings: [],
    };
  }

  const first = topologySignature(sections[0]);
  sections.forEach((section, index) => {
    const sig = topologySignature(section);
    if (sig.loopCount === 0) {
      errors.push({
        code: 'EMPTY_SECTION',
        sectionId: section.id,
        message: `截面 ${section.id ?? index} 没有任何闭合轮廓。`,
      });
      return;
    }
    if (sig.loopCount !== first.loopCount || sig.holeCount !== first.holeCount) {
      errors.push({
        code: 'TOPOLOGY_HOLE_COUNT_MISMATCH',
        sectionId: section.id,
        message: `孔洞/环数量改变：基准 ${first.loopCount} 环（${first.holeCount} 孔），截面 ${section.id ?? index} 为 ${sig.loopCount} 环（${sig.holeCount} 孔）。初版拒绝自动补接。`,
      });
    }
    if (sig.roles.join(',') !== first.roles.join(',')) {
      errors.push({
        code: 'TOPOLOGY_ROLE_MISMATCH',
        sectionId: section.id,
        message: `截面 ${section.id ?? index} 的外环/孔洞层级顺序与基准不一致。`,
      });
    }
    if (options.checkSelfIntersection !== false && section.curve && curveHasSelfIntersection(section.curve)) {
      errors.push({
        code: 'CURVE_SELF_INTERSECTION',
        sectionId: section.id,
        message: `截面 ${section.id ?? index} 存在自交叉，交叉顺序不明确，已拒绝放样。`,
      });
    }
  });

  const anchorMaps = sections.map((s) => {
    const anchors = [
      ...(s.marks ?? []),
      ...(s.locks ?? []),
    ].map((a) => ({
      id: a.lineId ?? a.id,
      t: a.arc ?? a.parameter ?? 0,
    }));
    anchors.sort((a, b) => a.t - b.t);
    return anchors.map((a) => a.id).filter(Boolean);
  });
  const baseOrder = anchorMaps[0];
  anchorMaps.forEach((order, i) => {
    if (baseOrder.length > 1 && order.length === baseOrder.length && !sameCyclicOrder(baseOrder, order)) {
      errors.push({
        code: 'CORRESPONDENCE_ORDER_CROSSING',
        sectionId: sections[i].id,
        message: `截面 ${sections[i].id} 的锁点/记号循环顺序为 [${order.join(' → ')}]，与基准 [${baseOrder.join(' → ')}] 不相容；连接会交叉，已拒绝。`,
      });
    }
  });

  if (first.holeCount > 0 && errors.length === 0) {
    warnings.push({
      code: 'HOLE_CORRESPONDENCE_NEEDS_LOCKS',
      message: '各截面孔洞数量一致；纹理展开与记号反馈当前只作用于带锁点的外环，孔环需另送显式对应。',
    });
  }

  return { ok: errors.length === 0, errors, warnings, signature: first };
}

export function sectionCentroid(section) {
  const loop = sectionLoops(section)[0];
  const curve = loop?.curve ?? section.curve;
  const pts = Array.from({ length: 64 }, (_, i) => curvePoint(curve, i / 64));
  return V.centroid(pts);
}
