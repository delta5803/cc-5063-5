export const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  mulAdd: (a, s, b) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  norm2: (a) => V.dot(a, a),
  norm: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  lerp: (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  normalize: (a) => {
    const n = Math.hypot(a[0], a[1], a[2]);
    if (n < 1e-12) return [0, 0, 0];
    return [a[0] / n, a[1] / n, a[2] / n];
  },
  centroid(points) {
    if (!points.length) return [0, 0, 0];
    const s = points.reduce((acc, p) => V.add(acc, p), [0, 0, 0]);
    return V.scale(s, 1 / points.length);
  },
};

export function wrap01(x) {
  const n = Number.isFinite(x) ? x : 0;
  return ((n % 1) + 1) % 1;
}

export function circularDistance(a, b) {
  const d = Math.abs(wrap01(a) - wrap01(b));
  return Math.min(d, 1 - d);
}

export function shortestCyclicDelta(from, to) {
  let d = wrap01(to - from);
  if (d > 0.5) d -= 1;
  return d;
}

export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

export function gaussianSolve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...(Array.isArray(b[i]) ? b[i] : [b[i]])]);
  const rhsCount = Array.isArray(b[0]) ? b[0].length : 1;

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) {
      throw new Error(`Singular linear system at column ${col}`);
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];

    const pv = M[col][col];
    for (let c = col; c < n + rhsCount; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (Math.abs(f) < 1e-15) continue;
      for (let c = col; c < n + rhsCount; c++) M[r][c] -= f * M[col][c];
    }
  }

  if (rhsCount === 1) return M.map((row) => row[n]);
  return M.map((row) => row.slice(n));
}
