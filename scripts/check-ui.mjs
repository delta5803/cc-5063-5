import { chromium } from 'playwright';

const url = process.env.UI_URL ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('#status-pill.ok', { timeout: 30000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: '/tmp/loft-default.png', fullPage: false });

await page.click('#insert-symmetric');
await page.waitForSelector('input[value="symmetry-half"]', { timeout: 5000 });
const insertedSectionCount = await page.locator('#section-order li').count();
if (insertedSectionCount !== 6) throw new Error(`Expected 6 ordered sections after insert, got ${insertedSectionCount}`);
await page.check('input[value="symmetry-half"]');
await page.waitForTimeout(500);
const insertedHalfFeedback = await page.textContent('#unwrap-feedback');
if (!/半圈/.test(insertedHalfFeedback)) throw new Error(`Expected inserted symmetric half feedback, got: ${insertedHalfFeedback}`);
await page.screenshot({ path: '/tmp/loft-inserted-half.png' });

await page.selectOption('#preset-select', 'symmetric');
await page.waitForTimeout(700);
await page.waitForSelector('#unwrap-feedback.good');
await page.screenshot({ path: '/tmp/loft-symmetric-locked.png' });

await page.check('input[name="candidate"][value="symmetry-half"]').catch(async () => {
  await page.locator('.candidate', { hasText: '错半圈' }).locator('input').check();
});
await page.waitForTimeout(700);
const halfFeedback = await page.textContent('#unwrap-feedback');
if (!/半圈/.test(halfFeedback)) throw new Error(`Expected half-turn feedback, got: ${halfFeedback}`);
await page.screenshot({ path: '/tmp/loft-symmetric-half.png' });

await page.selectOption('#preset-select', 'topology-hole');
await page.waitForSelector('#viewer-message.show', { timeout: 5000 });
await page.waitForTimeout(300);
const rejectText = await page.textContent('#viewer-message');
if (!/孔洞/.test(rejectText)) throw new Error('Expected hole topology rejection');
await page.screenshot({ path: '/tmp/loft-reject.png' });

await page.selectOption('#preset-select', 'flipped-start');
await page.waitForSelector('#status-pill.ok');
await page.waitForTimeout(500);
const reason = await page.textContent('#decision-reason');
if (!/锁点对齐支/.test(reason)) throw new Error(`Expected lock-switch reason, got: ${reason}`);

console.log(JSON.stringify({ ok: true, insertedSectionCount, halfFeedback, reason, errors }, null, 2));
if (errors.length) process.exitCode = 1;
await browser.close();
