import { V, wrap01, clamp, gaussianSolve } from './vec.js';
import { findKnotSpan, basisFunctions } from './curves.js';
import { validateTopology, sectionCentroid } from './topology.js';
import { prepareSectionGeometry } from './alignment.js';

export function periodicBasisWeights(controlCount, u) {
  const n = controlCount;
  const s = wrap01(u) * n;
  let i = Math.floor(s);
  if (i >= n) i = n - 1;
  const t = s - i;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    indices: [(i - 1 + n) % n, i % n, (i + 1) % n, (i + 2) % n],
    weights: [
      (1 - t) ** 3 / 6,
      (3 * t3 - 6 * t2 + 4) / 6,
      (-3 * t3 + 3 * t2 + 3 * t + 1) / 6,
      t3 / 6,
    ],
  };
}

export function evalPeriodicSplineRow(controls, u) {
  const { indices, weights } = periodicBasisWeights(controls.length, u);
  let out = [0, 0, 0];
  for (let k = 0; k < 4; k++) out = V.add(out, V.scale(controls[indices[k]], weights[k]));
  return out;
}

export function cyclicInterpolationControls(points) {
  const n = points.length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    A[j][(j - 1 + n) % n] = 1;
    A[j][j] = 4;
    A[j][(j + 1) % n] = 1;
  }
  const rhs = points.map((p) => V.scale(p, 6));
  return gaussianSolve(A, rhs);
}

function secondDifferenceMatrix(n, cyclic) {
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    L[i][i] = -2;
    if (cyclic) {
      L[i][(i - 1 + n) % n] = 1;
      L[i][(i + 1) % n] = 1;
    } else {
      if (i > 0) L[i][i - 1] = 1;
      if (i < n - 1) L[i][i + 1] = 1;
    }
  }
  return L;
}

function regularizedControls(B, data, lambda, cyclicL) {
  const n = B.length;
  const BtB = Array.from({ length: n }, () => new Array(n).fill(0));
  const BtD = Array.from({ length: n }, () => [0, 0, 0]);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < n; a++) {
      if (Math.abs(B[i][a]) < 1e-12) continue;
      for (let b = 0; b < n; b++) BtB[a][b] += B[i][a] * B[i][b];
      BtD[a] = V.add(BtD[a], V.scale(data[i], B[i][a]));
    }
  }
  if (lambda > 0) {
    const L = secondDifferenceMatrix(n, cyclicL);
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          let ltl = 0;
          for (let k = 0; k < n; k++) ltl += L[k][a] * L[k][b];
          BtB[a][b] += lambda * ltl;
        }
      }
    }
  }
  return gaussianSolve(BtB, BtD);
}

export function chordParameters(sections) {
  const centroids = sections.map(sectionCentroid);
  const distances = [0];
  let total = 0;
  for (let i = 1; i < sections.length; i++) {
    total += V.dist(centroids[i - 1], centroids[i]);
    distances.push(total);
  }
  if (total < 1e-8) return sections.map((_, i) => i / Math.max(1, sections.length - 1));
  return distances.map((d) => d / total);
}

export function makeOpenKnotVector(controlCount, degree, params) {
  const p = Math.min(degree, controlCount - 1);
  const knots = [];
  for (let i = 0; i <= p; i++) knots.push(0);
  const internalCount = controlCount - p - 1;
  for (let j = 1; j <= internalCount; j++) {
    let sum = 0;
    for (let k = j; k <= j + p - 1; k++) sum += params[k];
    knots.push(sum / p);
  }
  for (let i = 0; i <= p; i++) knots.push(1);
  return knots;
}

function openCollocationMatrix(count, degree, knots, params) {
  const B = Array.from({ length: count }, () => new Array(count).fill(0));
  const p = Math.min(degree, count - 1);
  params.forEach((u, row) => {
    const span = findKnotSpan(p, clamp(u, knots[p], knots[count]), knots);
    const N = basisFunctions(span, u, p, knots);
    for (let r = 0; r <= p; r++) {
      const col = span - p + r;
      if (col >= 0 && col < count) B[row][col] = N[r];
    }
  });
  return B;
}

export function buildLoftSurface(sections, alignment, options = {}) {
  const topology = validateTopology(sections, { checkSelfIntersection: options.checkSelfIntersection ?? false });
  if (!topology.ok) {
    const err = new Error(topology.errors.map((e) => e.message).join('\n'));
    err.topology = topology;
    throw err;
  }

  const candidateId = options.candidateId ?? alignment.recommendedId;
  const candidate = alignment.candidates.find((c) => c.id === candidateId)
    ?? alignment.candidates.find((c) => c.recommended);
  if (!candidate) throw new Error('没有可用的对齐候选');

  const ordered = alignment.orderedIds
    .map((id) => sections.find((s) => s.id === id))
    .filter(Boolean);
  const mappings = ordered.map((s) => candidate.mappings.find((m) => m.sectionId === s.id));

  const nU = Math.max(16, Math.floor(options.uControlCount ?? options.uCount ?? 96));
  const smoothU = clamp(options.transverseSmoothing ?? 0, 0, 1);
  const smoothV = clamp(options.longitudinalSmoothing ?? 0, 0, 1);
  const lambdaU = smoothU <= 0 ? 0 : 0.18 * smoothU ** 3;
  const lambdaV = smoothV <= 0 ? 0 : 0.018 * smoothV ** 3;

  const alignedPoints = ordered.map((section, i) => {
    const m = mappings[i];
    const prep = prepareSectionGeometry(section);
    return Array.from({ length: nU }, (_, j) => {
      const u = j / nU;
      const a = wrap01(m.offset + m.orientation * u);
      return prep.arc.pointAt(a);
    });
  });

  let sectionControls;
  if (lambdaU > 0) {
    const Bu = Array.from({ length: nU }, (_, row) => {
      const { indices, weights } = periodicBasisWeights(nU, row / nU);
      const r = new Array(nU).fill(0);
      indices.forEach((idx, k) => { r[idx] = weights[k]; });
      return r;
    });
    sectionControls = alignedPoints.map((row) => regularizedControls(Bu, row, lambdaU, true));
  } else {
    sectionControls = alignedPoints.map(cyclicInterpolationControls);
  }

  const paramsV = options.vParameters ?? chordParameters(ordered);
  const nV = ordered.length;
  const pV = Math.min(3, nV - 1);
  const knotsV = makeOpenKnotVector(nV, pV, paramsV);
  const Bv = openCollocationMatrix(nV, pV, knotsV, paramsV);

  const controls = Array.from({ length: nV }, () => new Array(nU));
  for (let k = 0; k < nU; k++) {
    const rhs = sectionControls.map((row) => row[k]);
    let columnControls;
    if (lambdaV > 0) columnControls = regularizedControls(Bv, rhs, lambdaV, false);
    else columnControls = gaussianSolve(Bv, rhs);
    for (let i = 0; i < nV; i++) controls[i][k] = columnControls[i];
  }

  const surface = {
    kind: 'TensorCubicPeriodicLoftSurface',
    id: options.id ?? `loft-${candidate.id}`,
    closedU: true,
    degreeU: 3,
    degreeV: pV,
    uControlCount: nU,
    vControlCount: nV,
    knotsUType: 'periodic-uniform-cubic',
    knotsU: Array.from({ length: nU + 4 }, (_, i) => (i - 3) / nU),
    knotsV,
    parametersV: paramsV,
    controls,
    sectionIds: ordered.map((s) => s.id),
    alignmentId: candidate.id,
    alignmentScores: candidate.scores,
    settings: { ...options, candidateId: candidate.id, lambdaU, lambdaV },

    point(u, v) {
      const vv = clamp(v, 0, 1);
      const span = findKnotSpan(pV, vv, knotsV);
      const N = basisFunctions(span, vv, pV, knotsV);
      let out = [0, 0, 0];
      for (let r = 0; r <= pV; r++) {
        const rowIndex = span - pV + r;
        if (rowIndex < 0 || rowIndex >= nV) continue;
        const rowPoint = evalPeriodicSplineRow(controls[rowIndex], u);
        out = V.add(out, V.scale(rowPoint, N[r]));
      }
      return out;
    },
  };

  surface.normalAt = (u, v, h = 1e-4) => {
    const du = V.sub(surface.point(wrap01(u + h), v), surface.point(wrap01(u - h), v));
    const dv = V.sub(surface.point(u, clamp(v + h, 0, 1)), surface.point(u, clamp(v - h, 0, 1)));
    return V.normalize(V.cross(du, dv));
  };

  return surface;
}

export function surfaceDerivatives(surface, u, v, h = 1e-3) {
  const f = (uu, vv) => surface.point(wrap01(uu), clamp(vv, 0, 1));
  const d1 = V.scale(V.add(f(u + h, v), V.scale(f(u - h, v), -1)), 1 / (2 * h));
  const d2 = V.scale(V.add(f(u, v + h), V.scale(f(u, v - h), -1)), 1 / (2 * h));
  return { du: d1, dv: d2, normal: V.normalize(V.cross(d1, d2)) };
}

function rightFirst(surface, u, v, axis, h) {
  const f = axis === 'u'
    ? (x) => surface.point(wrap01(x), v)
    : (x) => surface.point(u, clamp(x, 0, 1));
  const x = axis === 'u' ? u : v;
  return V.scale(V.add(V.scale(f(x), -3), V.add(V.scale(f(x + h), 4), V.scale(f(x + 2 * h), -1))), 1 / (2 * h));
}
function leftFirst(surface, u, v, axis, h) {
  const f = axis === 'u'
    ? (x) => surface.point(wrap01(x), v)
    : (x) => surface.point(u, clamp(x, 0, 1));
  const x = axis === 'u' ? u : v;
  return V.scale(V.add(V.scale(f(x), 3), V.add(V.scale(f(x - h), -4), f(x - 2 * h))), 1 / (2 * h));
}
function rightSecond(surface, u, v, axis, h) {
  const f = axis === 'u'
    ? (x) => surface.point(wrap01(x), v)
    : (x) => surface.point(u, clamp(x, 0, 1));
  const x = axis === 'u' ? u : v;
  return V.scale(V.add(V.scale(f(x), 2), V.add(V.add(V.scale(f(x + h), -5), V.scale(f(x + 2 * h), 4)), V.scale(f(x + 3 * h), -1))), 1 / (h * h));
}
function leftSecond(surface, u, v, axis, h) {
  const f = axis === 'u'
    ? (x) => surface.point(wrap01(x), v)
    : (x) => surface.point(u, clamp(x, 0, 1));
  const x = axis === 'u' ? u : v;
  return V.scale(V.add(V.scale(f(x), 2), V.add(V.add(V.scale(f(x - h), -5), V.scale(f(x - 2 * h), 4)), V.scale(f(x - 3 * h), -1))), 1 / (h * h));
}

export function checkContinuity(surface, options = {}) {
  const h = options.h ?? 1e-3;
  const vSamples = options.vSamples ?? [0.18, 0.37, 0.63, 0.82];
  const uBoundaries = Array.from({ length: Math.min(16, surface.uControlCount) }, (_, i) => i / Math.min(16, surface.uControlCount));
  const vBoundaries = [...new Set(surface.knotsV.slice(surface.degreeV + 1, surface.knotsV.length - surface.degreeV - 1))]
    .filter((x) => x > 0.02 && x < 0.98);

  let c0 = 0, c1 = 0, c2 = 0;
  for (const ub of uBoundaries) {
    for (const v of vSamples) {
      c0 = Math.max(c0, V.dist(surface.point(ub, v), surface.point(wrap01(ub + 1e-7), v)));
      c1 = Math.max(c1, V.dist(rightFirst(surface, ub, v, 'u', h), leftFirst(surface, ub, v, 'u', h)));
      c2 = Math.max(c2, V.dist(rightSecond(surface, ub, v, 'u', h), leftSecond(surface, ub, v, 'u', h)));
    }
  }
  for (const vb of vBoundaries) {
    for (let k = 1; k < 12; k++) {
      const u = k / 12;
      c0 = Math.max(c0, V.dist(surface.point(u, vb), surface.point(u, clamp(vb + 1e-7, 0, 1))));
      c1 = Math.max(c1, V.dist(rightFirst(surface, u, vb, 'v', h), leftFirst(surface, u, vb, 'v', h)));
      c2 = Math.max(c2, V.dist(rightSecond(surface, u, vb, 'v', h), leftSecond(surface, u, vb, 'v', h)));
    }
  }

  return {
    c0MaxJump: c0,
    c1DerivativeJump: c1,
    c2SecondDerivativeJump: c2,
    c0Pass: c0 < 1e-5,
    c1Pass: c1 < 0.08,
    c2Pass: c2 < 8,
    note: '三次 B 样条在单节点处理论为 C2；数值差分用于界面持续检验。调节光顺正则后报告实际偏差。',
  };
}

export function measureInterpolation(surface, sections, alignment, candidate, options = {}) {
  const ordered = alignment.orderedIds.map((id) => sections.find((s) => s.id === id));
  const mappings = ordered.map((s) => candidate.mappings.find((m) => m.sectionId === s.id));
  const testU = options.uSamples ?? 240;
  let sourceMax = 0;
  let gridMax = 0;
  let normalBad = 0;
  let normalCount = 0;

  ordered.forEach((section, i) => {
    const v = surface.parametersV[i];
    const prep = prepareSectionGeometry(section);
    const m = mappings[i];
    for (let j = 0; j < testU; j++) {
      const u = j / testU;
      const expectedArc = wrap01(m.offset + m.orientation * u);
      const expected = prep.arc.pointAt(expectedArc);
      const got = surface.point(u, v);
      sourceMax = Math.max(sourceMax, V.dist(expected, got));
      const n = surface.normalAt(u, v);
      normalCount++;
      if (!Number.isFinite(n[0]) || V.norm(n) < 0.5) normalBad++;
    }
    for (let j = 0; j < surface.uControlCount; j++) {
      const u = j / surface.uControlCount;
      const expectedArc = wrap01(m.offset + m.orientation * u);
      const expected = prep.arc.pointAt(expectedArc);
      gridMax = Math.max(gridMax, V.dist(expected, surface.point(u, v)));
    }
  });

  return {
    sourceSectionMaxError: sourceMax,
    collocationMaxError: gridMax,
    normalBad,
    normalCount,
    pass: sourceMax < (options.tolerance ?? 2e-3) && gridMax < 1e-6 && normalBad === 0,
  };
}

export function tessellateSurface(surface, options = {}) {
  const uSegments = options.uSegments ?? 160;
  const vSegments = options.vSegments ?? 72;
  const positions = [];
  const uvs = [];
  const normals = [];
  const indices = [];

  for (let i = 0; i <= vSegments; i++) {
    const v = i / vSegments;
    for (let j = 0; j <= uSegments; j++) {
      const u = j / uSegments;
      const p = surface.point(u, v);
      const n = surface.normalAt(u, v);
      positions.push(...p);
      uvs.push(u, v);
      normals.push(...n);
    }
  }

  const row = uSegments + 1;
  for (let i = 0; i < vSegments; i++) {
    for (let j = 0; j < uSegments; j++) {
      const a = i * row + j;
      const b = a + 1;
      const c = (i + 1) * row + j;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  return { positions, uvs, normals, indices, uSegments, vSegments };
}

export function meshToObj(mesh, name = 'multi_section_loft') {
  const lines = [`o ${name}`];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(`v ${mesh.positions[i].toFixed(7)} ${mesh.positions[i + 1].toFixed(7)} ${mesh.positions[i + 2].toFixed(7)}`);
  }
  for (let i = 0; i < mesh.uvs.length; i += 2) {
    lines.push(`vt ${mesh.uvs[i].toFixed(7)} ${(1 - mesh.uvs[i + 1]).toFixed(7)}`);
  }
  for (let i = 0; i < mesh.normals.length; i += 3) {
    lines.push(`vn ${mesh.normals[i].toFixed(7)} ${mesh.normals[i + 1].toFixed(7)} ${mesh.normals[i + 2].toFixed(7)}`);
  }
  for (let f = 0; f < mesh.indices.length; f += 3) {
    const face = [mesh.indices[f], mesh.indices[f + 1], mesh.indices[f + 2]]
      .map((idx) => {
        const vi = idx + 1;
        return `${vi}/${vi}/${vi}`;
      });
    lines.push(`f ${face.join(' ')}`);
  }
  return lines.join('\n');
}

export function surfaceToJSON(surface) {
  return JSON.stringify({
    type: surface.kind,
    closedU: surface.closedU,
    degreeU: surface.degreeU,
    degreeV: surface.degreeV,
    uControlCount: surface.uControlCount,
    knotsU: surface.knotsU,
    knotsV: surface.knotsV,
    parametersV: surface.parametersV,
    sectionIds: surface.sectionIds,
    alignmentId: surface.alignmentId,
    settings: surface.settings,
    controlNet: surface.controls,
    evaluation: 'S(u,v)=sum N_periodic,u^3(u) N_open,v^p(v) P_ij; u,v in [0,1]',
  }, null, 2);
}
