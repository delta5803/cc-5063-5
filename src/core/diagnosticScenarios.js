import { V } from './vec.js';
import { makeSection } from './presets.js';
import { ANCHOR_U, prepareSectionGeometry } from './alignment.js';
import { recomputeSectionFrames } from './correspondence.js';

export function createMiddleKnotScenario(kind = 'correspondence') {
  const sections = [
    makeSection({ id: 'K0', z: -2, rx: 0.88, startAngle: 0.12, markAngle: 0.95 }),
    makeSection({ id: 'K1', z: -1, rx: 1.02, startAngle: -0.22, markAngle: 0.95 }),
    makeSection({
      id: 'KNOT',
      z: 0,
      rx: 1.16,
      ry: 0.78,
      startAngle: kind === 'opposite-direction' ? Math.PI + 0.2 : 0.42,
      markAngle: 0.95,
      reverseDirection: kind === 'opposite-direction',
      cubic: true,
    }),
    makeSection({ id: 'K3', z: 1, rx: 1.0, startAngle: 0.24, markAngle: 0.95 }),
    makeSection({ id: 'K4', z: 2, rx: 0.86, startAngle: -0.08, markAngle: 0.95 }),
  ];

  const knot = sections.find((s) => s.id === 'KNOT');
  const prep = prepareSectionGeometry(knot);
  const lockedOffset = prep.markArc - prep.orientation * ANCHOR_U;
  const overrides = {};

  if (kind === 'frame') {
    return {
      id: 'middle-frame-flip',
      label: '中间截面标架翻面后突然打结',
      description: '对应关系保持锁定，只让迟到的旧标架相对当前标架翻面。',
      sections,
      options: {},
      oldFrames: makeFlippedFrameSnapshot(sections, 'KNOT'),
      parameterSnapshot: { scenario: 'middle-frame-flip', flippedSectionId: 'KNOT' },
    };
  }

  if (kind === 'opposite-direction') {
    overrides.KNOT = {
      orientation: 1,
      offset: 0,
      reason: 'opposite-direction-input-connected-as-same-direction',
    };
  } else {
    overrides.KNOT = {
      orientation: prep.orientation,
      offset: (lockedOffset + 0.42 + 1) % 1,
      reason: 'dragged-start-parameter-correspondence',
    };
  }

  return {
    id: kind === 'opposite-direction' ? 'opposite-direction-correspondence' : 'middle-correspondence-knot',
    label: kind === 'opposite-direction' ? '异向截面被按同向直连' : '拖动中间对应后突然打结',
    description: '所有截面均为闭合轮廓；错误集中在 KNOT 的起点、方向或参数对应。',
    sections,
    options: {
      candidateId: 'custom-correspondence',
      correspondenceOverrides: overrides,
    },
    parameterSnapshot: { scenario: kind, correspondenceOverrides: overrides },
  };
}

export function makeFlippedFrameSnapshot(sections, sectionId) {
  const fresh = recomputeSectionFrames(sections);
  return fresh.map((frame) => {
    if (frame.sectionId !== sectionId) return frame;
    return {
      ...frame,
      radialAxis: V.normalize([-frame.radialAxis[0], -frame.radialAxis[1], frame.radialAxis[2]]),
      tangentAxis: V.scale(frame.tangentAxis, -1),
      stale: true,
    };
  });
}

export function createUnevenSpacingScenario() {
  const zs = [-3, -2.86, -0.12, 0.06, 3];
  const sections = zs.map((z, i) => makeSection({
    id: `D${i}`,
    z,
    rx: [0.82, 1.16, 0.72, 1.18, 0.84][i],
    ry: [0.82, 0.74, 1.06, 0.7, 0.84][i],
    cx: [-0.18, 0.26, -0.16, 0.22, -0.04][i],
    cy: [0.04, -0.08, 0.1, -0.06, 0.02][i],
    startAngle: [0.2, -0.42, 0.52, -0.22, 0.12][i],
    markAngle: 0.92,
  }));
  return {
    id: 'closed-uneven-spacing-interpolation',
    label: '闭合截面 + 不均匀间距插值波动',
    description: '对应和锁点正确，但 V 间距悬殊；用于和输入对应错误对照。',
    sections,
    options: {},
    parameterSnapshot: { scenario: 'uneven-spacing', z: zs },
  };
}

export function createStaleUndoScenario() {
  const inserted = makeSection({
    id: 'UNDO-NEW-SECTION',
    z: 0.35,
    rx: 1.18,
    ry: 0.72,
    startAngle: 0.2,
    symmetryOrder: 2,
  });
  const sections = [
    makeSection({ id: 'U0', z: -2, rx: 0.9 }),
    makeSection({ id: 'U1', z: -1, rx: 1.0 }),
    inserted,
    makeSection({ id: 'U3', z: 1, rx: 1.0 }),
    makeSection({ id: 'U4', z: 2, rx: 0.9 }),
  ];
  return {
    id: 'undo-new-section-late-frame',
    label: '撤销新截面后迟到旧标架',
    sections,
    insertedSectionId: inserted.id,
    remainingSections: sections.filter((s) => s.id !== inserted.id),
    lateResult: {
      frame: { sectionId: inserted.id, orientation: 1 },
      dependencies: { sectionIds: sections.map((s) => s.id) },
    },
  };
}
