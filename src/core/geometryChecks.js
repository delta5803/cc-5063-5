import { V } from './vec.js';

function sampleMesh(surface, uSegments, vSegments) {
  const positions = [];
  const indices = [];
  const row = uSegments + 1;
  for (let i = 0; i <= vSegments; i++) {
    const v = i / vSegments;
    for (let j = 0; j <= uSegments; j++) {
      const p = surface.point(j / uSegments, v);
      positions.push(p);
    }
  }
  for (let i = 0; i < vSegments; i++) {
    for (let j = 0; j < uSegments; j++) {
      const a = i * row + j;
      const b = a + 1;
      const c = (i + 1) * row + j;
      const d = c + 1;
      indices.push([a, b, c], [b, d, c]);
    }
  }
  return { positions, indices };
}

function segmentHitsTriangleInterior(p0, p1, a, b, c, eps = 1e-7) {
  const dir = V.sub(p1, p0);
  const e1 = V.sub(b, a);
  const e2 = V.sub(c, a);
  const h = V.cross(dir, e2);
  const det = V.dot(e1, h);
  if (Math.abs(det) < eps) return false;

  const invDet = 1 / det;
  const s = V.sub(p0, a);
  const u = invDet * V.dot(s, h);
  if (u <= eps || u >= 1 - eps) return false;

  const q = V.cross(s, e1);
  const v = invDet * V.dot(dir, q);
  if (v <= eps || u + v >= 1 - eps) return false;

  const t = invDet * V.dot(e2, q);
  return t > eps && t < 1 - eps;
}

function trianglesIntersect(pos, ta, tb) {
  const [ia0, ia1, ia2] = ta;
  const [ib0, ib1, ib2] = tb;
  if (ia0 === ib0 || ia0 === ib1 || ia0 === ib2
    || ia1 === ib0 || ia1 === ib1 || ia1 === ib2
    || ia2 === ib0 || ia2 === ib1 || ia2 === ib2) {
    return false;
  }

  const A = [pos[ia0], pos[ia1], pos[ia2]];
  const B = [pos[ib0], pos[ib1], pos[ib2]];
  const edgesA = [[A[0], A[1]], [A[1], A[2]], [A[2], A[0]]];
  const edgesB = [[B[0], B[1]], [B[1], B[2]], [B[2], B[0]]];

  for (const [p, q] of edgesA) {
    if (segmentHitsTriangleInterior(p, q, B[0], B[1], B[2])) return true;
  }
  for (const [p, q] of edgesB) {
    if (segmentHitsTriangleInterior(p, q, A[0], A[1], A[2])) return true;
  }
  return false;
}

function triangleBounds(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

function boundsOverlap(a, b, pad = 1e-6) {
  return !(
    a.max[0] < b.min[0] - pad || a.min[0] > b.max[0] + pad
    || a.max[1] < b.min[1] - pad || a.min[1] > b.max[1] + pad
    || a.max[2] < b.min[2] - pad || a.min[2] > b.max[2] + pad
  );
}

export function countSurfaceSelfIntersections(surface, options = {}) {
  const uSegments = options.uSegments ?? 28;
  const vSegments = options.vSegments ?? 14;
  const { positions, indices } = sampleMesh(surface, uSegments, vSegments);
  const triangles = indices.map((idx) => ({
    idx,
    bounds: triangleBounds(idx.map((i) => positions[i])),
  }));

  const intersections = [];
  for (let i = 0; i < triangles.length; i++) {
    for (let j = i + 1; j < triangles.length; j++) {
      const a = triangles[i];
      const b = triangles[j];
      if (!boundsOverlap(a.bounds, b.bounds)) continue;
      if (trianglesIntersect(positions, a.idx, b.idx)) {
        intersections.push({ triangles: [i, j], indices: [a.idx, b.idx] });
      }
    }
  }

  return {
    selfIntersectionCount: intersections.length,
    intersectionCount: intersections.length,
    sampledTriangles: triangles.length,
    uSegments,
    vSegments,
    intersections: options.includePairs ? intersections.slice(0, options.maxPairs ?? 50) : undefined,
  };
}

export const countSolidSelfIntersections = countSurfaceSelfIntersections;

export function sampleAssemblyLine(surface, anchorU, segments = 72) {
  return Array.from({ length: segments + 1 }, (_, i) => surface.point(anchorU, i / segments));
}

export function compareAssemblyLines(lineA, lineB) {
  const n = Math.min(lineA.length, lineB.length);
  let maxDrift = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = V.dist(lineA[i], lineB[i]);
    maxDrift = Math.max(maxDrift, d);
    sumSq += d * d;
  }
  return {
    maxDrift,
    rmsDrift: Math.sqrt(sumSq / Math.max(1, n)),
    samples: n,
  };
}

export function polylineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += V.dist(points[i - 1], points[i]);
  return length;
}
