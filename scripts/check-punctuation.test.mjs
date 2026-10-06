import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, visibleHtml } from './check-punctuation.mjs';

test('comma：「、」「。」を見つける。「，」「．」は通す', () => {
  assert.equal(scanText('a.html', '<p>これは、だめ。</p>', 'comma').length, 1);
  assert.equal(scanText('a.html', '<p>これは，よい．</p>', 'comma').length, 0);
});

test('maru：全角のコンマ・ピリオドを見つける。「、」「。」は通す', () => {
  assert.equal(scanText('a.html', '<p>これは，だめ</p>', 'maru').length, 1);
  assert.equal(scanText('a.html', '<p>これは、よい。</p>', 'maru').length, 0);
});

test('HTML は、本文と属性を見る。script・style・コメントは見ない', () => {
  const html = '<!-- 、。 --><style>/* 、。 */</style><script>const s = "、。";</script><img alt="、。">';
  assert.equal(scanText('a.html', html, 'comma').length, 1); // alt だけ
  assert.ok(!visibleHtml(html).includes('const s'));
});

test('JS・CSS は、コメントでない行だけを見る。punctuation-ok の行は飛ばす', () => {
  const js = '// 、。\n/* 、。\n 、。 */\n * 、。\nconst a = "、。";\nconst b = "、。"; // punctuation-ok';
  const r = scanText('a.js', js, 'comma');
  assert.equal(r.length, 1);
  assert.match(r[0], /a\.js:5/);
});

test('1 つのページで、混ざっていたら、見つける（どちらの決まりでも）', () => {
  const mixed = '<p>できません．画面の自動ロックをオフにしてください。</p>';
  assert.equal(scanText('a.html', mixed, 'comma').length, 1);
  assert.equal(scanText('a.html', mixed, 'maru').length, 1);
});
