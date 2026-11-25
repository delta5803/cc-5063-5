import { wrap01, circularDistance } from './vec.js';
import { markCanonicalU, getMarkArc, ANCHOR_U } from './alignment.js';

export function buildUnwrapLayout(surface, sections, alignment, candidate) {
  const ordered = alignment.orderedIds.map((id) => sections.find((s) => s.id === id));
  const mappings = ordered.map((s) => candidate.mappings.find((m) => m.sectionId === s.id));

  const sectionLines = ordered.map((section, i) => ({
    sectionId: section.id,
    v: surface.parametersV[i],
  }));

  const marks = [];
  ordered.forEach((section, i) => {
    const mapping = mappings[i];
    for (const mark of section.marks ?? []) {
      const arc = getMarkArc(section, mark);
      marks.push({
        sectionId: section.id,
        lineId: mark.lineId ?? mark.id,
        label: mark.label ?? mark.lineId ?? 'mark',
        u: markCanonicalU(mapping, arc),
        targetU: mark.canonicalU ?? ANCHOR_U,
        v: surface.parametersV[i],
      });
    }
  });

  const byLine = new Map();
  for (const m of marks) {
    if (!byLine.has(m.lineId)) byLine.set(m.lineId, []);
    byLine.get(m.lineId).push(m);
  }

  const lines = [...byLine.entries()].map(([lineId, pts]) => {
    const sorted = [...pts].sort((a, b) => a.v - b.v);
    const targetU = sorted[0]?.targetU ?? ANCHOR_U;
    const meanAngle = Math.atan2(
      sorted.reduce((sum, p) => sum + Math.sin(p.u * Math.PI * 2), 0),
      sorted.reduce((sum, p) => sum + Math.cos(p.u * Math.PI * 2), 0),
    );
    const meanU = wrap01(meanAngle / (Math.PI * 2));
    const maxTargetError = Math.max(...sorted.map((p) => circularDistance(p.u, targetU)));
    const maxSpread = Math.max(...sorted.map((p) => circularDistance(p.u, meanU)));
    let maxAdjacentJump = 0;
    let seamCrossings = 0;
    for (let i = 1; i < sorted.length; i++) {
      const d = Math.abs(sorted[i].u - sorted[i - 1].u);
      const circular = circularDistance(sorted[i].u, sorted[i - 1].u);
      maxAdjacentJump = Math.max(maxAdjacentJump, circular);
      if (d > 0.5 && circular < d) seamCrossings++;
    }
    return { lineId, points: sorted, targetU, meanU, maxTargetError, maxSpread, maxAdjacentJump, seamCrossings };
  });

  const maxMarkError = lines.length ? Math.max(...lines.map((l) => l.maxTargetError)) : 0;
  const maxJump = lines.length ? Math.max(...lines.map((l) => l.maxAdjacentJump)) : 0;
  const maxLineSpread = lines.length ? Math.max(...lines.map((l) => l.maxSpread)) : 0;
  const alignmentTolerance = alignment.lockTolerance ?? 0.05;
  const marksCollinear = maxLineSpread < alignmentTolerance && maxJump < alignmentTolerance;
  const usable = maxMarkError < alignmentTolerance;
  const halfTurnSuspected = maxMarkError > 0.35 && maxMarkError < 0.65 && marksCollinear;

  return {
    type: 'single-closed-loop-uv-island',
    domain: { u: [0, 1], v: [0, 1] },
    alignmentScheme: {
      candidateId: candidate.id,
      anchorU: alignment.anchorU,
      mappings: candidate.mappings.map((m) => ({
        sectionId: m.sectionId,
        offset: m.offset,
        orientation: m.orientation,
      })),
    },
    sectionLines,
    correspondenceU: Array.from({ length: 12 }, (_, i) => i / 12),
    marks,
    lines,
    feedback: {
      usable,
      marksCollinear,
      maxMarkError,
      maxLineSpread,
      maxJump,
      halfTurnSuspected,
      message: usable
        ? '展开记号全部落在同一条表面线上，并与固定纹理对位锁线重合；纹理支可采用。'
        : halfTurnSuspected
          ? `记号彼此共线（纵向跳动 ${maxJump.toFixed(3)}），但相对固定纹理锁线整体错开约半圈（偏差 ${maxMarkError.toFixed(3)}）；几何可不换，UV/纹理支必须换。`
          : `展开记号未共线（线内偏差 ${maxLineSpread.toFixed(3)}，对锁线偏差 ${maxMarkError.toFixed(3)}）；请检查起点、方向或锁点顺序。`,
    },
  };
}

export function createRegistrationTexture(size = 1024) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = Math.floor(size / 2);
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#f8fafc');
  grad.addColorStop(0.22, '#dbeafe');
  grad.addColorStop(0.44, '#f8fafc');
  grad.addColorStop(0.5, '#fecaca');
  grad.addColorStop(0.56, '#f8fafc');
  grad.addColorStop(0.78, '#dcfce7');
  grad.addColorStop(1, '#f8fafc');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i <= 32; i++) {
    const x = (i / 32) * w;
    ctx.strokeStyle = i % 4 === 0 ? 'rgba(15,23,42,.35)' : 'rgba(15,23,42,.12)';
    ctx.lineWidth = i % 4 === 0 ? 3 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let i = 0; i <= 8; i++) {
    const y = (i / 8) * h;
    ctx.strokeStyle = 'rgba(15,23,42,.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const anchorX = 0.22 * w;
  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(anchorX, 0);
  ctx.lineTo(anchorX, h);
  ctx.stroke();
  ctx.fillStyle = '#991b1b';
  ctx.font = 'bold 54px system-ui, sans-serif';
  ctx.fillText('REGISTRATION LINE', anchorX + 18, 72);

  ctx.font = 'bold 110px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(30,64,175,.72)';
  ctx.fillText('A', w * 0.08, h * 0.63);
  ctx.fillText('B', w * 0.34, h * 0.63);
  ctx.fillText('C', w * 0.60, h * 0.63);
  ctx.fillText('D', w * 0.84, h * 0.63);

  ctx.save();
  ctx.translate(w * 0.5, h * 0.28);
  ctx.fillStyle = '#7c3aed';
  ctx.beginPath();
  ctx.moveTo(0, -58);
  ctx.lineTo(70, 54);
  ctx.lineTo(-70, 54);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'white';
  ctx.font = 'bold 42px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('↑ FRONT', 0, 32);
  ctx.restore();

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 34px ui-monospace, monospace';
  ctx.fillText('UV 0', 18, h - 22);
  ctx.fillText('UV 1 / seam', w - 210, h - 22);
  return canvas;
}
