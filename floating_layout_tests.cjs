const assert = require('assert');
const layout = require('./electron/floating-layout.cjs');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`❌ ${name}`);
    console.log(`   ${error.message}`);
  }
}

const workArea = { x: 0, y: 0, width: 1200, height: 800 };

test('toolbar attaches below when there is enough space', () => {
  const result = layout.chooseAttachedPosition(
    { x: 500, y: 200, width: 100, height: 24 },
    { width: 420, height: 78 },
    workArea,
    { gap: 6, margin: 8 }
  );
  assert.strictEqual(result.side, 'below');
  assert.strictEqual(result.y, 230);
  assert.strictEqual(result.attached, true);
});

test('toolbar attaches above near bottom edge', () => {
  const result = layout.chooseAttachedPosition(
    { x: 500, y: 735, width: 100, height: 28 },
    { width: 420, height: 78 },
    workArea,
    { gap: 6, margin: 8 }
  );
  assert.strictEqual(result.side, 'above');
  assert.strictEqual(result.y, 651);
  assert.strictEqual(result.attached, true);
});

test('window x is clamped inside work area', () => {
  const result = layout.chooseAttachedPosition(
    { x: 2, y: 200, width: 20, height: 20 },
    { width: 444, height: 292 },
    workArea,
    { gap: 8, margin: 8 }
  );
  assert.strictEqual(result.x, 8);
});

test('oversized card is clamped instead of flying offscreen', () => {
  const result = layout.chooseAttachedPosition(
    { x: 500, y: 360, width: 90, height: 28 },
    { width: 444, height: 760 },
    workArea,
    { gap: 8, margin: 8 }
  );
  assert(result.y >= 8);
  assert(result.y + Math.min(760, 784) <= 792);
});

test('preferred side keeps result card growing upward', () => {
  const small = layout.chooseAttachedPosition(
    { x: 500, y: 680, width: 90, height: 28 },
    { width: 444, height: 240 },
    workArea,
    { gap: 8, margin: 8 }
  );
  const large = layout.chooseAttachedPosition(
    { x: 500, y: 680, width: 90, height: 28 },
    { width: 444, height: 500 },
    workArea,
    { gap: 8, margin: 8, preferredSide: small.side }
  );
  assert.strictEqual(small.side, 'above');
  assert.strictEqual(large.side, 'above');
  assert(large.y < small.y);
});

test('height limit respects preferred side', () => {
  const result = layout.getSideHeightLimit(
    { x: 500, y: 680, width: 90, height: 28 },
    workArea,
    { gap: 8, margin: 8, preferredSide: 'above', minHeight: 220, desiredHeight: 600 }
  );
  assert.strictEqual(result.side, 'above');
  assert.strictEqual(result.limit, 664);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`  ${passed}/${passed + failed} passed`);
console.log(`${'='.repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);
