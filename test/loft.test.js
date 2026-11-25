import test from 'node:test';
import assert from 'node:assert/strict';

import { V, circularDistance } from '../src/core/vec.js';
import { getPreset } from '../src/core/presets.js';
import { validateTopology } from '../src/core/topology.js';
import { solveAlignment } from '../src/core/alignment.js';
import { buildUnwrapLayout } from '../src/core/unwrap.js';
import {
  buildLoftSurface,
  checkContinuity,
  measureInterpolation,
  tessellateSurface,
  meshToObj,
} from '../src/core/surface.js';

function solved(id, candidateId) {
  const preset = getPreset(id);
  const topology = validateTopology(preset.sections);
  assert.equal(topology.ok, true, topology.errors.map((e) => e.message).join('\n'));
  const alignment = solveAlignment(preset.sections, preset.options);
  const cid = candidateId ?? alignment.recommendedId;
  const candidate = alignment.candidates.find((c) => c.id === cid);
  const surface = buildLoftSurface(preset.sections, alignment, {
    candidateId: cid,
    uControlCount: 72,
  });
  return { preset, topology, alignment, candidate, surface };
}

test('circle-to-ellipse loft passes sections with low interpolation error', () => {
  const { preset, alignment, candidate, surface } = solved('circle-ellipse');
  const metric = measureInterpolation(surface, preset.sections, alignment, candidate, {
    uSamples: 180,
    tolerance: 2e-3,
  });
  assert.ok(metric.pass, JSON.stringify(metric, null, 2));
  assert.ok(metric.sourceSectionMaxError < 2e-3);
  assert.ok(metric.collocationMaxError < 1e-6);

  const continuity = checkContinuity(surface);
  assert.ok(continuity.c0Pass);
  assert.ok(continuity.c1Pass, `C1 jump ${continuity.c1DerivativeJump}`);
  assert.ok(continuity.c2Pass, `C2 jump ${continuity.c2SecondDerivativeJump}`);
});

test('eccentric sections produce finite outward normals and smooth centroid morphology', () => {
  const { surface } = solved('eccentric');
  let minOutward = Infinity;
  for (let i = 0; i <= 12; i++) {
    const v = 0.08 + (0.84 * i) / 12;
    for (let j = 0; j < 72; j++) {
      const u = j / 72;
      const p = surface.point(u, v);
      const n = surface.normalAt(u, v);
      assert.ok(Number.isFinite(n[0]) && Number.isFinite(n[1]) && Number.isFinite(n[2]));
      assert.ok(Math.abs(V.norm(n) - 1) < 1e-6);
      minOutward = Math.min(minOutward, V.dot(n, V.normalize([p[0], p[1], 0])));
    }
  }
  assert.ok(minOutward > 0.25, `normal appears inward: ${minOutward}`);

  const low = surface.point(0, surface.parametersV[1]);
  const high = surface.point(0, surface.parametersV[3]);
  assert.ok(Number.isFinite(V.dist(low, high)));
});

test('inter-section morphology stays continuous and non-inverting', () => {
  for (const id of ['circle-ellipse', 'eccentric']) {
    const { surface } = solved(id);
    const rings = [];
    for (let i = 0; i <= 40; i++) {
      const v = i / 40;
      const pts = Array.from({ length: 144 }, (_, j) => surface.point(j / 144, v));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const centroid = V.centroid(pts);
      rings.push({
        centroid,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      });
    }
    for (const ring of rings) {
      assert.ok(ring.width > 0.8, `${id} produced collapsed width`);
      assert.ok(ring.height > 0.8, `${id} produced collapsed height`);
      assert.ok(Number.isFinite(ring.centroid[0]));
    }
    let maxCenterStep = 0;
    for (let i = 1; i < rings.length; i++) {
      maxCenterStep = Math.max(maxCenterStep, V.dist(rings[i - 1].centroid, rings[i].centroid));
    }
    assert.ok(maxCenterStep < 0.28, `${id} center jump ${maxCenterStep}`);
  }

  const { surface } = solved('circle-ellipse');
  const pts = Array.from({ length: 180 }, (_, j) => surface.point(j / 180, 0.5));
  const width = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
  const height = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
  assert.ok(width > height * 1.12, 'middle ring did not retain ellipse-like morphology');
});

test('reversed section order and curve direction reproduce the same geometric surface', () => {
  const forward = solved('eccentric');
  const reversed = solved('reverse');
  let maxDiff = 0;
  for (let i = 0; i <= 36; i++) {
    const v = i / 36;
    for (let j = 0; j < 72; j++) {
      const u = j / 72;
      maxDiff = Math.max(maxDiff, V.dist(reversed.surface.point(u, v), forward.surface.point(u, 1 - v)));
    }
  }
  assert.ok(maxDiff < 1e-8, `reverse mismatch ${maxDiff}`);
});

test('symmetric half-turn branch is geometrically tied but rejected by unwrapped marks', () => {
  const { preset, alignment } = solved('symmetric');
  const locked = alignment.candidates.find((c) => c.id === 'locked');
  const half = alignment.candidates.find((c) => c.id === 'symmetry-half');
  assert.ok(locked);
  assert.ok(half);
  assert.equal(locked.usable, true);
  assert.equal(half.usable, false);
  assert.ok(Math.abs(half.scores.lockError - 0.5) < 0.02);
  assert.ok(Math.abs(locked.scores.twist - half.scores.twist) < 1e-10);
  assert.ok(Math.abs(locked.scores.geometric - half.scores.geometric) < 1e-10);
  assert.ok(locked.scores.geometryTie && half.scores.geometryTie);

  const surfaceA = buildLoftSurface(preset.sections, alignment, { candidateId: 'locked', uControlCount: 64 });
  const surfaceB = buildLoftSurface(preset.sections, alignment, { candidateId: 'symmetry-half', uControlCount: 64 });
  let uvReparameterizationError = 0;
  for (let iv = 0; iv <= 24; iv++) {
    const v = iv / 24;
    for (let iu = 0; iu < 64; iu++) {
      const u = iu / 64;
      uvReparameterizationError = Math.max(
        uvReparameterizationError,
        V.dist(surfaceB.point(u, v), surfaceA.point((u + 0.5) % 1, v)),
      );
    }
  }
  assert.ok(uvReparameterizationError < 1e-8, `half UV branch changed geometry: ${uvReparameterizationError}`);

  const unwrapA = buildUnwrapLayout(surfaceA, preset.sections, alignment, locked);
  const unwrapB = buildUnwrapLayout(surfaceB, preset.sections, alignment, half);
  assert.equal(unwrapA.feedback.usable, true);
  assert.equal(unwrapB.feedback.usable, false);
  assert.equal(unwrapB.feedback.marksCollinear, true);
  assert.ok(unwrapB.feedback.maxLineSpread < 0.02);
  assert.ok(unwrapB.marks.every((m) => circularDistance(m.u, 0.72) < 1e-8));
  assert.equal(unwrapB.feedback.halfTurnSuspected, true);
  assert.match(unwrapB.feedback.message, /彼此共线[\s\S]*半圈/);
});

test('flipped start preserves raw and corrected candidates and switches using lock error and twist', () => {
  const { alignment } = solved('flipped-start');
  const raw = alignment.candidates.find((c) => c.id === 'raw-index');
  const locked = alignment.candidates.find((c) => c.id === 'locked');
  assert.ok(raw);
  assert.ok(locked);
  assert.equal(alignment.recommendedId, 'locked');
  assert.ok(raw.scores.lockError > 0.2);
  assert.ok(raw.scores.twist > locked.scores.twist * 4);
  assert.ok(locked.scores.lockError < 1e-8);
  assert.match(locked.decisionReason, /换用锁点对齐支/);
});

test('topology changes and crossing anchor order are rejected with explanations', () => {
  const hole = getPreset('topology-hole');
  const holeCheck = validateTopology(hole.sections);
  assert.equal(holeCheck.ok, false);
  assert.ok(holeCheck.errors.some((e) => e.code === 'TOPOLOGY_HOLE_COUNT_MISMATCH'));
  assert.match(holeCheck.errors[0].message, /孔洞\/环数量改变/);
  assert.throws(() => solveAlignment && buildLoftSurface(hole.sections, solveAlignment(hole.sections)), /孔洞/);

  const crossing = getPreset('crossing-order');
  const orderCheck = validateTopology(crossing.sections);
  assert.equal(orderCheck.ok, false);
  assert.ok(orderCheck.errors.some((e) => e.code === 'CORRESPONDENCE_ORDER_CROSSING'));
});

test('smoothing controls change the parametric surface without producing invalid normals', () => {
  const preset = getPreset('circle-ellipse');
  const alignment = solveAlignment(preset.sections, preset.options);
  const base = buildLoftSurface(preset.sections, alignment, { uControlCount: 56 });
  const smoothU = buildLoftSurface(preset.sections, alignment, {
    uControlCount: 56,
    transverseSmoothing: 0.85,
  });
  const smoothV = buildLoftSurface(preset.sections, alignment, {
    uControlCount: 56,
    longitudinalSmoothing: 0.85,
  });

  let du = 0;
  let dv = 0;
  for (let i = 1; i < 24; i++) {
    for (let j = 0; j < 56; j++) {
      const u = j / 56;
      const v = i / 24;
      du = Math.max(du, V.dist(base.point(u, v), smoothU.point(u, v)));
      dv = Math.max(dv, V.dist(base.point(u, v), smoothV.point(u, v)));
      assert.ok(Number.isFinite(smoothV.point(u, v)[0]));
    }
  }
  assert.ok(du > 1e-4, 'transverse smoothing had no visible effect');
  assert.ok(dv > 1e-4, 'longitudinal smoothing had no visible effect');
});

test('surface can be tessellated and exported as a real OBJ and parametric JSON', () => {
  const { surface } = solved('circle-ellipse');
  const mesh = tessellateSurface(surface, { uSegments: 48, vSegments: 24 });
  assert.equal(mesh.positions.length, (48 + 1) * (24 + 1) * 3);
  assert.ok(mesh.indices.length > 0);
  const obj = meshToObj(mesh);
  assert.match(obj, /^o multi_section_loft/m);
  assert.match(obj, /^v /m);
  assert.match(obj, /^f /m);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(surface)));
});
