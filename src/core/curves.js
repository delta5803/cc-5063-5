import { V, wrap01 } from './vec.js';

export function findKnotSpan(degree, u, knots) {
  const lastIndex = knots.length - degree - 2;
  if (lastIndex < degree) throw new Error('Invalid NURBS knot vector');
  if (u >= knots[lastIndex + 1]) return lastIndex;
  if (u <= knots[degree]) return degree;

  let low = degree;
  let high = lastIndex + 1;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (u < knots[mid]) high = mid;
    else low = mid;
  }
  return low;
}

export function basisFunctions(span, u, degree, knots) {
  const N = new Array(degree + 1).fill(0);
  const left = new Array(degree + 1).fill(0);
  const right = new Array(degree + 1).fill(0);
  N[0] = 1;

  for (let j = 1; j <= degree; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom === 0 ? 0 : N[r] / denom;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

export function evaluateNurbs(curve, uNormalized) {
  const p = curve.degree;
  const U = curve.knots;
  const u0 = U[p];
  const u1 = U[curve.points.length];
  const u = u0 + wrap01(uNormalized) * (u1 - u0);
  const span = findKnotSpan(p, u, U);
  const N = basisFunctions(span, u, p, U);

  let wx = 0, wy = 0, wz = 0, wsum = 0;
  for (let k = 0; k <= p; k++) {
    const idx = span - p + k;
    const w = curve.weights?.[idx] ?? 1;
    const b = N[k] * w;
    const pt = curve.points[idx];
    wx += pt[0] * b;
    wy += pt[1] * b;
    wz += pt[2] * b;
    wsum += b;
  }
  if (Math.abs(wsum) < 1e-12) return [0, 0, 0];
  return [wx / wsum, wy / wsum, wz / wsum];
}

export function curvePoint(curve, u) {
  if (typeof curve.pointAt === 'function') return curve.pointAt(u);
  if (curve.type === 'nurbs' || curve.knots) return evaluateNurbs(curve, u);
  if (Array.isArray(curve.samples)) {
    const n = curve.samples.length;
    const x = wrap01(u) * n;
    const i = Math.floor(x) % n;
    const f = x - Math.floor(x);
    return V.lerp(curve.samples[i], curve.samples[(i + 1) % n], f);
  }
  throw new Error('Unsupported curve representation');
}

export function curveTangent(curve, u, eps = 1e-4) {
  const a = curvePoint(curve, wrap01(u - eps));
  const b = curvePoint(curve, wrap01(u + eps));
  return V.normalize(V.sub(b, a));
}

export function sampleCurveMapping(curve, count, offset = 0, orientation = 1) {
  const out = new Array(count);
  const s = orientation < 0 ? -1 : 1;
  for (let j = 0; j < count; j++) {
    const u = j / count;
    out[j] = curvePoint(curve, wrap01(offset + s * u));
  }
  return out;
}

export function createRationalCircleNurbs(options = {}) {
  const {
    id = 'circle',
    center = [0, 0, 0],
    radiusX = 1,
    radiusY = radiusX,
    startAngle = 0,
  } = options;

  const base = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0],
  ];
  const baseWeights = [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1];
  const ca = Math.cos(startAngle);
  const sa = Math.sin(startAngle);
  const points = base.map(([x, y]) => {
    const ex = x * radiusX;
    const ey = y * radiusY;
    const rx = ex * ca - ey * sa;
    const ry = ex * sa + ey * ca;
    return [center[0] + rx, center[1] + ry, center[2] ?? 0];
  });

  return {
    id,
    type: 'nurbs',
    subtype: radiusX === radiusY ? 'circle' : 'ellipse',
    degree: 2,
    knots: [0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4],
    points,
    weights: baseWeights,
    closed: true,
    domain: [0, 1],
  };
}

export function angleToCircleParameter(angle, startAngle = 0) {
  return wrap01((angle - startAngle) / (Math.PI * 2));
}

export function createPolylineCurve(points, options = {}) {
  return {
    id: options.id ?? 'polyline',
    type: 'polyline',
    degree: 1,
    knots: points.map((_, i) => i / Math.max(1, points.length - 1)),
    points,
    closed: options.closed ?? true,
    pointAt(u) {
      const n = points.length;
      if (this.closed) {
        const x = wrap01(u) * n;
        const i = Math.floor(x) % n;
        return V.lerp(points[i], points[(i + 1) % n], x - Math.floor(x));
      }
      const x = Math.min(0.999999, Math.max(0, u)) * (n - 1);
      const i = Math.floor(x);
      return V.lerp(points[i], points[Math.min(n - 1, i + 1)], x - i);
    },
  };
}

export function arcLengthParameterTable(curve, samples = 512) {
  const pts = [];
  const lengths = [0];
  let total = 0;
  let prev = curvePoint(curve, 0);
  pts.push(prev);
  for (let i = 1; i <= samples; i++) {
    const p = curvePoint(curve, i / samples);
    total += V.dist(prev, p);
    lengths.push(total);
    pts.push(p);
    prev = p;
  }
  return { lengths, total, samples };
}

export function nearestCurveParameter(curve, point, samples = 512) {
  let bestU = 0;
  let bestD = Infinity;
  for (let i = 0; i < samples; i++) {
    const u = i / samples;
    const d = V.dist(curvePoint(curve, u), point);
    if (d < bestD) {
      bestD = d;
      bestU = u;
    }
  }
  return { u: bestU, distance: bestD };
}

export function makeArcLengthCurve(curve, samples = 768) {
  const rawUs = [];
  const points = [];
  const lengths = [0];
  let total = 0;
  let prev = curvePoint(curve, 0);
  rawUs.push(0);
  points.push(prev);

  for (let i = 1; i <= samples; i++) {
    const u = i / samples;
    const p = curvePoint(curve, u);
    total += V.dist(prev, p);
    rawUs.push(u);
    points.push(p);
    lengths.push(total);
    prev = p;
  }

  function rawParameterAtFraction(fraction) {
    const target = wrap01(fraction) * total;
    let lo = 0;
    let hi = lengths.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid] <= target) lo = mid;
      else hi = mid;
    }
    const span = Math.max(1e-12, lengths[lo + 1] - lengths[lo]);
    const a = (target - lengths[lo]) / span;
    return rawUs[lo] + (rawUs[lo + 1] - rawUs[lo]) * a;
  }

  function fractionAtRawParameter(rawU) {
    const x = wrap01(rawU) * samples;
    const i = Math.min(samples - 1, Math.floor(x));
    const a = x - i;
    const l0 = lengths[i];
    const l1 = lengths[i + 1];
    return wrap01((l0 + (l1 - l0) * a) / total);
  }

  return {
    id: curve.id,
    sourceCurve: curve,
    degree: curve.degree,
    knots: curve.knots,
    closed: true,
    totalLength: total,
    rawParameterAtFraction,
    fractionAtRawParameter,
    pointAt(fraction) {
      return curvePoint(curve, rawParameterAtFraction(fraction));
    },
  };
}
