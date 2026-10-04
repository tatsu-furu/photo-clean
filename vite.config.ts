import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** public/ の中のファイルを、/ から始まる URL の一覧にする（sw.js 自身は除く）。 */
function publicFiles(dir: string, base = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const url = `${base}/${name}`;
    return statSync(full).isDirectory() ? publicFiles(full, url) : [url];
  }).filter((u) => u !== '/sw.js' && u !== '/robots.txt');
}

/** ビルドのあと、sw.js に「先に保存するファイルの一覧」と版を書き込む。 */
function precache(): Plugin {
  return {
    name: 'photo-clean-precache',
    apply: 'build',
    writeBundle(options, bundle) {
      const outDir = options.dir ?? 'dist';
      const pub = publicFiles('public');
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map')).map((f) => `/${f}`);
      const list = ['/', ...new Set([...built.filter((f) => f !== '/index.html'), ...pub])].sort();
      const hash = createHash('sha1');
      for (const f of list) {
        hash.update(f);
        const local = f === '/' ? join(outDir, 'index.html') : join(outDir, f);
        try { hash.update(readFileSync(local)); } catch { /* なければ飛ばす */ }
      }
      const path = join(outDir, 'sw.js');
      const sw = readFileSync(path, 'utf8')
        .replace('__PRECACHE__', JSON.stringify(list))
        .replace('__VERSION__', hash.digest('hex').slice(0, 10));
      writeFileSync(path, sw);
    },
  };
}

export default defineConfig({
  plugins: [precache()],
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
