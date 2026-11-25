import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPreset } from '../src/core/presets.js';
import { solveAlignment } from '../src/core/alignment.js';
import { buildUnwrapLayout } from '../src/core/unwrap.js';
import { buildLoftSurface, tessellateSurface, meshToObj, surfaceToJSON } from '../src/core/surface.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'artifacts');
mkdirSync(outDir, { recursive: true });

const preset = getPreset('circle-ellipse');
const alignment = solveAlignment(preset.sections, preset.options);
const candidate = alignment.candidates.find((c) => c.id === alignment.recommendedId);
const surface = buildLoftSurface(preset.sections, alignment, {
  candidateId: candidate.id,
  uControlCount: 112,
});
const unwrap = buildUnwrapLayout(surface, preset.sections, alignment, candidate);
const mesh = tessellateSurface(surface, { uSegments: 192, vSegments: 84 });

writeFileSync(resolve(outDir, 'circle-ellipse-loft.obj'), meshToObj(mesh, 'circle_ellipse_multisection_loft'));
writeFileSync(resolve(outDir, 'circle-ellipse-loft.parametric.json'), surfaceToJSON(surface));
writeFileSync(resolve(outDir, 'alignment-and-unwrap.json'), JSON.stringify({
  alignment: {
    recommendedId: alignment.recommendedId,
    anchorU: alignment.anchorU,
    candidates: alignment.candidates.map((c) => ({
      id: c.id,
      label: c.label,
      usable: c.usable,
      scores: c.scores,
      mappings: c.mappings.map((m) => ({
        sectionId: m.sectionId,
        offset: m.offset,
        orientation: m.orientation,
        sourceDegree: m.sourceDegree,
        sourceKnotCount: m.sourceKnots?.length ?? null,
      })),
    })),
  },
  unwrap: {
    alignmentScheme: unwrap.alignmentScheme,
    feedback: unwrap.feedback,
    marks: unwrap.marks,
  },
}, null, 2));

console.log(`Exported model to ${outDir}`);
