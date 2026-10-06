// 画面に出る文章の句読点が、そのサイトの決まりにそろっているかを検査する。
//   node scripts/check-punctuation.mjs            （決まりは、下の MODE）
//   node scripts/check-punctuation.mjs --mode=comma|maru [フォルダ ...]
// 決まり：
//   maru  = 「、」「。」だけ（各プロダクトのサイト・アプリ。一般の利用者向け）。全角のコンマ・ピリオド（U+FF0C・U+FF0E）を見つけたら、失敗する
//   comma = 「，」「．」だけ（個人サイトと alt4L のページ。技術者向けの紹介ページ）。「、」「。」を見つけたら、失敗する
// 調べるもの：HTML の本文と属性（<script>・<style>・コメントは除く）、JS・TS・CSS・JSON の、コメントでない行。
// 例外：その行に「punctuation-ok」と書いてあれば、飛ばす（文字そのものを扱うコードなど）。
// どちらかの句読点が、ページの中で、混ざっていることが、いちばん困るので、「文の途中で混ざっていないか」も、あわせて見る。
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_MODE = 'maru'; // このリポジトリの決まり（コピーしたとき、ここだけ変える）
const DEFAULT_ROOTS = ['index.html', 'src', 'public']; // 調べるフォルダ・ファイル
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|dist-demo|downloads)\//;
const EXT = /\.(html?|js|mjs|ts|tsx|css|json)$/i;
const FORBIDDEN = { maru: /[\uFF0C\uFF0E]/, comma: /[、。]/ };
const NAME = { maru: '「、」「。」', comma: '「，」「．」' };

export function visibleHtml(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' '));
}

export function scanText(rel, text, mode) {
  const bad = FORBIDDEN[mode];
  const isHtml = /\.html?$/i.test(rel);
  const lines = (isHtml ? visibleHtml(text) : text).split('\n');
  const out = [];
  let inBlock = false;
  lines.forEach((line, i) => {
    if (!isHtml) {
      const t = line.trim();
      if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
      if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return; }
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('#')) return;
      line = line.replace(/\/\*.*?\*\//g, '');
    }
    if (line.includes('punctuation-ok')) return;
    if (bad.test(line)) out.push(`${rel}:${i + 1}：${NAME[mode]}にそろえてください → ${line.trim().slice(0, 90)}`);
  });
  return out;
}

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? (SKIP_DIR.test(`${relative(base, p)}/`) ? [] : walk(p, base)) : [relative(base, p)];
  });
}

export function scanFiles(root, files, mode) {
  const problems = [];
  for (const rel of files) {
    const norm = rel.split('\\').join('/');
    if (SKIP_DIR.test(norm) || !EXT.test(norm) || /\.min\.|package-lock\.json|\.test\./.test(norm)) continue;
    try {
      if (!statSync(join(root, rel)).isFile()) continue;
      problems.push(...scanText(norm, readFileSync(join(root, rel), 'utf8'), mode));
    } catch { /* 読めないものは、飛ばす */ }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const mode = (args.find((a) => a.startsWith('--mode=')) ?? `--mode=${DEFAULT_MODE}`).split('=')[1];
  if (!FORBIDDEN[mode]) { console.error('--mode は、comma か maru です'); process.exit(2); }
  const roots = args.filter((a) => !a.startsWith('--'));
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo }).toString().split('\0').filter(Boolean);
  } catch { files = walk(repo); }
  const want = (roots.length ? roots : DEFAULT_ROOTS).map((r) => r.replace(/^\.\//, '').replace(/\/$/, ''));
  files = files.filter((f) => want.includes('.') || want.some((r) => f === r || f.startsWith(`${r}/`)));
  const problems = scanFiles(repo, files, mode);
  if (problems.length) {
    console.error(`句読点が、${NAME[mode]}にそろっていません：`);
    for (const p of problems.slice(0, 60)) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`句読点：画面に出る文章は、${NAME[mode]}にそろっています。`);
}
