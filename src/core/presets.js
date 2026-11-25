import { wrap01 } from './vec.js';
import { createRationalCircleNurbs, curvePoint, angleToCircleParameter } from './curves.js';
import { cyclicInterpolationControls, evalPeriodicSplineRow } from './surface.js';

export function reverseCurveDirection(curve) {
  return {
    ...curve,
    id: `${curve.id ?? 'curve'}-reversed`,
    pointAt(u) {
      if (curve.pointAt) return curve.pointAt(wrap01(-u));
      return curvePoint(curve, wrap01(-u));
    },
  };
}

export function createCubicCompatibilityCurve(sourceCurve, controlCount = 40, id = 'cubic-compatible') {
  const samples = Array.from({ length: controlCount }, (_, i) => curvePoint(sourceCurve, i / controlCount));
  const controls = cyclicInterpolationControls(samples);
  return {
    id,
    type: 'periodic-uniform-cubic',
    degree: 3,
    knots: Array.from({ length: controlCount + 4 }, (_, i) => i - 3),
    periodic: true,
    points: controls,
    closed: true,
    pointAt(u) {
      return evalPeriodicSplineRow(controls, u);
    },
  };
}

export function makeSection(cfg) {
  const id = cfg.id;
  let curve = createRationalCircleNurbs({
    id: `${id}-source`,
    center: [cfg.cx ?? 0, cfg.cy ?? 0, cfg.z ?? 0],
    radiusX: cfg.rx ?? 1,
    radiusY: cfg.ry ?? cfg.rx ?? 1,
    startAngle: cfg.startAngle ?? 0,
  });

  const markAngle = cfg.markAngle ?? Math.PI * 0.62;
  const markRawParameter = angleToCircleParameter(markAngle, cfg.startAngle ?? 0);
  const markPoint = curvePoint(curve, markRawParameter);
  let markParameter = markRawParameter;

  if (cfg.cubic) {
    curve = createCubicCompatibilityCurve(curve, cfg.cubicControls ?? 44, `${id}-degree3-knots`);
    markParameter = undefined;
  }
  if (cfg.reverseDirection) {
    curve = reverseCurveDirection(curve);
    if (markParameter != null) markParameter = wrap01(-markParameter);
  }

  return {
    id,
    name: cfg.name ?? id,
    z: cfg.z ?? 0,
    symmetryOrder: cfg.symmetryOrder,
    curve,
    planeNormal: [0, 0, 1],
    marks: [{
      id: `${id}-hand-mark`,
      lineId: 'primary',
      primary: true,
      label: '手绘对位记号',
      parameter: markParameter,
      point: markParameter == null ? markPoint : undefined,
      canonicalU: 0.22,
    }],
    locks: [{ id: `${id}-lock`, lineId: 'primary', markId: `${id}-hand-mark` }],
  };
}

function circleEllipseSections() {
  return [
    makeSection({ id: 'S0', z: -2.4, rx: 0.82, startAngle: 0.18, markAngle: 1.05 }),
    makeSection({ id: 'S1', z: -1.2, rx: 1.0, startAngle: -0.42, markAngle: 1.05 }),
    makeSection({ id: 'S2', z: 0, rx: 1.28, ry: 0.72, startAngle: 0.57, markAngle: 1.05, cubic: true }),
    makeSection({ id: 'S3', z: 1.2, rx: 1.02, ry: 0.9, startAngle: -0.16, markAngle: 1.05 }),
    makeSection({ id: 'S4', z: 2.4, rx: 0.76, startAngle: 0.36, markAngle: 1.05 }),
  ];
}

function eccentricSections() {
  const centers = [
    [-0.72, 0.05], [-0.34, 0.22], [0.18, -0.08], [0.52, 0.18], [0.12, -0.18],
  ];
  return centers.map(([cx, cy], i) => makeSection({
    id: `E${i}`,
    z: (i - 2) * 1.15,
    cx,
    cy,
    rx: [0.72, 0.92, 1.08, 0.9, 0.7][i],
    startAngle: [0.4, -0.2, 0.72, -0.55, 0.12][i],
    markAngle: 0.0,
  }));
}

function symmetricSections() {
  return [
    makeSection({ id: 'A0', z: -2.2, rx: 0.82, startAngle: 0.1, markAngle: 1.2 }),
    makeSection({ id: 'A1', z: -1.1, rx: 1.0, startAngle: -0.25, markAngle: 1.2 }),
    makeSection({ id: 'SYM', z: 0, rx: 1.34, ry: 0.68, startAngle: 0.0, markAngle: 1.2, symmetryOrder: 2 }),
    makeSection({ id: 'A3', z: 1.1, rx: 0.98, startAngle: 0.31, markAngle: 1.2 }),
    makeSection({ id: 'A4', z: 2.2, rx: 0.78, startAngle: -0.08, markAngle: 1.2 }),
  ];
}

function flippedStartSections() {
  return [
    makeSection({ id: 'F0', z: -2, rx: 0.82, startAngle: 0.1, markAngle: 0.9 }),
    makeSection({ id: 'F1', z: -1, rx: 1.0, startAngle: 0.35, markAngle: 0.9 }),
    makeSection({ id: 'FLIP', z: 0, rx: 1.12, ry: 0.86, startAngle: Math.PI + 0.35, markAngle: 0.9 }),
    makeSection({ id: 'F3', z: 1, rx: 0.96, startAngle: -0.2, markAngle: 0.9 }),
    makeSection({ id: 'F4', z: 2, rx: 0.78, startAngle: 0.28, markAngle: 0.9 }),
  ];
}

function reversedInputSections() {
  const forward = eccentricSections();
  return forward
    .reverse()
    .map((section, i) => {
      const mark = section.marks[0];
      const markPoint = mark.point ?? curvePoint(section.curve, mark.parameter ?? 0);
      return {
        ...section,
        id: `R${i}`,
        curve: reverseCurveDirection(section.curve),
        marks: [{
          ...mark,
          parameter: mark.parameter != null ? wrap01(-mark.parameter) : undefined,
          point: mark.parameter == null ? markPoint : undefined,
        }],
      };
    });
}

function topologyMismatchSections() {
  const outer0 = createRationalCircleNurbs({ id: 'good-outer', center: [0, 0, -1], radiusX: 1 });
  const outer1 = createRationalCircleNurbs({ id: 'bad-outer', center: [0, 0, 1], radiusX: 1.1 });
  const hole = createRationalCircleNurbs({ id: 'unexpected-hole', center: [0.25, 0, 1], radiusX: 0.28 });
  return [
    { id: 'TOPO-OK', curve: outer0, marks: [] },
    {
      id: 'TOPO-HOLE',
      loops: [
        { role: 'outer', curve: outer1 },
        { role: 'hole', curve: hole },
      ],
      marks: [],
    },
  ];
}

function crossingOrderSections() {
  function anchorMark(id, angle) {
    return { id: `mark-${id}`, lineId: id, parameter: angle / (Math.PI * 2), canonicalU: angle / (Math.PI * 2) };
  }
  return [
    {
      id: 'ORDER-0',
      curve: createRationalCircleNurbs({ id: 'order-c0', center: [0, 0, -1], radiusX: 1 }),
      marks: ['A', 'B', 'C', 'D'].map((id, i) => anchorMark(id, i * Math.PI / 2)),
    },
    {
      id: 'ORDER-1',
      curve: createRationalCircleNurbs({ id: 'order-c1', center: [0, 0, 1], radiusX: 1.05 }),
      marks: [
        anchorMark('A', 0),
        anchorMark('C', Math.PI / 2),
        anchorMark('B', Math.PI),
        anchorMark('D', Math.PI * 1.5),
      ],
    },
  ];
}

export const PRESETS = {
  'circle-ellipse': {
    label: '圆 → 椭圆（次数/节点兼容）',
    sections: circleEllipseSections,
    options: {},
    description: '圆、椭圆和一个三次非均匀表示混用；采样后统一为周期三次 B 样条。',
  },
  eccentric: {
    label: '偏心截面',
    sections: eccentricSections,
    options: {},
    description: '圆心沿横向漂移，检查对应线、中段形态与外法线。',
  },
  symmetric: {
    label: '对称截面 / 错半圈',
    sections: symmetricSections,
    options: { symmetricSectionId: 'SYM' },
    description: 'SYM 具有二重对称性；两支几何扭转可打平，展开记号决定半圈支是否可用。',
  },
  'flipped-start': {
    label: '轮廓起点翻转',
    sections: flippedStartSections,
    options: {},
    description: 'FLIP 的数组起点翻转半圈；保留原始支与锁点校正支，由扭转和锁点决定换支。',
  },
  reverse: {
    label: '反向次序 + 反向曲线输入',
    sections: reversedInputSections,
    options: {},
    description: '截面数组反序且曲线方向反向；几何应仅在 v 参数方向上翻转。',
  },
  'topology-hole': {
    label: '拒绝：孔洞数量改变',
    sections: topologyMismatchSections,
    options: {},
    description: '第二截面突然出现孔洞，求解器必须停止并解释。',
  },
  'crossing-order': {
    label: '拒绝：锁点交叉顺序',
    sections: crossingOrderSections,
    options: {},
    description: '对位记号循环顺序不相容，自动连接会产生交叉。',
  },
};

export function getPreset(id) {
  const preset = PRESETS[id] ?? PRESETS['circle-ellipse'];
  return {
    id: PRESETS[id] ? id : 'circle-ellipse',
    label: preset.label,
    description: preset.description,
    sections: preset.sections(),
    options: preset.options ?? {},
  };
}
