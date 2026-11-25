import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { V } from './core/vec.js';
import { PRESETS, getPreset, makeSection } from './core/presets.js';
import { validateTopology } from './core/topology.js';
import { solveAlignment, prepareSectionGeometry, getMarkArc } from './core/alignment.js';
import { buildUnwrapLayout, createRegistrationTexture } from './core/unwrap.js';
import {
  buildLoftSurface,
  checkContinuity,
  measureInterpolation,
  tessellateSurface,
  meshToObj,
  surfaceToJSON,
} from './core/surface.js';

const state = {
  presetId: 'circle-ellipse',
  presetOptions: {},
  sections: [],
  topology: null,
  alignment: null,
  candidateId: 'locked',
  surface: null,
  candidate: null,
  unwrap: null,
  metrics: null,
  continuity: null,
  settings: {
    uCount: 96,
    smoothU: 0,
    smoothV: 0,
    lineCount: 12,
    texture: true,
    lines: true,
    normals: false,
    wire: false,
  },
};

const els = {
  presetSelect: document.getElementById('preset-select'),
  presetDescription: document.getElementById('preset-description'),
  sectionOrder: document.getElementById('section-order'),
  reverseOrder: document.getElementById('reverse-order'),
  insertSymmetric: document.getElementById('insert-symmetric'),
  candidateList: document.getElementById('candidate-list'),
  decisionReason: document.getElementById('decision-reason'),
  uCount: document.getElementById('u-count'),
  uCountValue: document.getElementById('u-count-value'),
  smoothU: document.getElementById('smooth-u'),
  smoothUValue: document.getElementById('smooth-u-value'),
  smoothV: document.getElementById('smooth-v'),
  smoothVValue: document.getElementById('smooth-v-value'),
  lineCount: document.getElementById('line-count'),
  lineCountValue: document.getElementById('line-count-value'),
  showTexture: document.getElementById('show-texture'),
  showLines: document.getElementById('show-lines'),
  showNormals: document.getElementById('show-normals'),
  showWire: document.getElementById('show-wire'),
  exportObj: document.getElementById('export-obj'),
  exportJson: document.getElementById('export-json'),
  statusPill: document.getElementById('status-pill'),
  viewerMessage: document.getElementById('viewer-message'),
  badges: document.getElementById('viewer-badges'),
  unwrapCanvas: document.getElementById('unwrap-canvas'),
  unwrapFeedback: document.getElementById('unwrap-feedback'),
  metrics: document.getElementById('metrics'),
  compatBody: document.querySelector('#compatibility-table tbody'),
  alignmentJson: document.getElementById('alignment-json'),
};

for (const [id, preset] of Object.entries(PRESETS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = preset.label;
  els.presetSelect.appendChild(opt);
}
els.presetSelect.value = state.presetId;

const container = document.getElementById('three-container');
const textureCanvas = createRegistrationTexture();
let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let modelGroup = null;
let registrationTexture = null;
let threeReady = false;

try {
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1220);
  camera = new THREE.PerspectiveCamera(45, (container.clientWidth || 800) / (container.clientHeight || 600), 0.1, 100);
  camera.position.set(5.4, 3.6, 6.4);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0.1, 0);

  scene.add(new THREE.HemisphereLight(0xe0f2fe, 0x0f172a, 1.65));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(5, 8, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x93c5fd, 1.1);
  rim.position.set(-6, 3, -5);
  scene.add(rim);

  const grid = new THREE.GridHelper(11, 22, 0x64748b, 0x1e293b);
  grid.position.y = -3.15;
  scene.add(grid);

  modelGroup = new THREE.Group();
  modelGroup.rotation.x = -Math.PI / 2;
  scene.add(modelGroup);

  registrationTexture = new THREE.CanvasTexture(textureCanvas);
  registrationTexture.colorSpace = THREE.SRGBColorSpace;
  registrationTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const resizeRenderer = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  new ResizeObserver(resizeRenderer).observe(container);

  const animate = () => {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();
  threeReady = true;
} catch (error) {
  console.error('WebGL initialization failed:', error);
  const fallback = document.createElement('div');
  fallback.style.cssText = 'position:absolute;inset:24px;display:flex;align-items:center;justify-content:center;text-align:center;color:#fde68a;background:rgba(69,26,3,.9);border:1px solid #f59e0b;border-radius:14px;padding:24px;line-height:1.7';
  fallback.textContent = `WebGL 视图初始化失败；对齐、UV、检验与模型导出仍可使用。\n${error?.message ?? error}`;
  fallback.style.whiteSpace = 'pre-wrap';
  container.appendChild(fallback);
}

function loadPreset(id) {
  const preset = getPreset(id);
  state.presetId = preset.id;
  state.presetOptions = { ...preset.options };
  state.sections = preset.sections;
  state.candidateId = 'locked';
  els.presetDescription.textContent = preset.description;
  rebuildAlignment();
}

function rebuildAlignment() {
  state.topology = validateTopology(state.sections);
  if (!state.topology.ok) {
    state.alignment = null;
    state.surface = null;
    state.candidate = null;
    state.unwrap = null;
    state.metrics = null;
    state.continuity = null;
    renderAll();
    return;
  }

  state.alignment = solveAlignment(state.sections, state.presetOptions);
  if (!state.alignment.candidates.some((c) => c.id === state.candidateId)) {
    state.candidateId = state.alignment.recommendedId;
  }
  rebuildSurface();
  renderAll();
}

function rebuildSurface() {
  if (!state.alignment) return;
  state.candidate = state.alignment.candidates.find((c) => c.id === state.candidateId)
    ?? state.alignment.candidates.find((c) => c.recommended);
  state.surface = buildLoftSurface(state.sections, state.alignment, {
    candidateId: state.candidate.id,
    uControlCount: state.settings.uCount,
    transverseSmoothing: state.settings.smoothU / 100,
    longitudinalSmoothing: state.settings.smoothV / 100,
  });
  state.unwrap = buildUnwrapLayout(state.surface, state.sections, state.alignment, state.candidate);
  state.metrics = measureInterpolation(state.surface, state.sections, state.alignment, state.candidate, {
    uSamples: 180,
    tolerance: 0.003,
  });
  state.continuity = checkContinuity(state.surface);
}

function renderAll() {
  renderOrder();
  renderCandidates();
  renderScene();
  drawUnwrap();
  renderMetrics();
  renderCompatibility();
  renderJson();
  renderStatus();
}

function renderStatus() {
  if (!state.topology?.ok) {
    els.statusPill.textContent = '已拒绝：拓扑/顺序';
    els.statusPill.className = 'pill bad';
    els.viewerMessage.className = 'viewer-message show';
    els.viewerMessage.textContent = state.topology.errors.map((e) => `[${e.code}] ${e.message}`).join('\n\n');
    els.badges.innerHTML = '<span class="badge error">NO SURFACE · 未生成任意连接</span>';
    return;
  }
  els.viewerMessage.className = 'viewer-message';
  els.viewerMessage.textContent = '';
  const feedback = state.unwrap?.feedback;
  els.statusPill.textContent = feedback?.usable ? '求解完成 · 记号支可用' : '求解完成 · 请换对齐支';
  els.statusPill.className = `pill ${feedback?.usable ? 'ok' : 'bad'}`;

  const badges = [];
  badges.push(`<span class="badge">${state.surface.kind}</span>`);
  if (state.metrics?.pass) badges.push('<span class="badge good">截面插值通过</span>');
  else badges.push('<span class="badge warn">光顺近似已偏离源截面</span>');
  if (state.continuity?.c1Pass && state.continuity?.c2Pass) badges.push('<span class="badge good">C1/C2 连续</span>');
  if (feedback) badges.push(`<span class="badge ${feedback.usable ? 'good' : 'error'}">UV ${feedback.maxMarkError.toFixed(3)}</span>`);
  for (const warning of state.topology.warnings ?? []) {
    badges.push(`<span class="badge warn" title="${warning.message}">多环提示</span>`);
  }
  els.badges.innerHTML = badges.join('');
}

function renderOrder() {
  els.sectionOrder.innerHTML = '';
  state.sections.forEach((s, i) => {
    const li = document.createElement('li');
    const z = typeof s.z === 'number' ? `z=${s.z.toFixed(2)}` : '';
    li.innerHTML = `
      <span class="index">${i + 1}</span>
      <span>${s.id}<br><span class="meta">${z}${s.symmetryOrder ? ` · ${s.symmetryOrder}重对称` : ''}</span></span>
      <button class="icon-btn up" title="上移" type="button">↑</button>
      <button class="icon-btn down" title="下移" type="button">↓</button>
    `;
    li.querySelector('.up').addEventListener('click', () => moveSection(i, -1));
    li.querySelector('.down').addEventListener('click', () => moveSection(i, 1));
    els.sectionOrder.appendChild(li);
  });
}

function moveSection(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.sections.length) return;
  const [item] = state.sections.splice(index, 1);
  state.sections.splice(target, 0, item);
  rebuildAlignment();
}

function renderCandidates() {
  els.candidateList.innerHTML = '';
  if (!state.alignment) {
    els.decisionReason.textContent = state.topology?.errors.map((e) => e.message).join(' ') ?? '';
    return;
  }

  for (const c of state.alignment.candidates) {
    const label = document.createElement('label');
    label.className = `candidate ${state.candidateId === c.id ? 'active' : ''} ${c.usable ? '' : 'bad'}`;
    label.innerHTML = `
      <span class="line1">
        <input type="radio" name="candidate" value="${c.id}" ${state.candidateId === c.id ? 'checked' : ''} />
        <span>${c.label}</span>
        <span class="tag ${c.usable ? 'ok' : 'no'}">${c.usable ? '记号可用' : '记号冲突'}</span>
        ${c.recommended ? '<span class="tag rec">推荐</span>' : ''}
      </span>
      <span class="scores">
        <span>锁点偏差 max：${c.scores.lockError.toFixed(3)}</span>
        <span>RMS：${c.scores.lockRms.toFixed(3)}</span>
        <span>扭转指标：${c.scores.twist.toFixed(3)}</span>
        <span>几何误差：${c.scores.geometric.toFixed(3)}</span>
      </span>
    `;
    label.querySelector('input').addEventListener('change', () => {
      state.candidateId = c.id;
      rebuildSurface();
      renderAll();
    });
    els.candidateList.appendChild(label);
  }

  const selected = state.candidate;
  if (selected?.decisionReason) {
    els.decisionReason.textContent = selected.decisionReason;
  } else {
    const rec = state.alignment.candidates.find((c) => c.recommended);
    els.decisionReason.textContent = `正在手动预览 ${selected?.id}。推荐支为 ${rec?.id}：${rec?.decisionReason ?? ''}`;
  }
  const topologyWarning = state.topology?.warnings?.map((w) => w.message).join(' ');
  if (topologyWarning) els.decisionReason.textContent += ` 拓扑提示：${topologyWarning}`;
}

function clearModelGroup() {
  while (modelGroup.children.length) {
    const child = modelGroup.children[0];
    modelGroup.remove(child);
    child.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
  }
}

function toThreePoint(p) {
  return new THREE.Vector3(p[0], p[1], p[2]);
}

function addLine(points, color, opacity = 1) {
  const geo = new THREE.BufferGeometry().setFromPoints(points.map(toThreePoint));
  const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const line = new THREE.Line(geo, mat);
  modelGroup.add(line);
  return line;
}

function renderScene() {
  if (!threeReady) return;
  clearModelGroup();
  if (!state.surface || !state.candidate) return;

  const meshData = tessellateSurface(state.surface, { uSegments: 160, vSegments: 72 });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(meshData.positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(meshData.uvs, 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(meshData.normals, 3));
  geometry.setIndex(meshData.indices);
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    map: state.settings.texture ? registrationTexture : null,
    color: state.settings.texture ? 0xffffff : 0x67e8f9,
    roughness: 0.58,
    metalness: 0.08,
    side: THREE.DoubleSide,
    wireframe: state.settings.wire,
  });
  const mesh = new THREE.Mesh(geometry, material);
  modelGroup.add(mesh);

  const ordered = state.alignment.orderedIds.map((id) => state.sections.find((s) => s.id === id));
  const mappings = state.candidate.mappings;

  ordered.forEach((section) => {
    const m = mappings.find((x) => x.sectionId === section.id);
    const pts = [];
    for (let j = 0; j < 192; j++) {
      const u = j / 192;
      const a = ((m.offset + m.orientation * u) % 1 + 1) % 1;
      pts.push(m.arc.pointAt(a));
    }
    const loop = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts.map(toThreePoint)),
      new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.95 }),
    );
    modelGroup.add(loop);
  });

  if (state.settings.lines) {
    const count = state.settings.lineCount;
    for (let k = 0; k < count; k++) {
      const u = k / count;
      const pts = [];
      for (let i = 0; i <= 90; i++) pts.push(state.surface.point(u, i / 90));
      addLine(pts, 0xfbbf24, 0.48);
    }

    const targetPts = [];
    for (let i = 0; i <= 100; i++) targetPts.push(state.surface.point(state.alignment.anchorU, i / 100));
    addLine(targetPts, 0xef4444, 0.95);

    for (const line of state.unwrap.lines) {
      const pts = [];
      const sorted = line.points;
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i];
        const b = sorted[i + 1];
        for (let q = 0; q <= 14; q++) {
          if (i > 0 && q === 0) continue;
          const t = q / 14;
          const u = a.u + (b.u - a.u) * t;
          const v = a.v + (b.v - a.v) * t;
          pts.push(state.surface.point(u, v));
        }
      }
      if (pts.length > 1) addLine(pts, 0x22c55e, 1);

      for (const mark of line.points) {
        const section = ordered.find((s) => s.id === mark.sectionId);
        const mapping = mappings.find((m) => m.sectionId === mark.sectionId);
        const markObj = section.marks?.find((x) => (x.lineId ?? x.id) === mark.lineId) ?? section.marks?.[0];
        const arc = getMarkArc(section, markObj);
        const pos = mapping.arc.pointAt(arc);
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(0.065, 18, 12),
          new THREE.MeshStandardMaterial({ color: 0x22c55e, emissive: 0x064e3b, roughness: 0.35 }),
        );
        sphere.position.copy(toThreePoint(pos));
        modelGroup.add(sphere);
      }
    }
  }

  if (state.settings.normals) {
    const positions = [];
    for (let i = 0; i <= 12; i++) {
      const v = 0.06 + (0.88 * i) / 12;
      for (let j = 0; j < 28; j++) {
        const u = j / 28;
        const p = state.surface.point(u, v);
        const n = state.surface.normalAt(u, v);
        const q = V.mulAdd(p, 0.24, n);
        positions.push(...p, ...q);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    modelGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xf472b6, transparent: true, opacity: 0.9 })));
  }
}

function drawUnwrap() {
  const canvas = els.unwrapCanvas;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, W, H);

  if (!state.unwrap) {
    ctx.fillStyle = '#991b1b';
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('拓扑或对应顺序不合法：已拒绝展开', W / 2, H / 2 - 18);
    ctx.font = '16px system-ui, sans-serif';
    const msg = state.topology?.errors.map((e) => e.message).join('\n') ?? '';
    wrapCanvasText(ctx, msg, W / 2, H / 2 + 18, W - 90, 24);
    els.unwrapFeedback.className = 'feedback bad';
    els.unwrapFeedback.textContent = msg;
    return;
  }

  ctx.globalAlpha = 0.34;
  ctx.drawImage(textureCanvas, 0, 0, W, H);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = 'rgba(15,23,42,.16)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 20; i++) {
    const x = (i / 20) * W;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let i = 0; i <= 8; i++) {
    const y = (i / 8) * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  const X = (u) => u * W;
  const Y = (v) => (1 - v) * H;

  ctx.strokeStyle = 'rgba(180,83,9,.35)';
  ctx.lineWidth = 1;
  for (const u of state.unwrap.correspondenceU) {
    ctx.beginPath(); ctx.moveTo(X(u), 0); ctx.lineTo(X(u), H); ctx.stroke();
  }

  ctx.strokeStyle = '#0369a1';
  ctx.lineWidth = 2;
  ctx.font = 'bold 13px ui-monospace, monospace';
  ctx.textAlign = 'left';
  for (const s of state.unwrap.sectionLines) {
    const y = Y(s.v);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillStyle = '#0c4a6e';
    ctx.fillText(s.sectionId, 8, y - 5);
  }

  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(X(state.alignment.anchorU), 0);
  ctx.lineTo(X(state.alignment.anchorU), H);
  ctx.stroke();

  for (const line of state.unwrap.lines) {
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 4;
    ctx.beginPath();
    line.points.forEach((p, i) => {
      const x = X(p.u);
      const y = Y(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    for (const p of line.points) {
      ctx.beginPath();
      ctx.arc(X(p.u), Y(p.v), 7, 0, Math.PI * 2);
      ctx.fillStyle = '#16a34a';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'white';
      ctx.stroke();
      ctx.fillStyle = '#14532d';
      ctx.font = 'bold 12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(p.sectionId, X(p.u), Y(p.v) - 13);
    }
  }

  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  const fb = state.unwrap.feedback;
  els.unwrapFeedback.className = `feedback ${fb.usable ? 'good' : fb.halfTurnSuspected ? 'bad' : 'warn'}`;
  els.unwrapFeedback.textContent = fb.message;
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight) {
  const paragraphs = text.split('\n');
  let yy = y;
  ctx.textAlign = 'left';
  for (const paragraph of paragraphs) {
    const chars = [...paragraph];
    let line = '';
    for (const ch of chars) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x - maxWidth / 2, yy);
        line = ch;
        yy += lineHeight;
      } else line = test;
    }
    ctx.fillText(line, x - maxWidth / 2, yy);
    yy += lineHeight + 6;
  }
}

function fmt(x) {
  if (!Number.isFinite(x)) return '—';
  if (Math.abs(x) < 1e-4 && x !== 0) return x.toExponential(2);
  return x.toFixed(5);
}

function passBadge(ok, goodText, badText) {
  return `<span class="${ok ? 'pass' : 'fail'}">${ok ? goodText : badText}</span>`;
}

function renderMetrics() {
  if (!state.metrics || !state.continuity) {
    els.metrics.innerHTML = `
      <span class="k">求解状态</span><span class="v fail">${state.topology?.ok ? '未生成' : '拓扑/顺序拒绝'}</span>
      <span class="k">处理策略</span><span class="v">停止，不补任意连接</span>`;
    return;
  }
  const m = state.metrics;
  const c = state.continuity;
  const u = state.unwrap.feedback;
  els.metrics.innerHTML = `
    <span class="k">源截面最大插值误差</span><span class="v ${m.sourceSectionMaxError < 0.003 ? 'pass' : 'fail'}">${fmt(m.sourceSectionMaxError)}</span>
    <span class="k">配点误差（应为 0）</span><span class="v pass">${fmt(m.collocationMaxError)}</span>
    <span class="k">法线异常 / 总数</span><span class="v">${m.normalBad} / ${m.normalCount}</span>
    <span class="k">C0 最大位置跳变</span><span class="v">${fmt(c.c0MaxJump)} ${passBadge(c.c0Pass, 'PASS', 'CHECK')}</span>
    <span class="k">C1 导数跳变</span><span class="v">${fmt(c.c1DerivativeJump)} ${passBadge(c.c1Pass, 'PASS', 'FAIL')}</span>
    <span class="k">C2 二阶导数跳变</span><span class="v">${fmt(c.c2SecondDerivativeJump)} ${passBadge(c.c2Pass, 'PASS', 'FAIL')}</span>
    <span class="k">UV 记号对锁线偏差</span><span class="v ${u.usable ? 'pass' : 'fail'}">${u.maxMarkError.toFixed(3)} 圈</span>
    <span class="k">UV 记号自身共线偏差</span><span class="v ${u.marksCollinear ? 'pass' : 'fail'}">${(u.maxLineSpread ?? u.maxJump ?? 0).toFixed(3)} 圈</span>
    <span class="k">横向 / 纵向次数</span><span class="v">${state.surface.degreeU} / ${state.surface.degreeV}</span>
  `;
}

function renderCompatibility() {
  els.compatBody.innerHTML = '';
  if (!state.alignment || !state.candidate) return;
  for (const id of state.alignment.orderedIds) {
    const section = state.sections.find((s) => s.id === id);
    const mapping = state.candidate.mappings.find((m) => m.sectionId === id);
    const prep = prepareSectionGeometry(section);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${id}</b></td>
      <td><code>${mapping.sourceDegree ?? '—'}</code></td>
      <td><code>${mapping.sourceKnots ? `len ${mapping.sourceKnots.length}` : 'uniform'}</code></td>
      <td>${prep.orientation > 0 ? 'CCW +' : 'CW −'} → ${mapping.orientation > 0 ? '+' : '−'}</td>
      <td><code>${mapping.offset.toFixed(4)}</code></td>
    `;
    els.compatBody.appendChild(tr);
  }
}

function renderJson() {
  if (!state.unwrap) {
    els.alignmentJson.textContent = JSON.stringify({ rejected: true, errors: state.topology?.errors ?? [] }, null, 2);
    return;
  }
  els.alignmentJson.textContent = JSON.stringify(state.unwrap.alignmentScheme, null, 2);
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

els.presetSelect.addEventListener('change', (e) => loadPreset(e.target.value));
els.reverseOrder.addEventListener('click', () => {
  state.sections.reverse();
  rebuildAlignment();
});
els.insertSymmetric.addEventListener('click', () => {
  const index = Math.floor(state.sections.length / 2);
  const z0 = state.sections[index - 1]?.z ?? -1;
  const z1 = state.sections[index]?.z ?? 1;
  const section = makeSection({
    id: `SYM-${Math.random().toString(36).slice(2, 7)}`,
    name: '插入的对称截面',
    z: (z0 + z1) / 2,
    rx: 1.28,
    ry: 0.68,
    startAngle: 0,
    markAngle: 1.08,
    symmetryOrder: 2,
    cubic: true,
  });
  state.sections.splice(index, 0, section);
  state.presetOptions = {};
  rebuildAlignment();
});

els.uCount.addEventListener('input', (e) => {
  state.settings.uCount = Number(e.target.value);
  els.uCountValue.textContent = e.target.value;
  rebuildSurface();
  renderAll();
});
els.smoothU.addEventListener('input', (e) => {
  state.settings.smoothU = Number(e.target.value);
  els.smoothUValue.textContent = `${e.target.value}%`;
  rebuildSurface();
  renderAll();
});
els.smoothV.addEventListener('input', (e) => {
  state.settings.smoothV = Number(e.target.value);
  els.smoothVValue.textContent = `${e.target.value}%`;
  rebuildSurface();
  renderAll();
});
els.lineCount.addEventListener('input', (e) => {
  state.settings.lineCount = Number(e.target.value);
  els.lineCountValue.textContent = e.target.value;
  renderScene();
});
for (const [key, el] of [
  ['texture', els.showTexture],
  ['lines', els.showLines],
  ['normals', els.showNormals],
  ['wire', els.showWire],
]) {
  el.addEventListener('change', () => {
    state.settings[key] = el.checked;
    renderScene();
  });
}

els.exportObj.addEventListener('click', () => {
  if (!state.surface) return;
  const mesh = tessellateSurface(state.surface, { uSegments: 220, vSegments: 100 });
  download('multi-section-loft.obj', meshToObj(mesh), 'text/plain');
});
els.exportJson.addEventListener('click', () => {
  if (!state.surface) return;
  download('multi-section-loft.parametric.json', surfaceToJSON(state.surface), 'application/json');
});

loadPreset(state.presetId);
