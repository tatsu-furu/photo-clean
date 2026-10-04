import './style.css';
import { clean, inspect } from './photo';
import { PhotoError, hasLocation, type Mode, type Report } from './types';
import { makeZip } from './zip';

const MAX_FILES = 50;
const MAX_BYTES = 50 * 1024 * 1024;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

interface Cleaned { blob: Blob; url: string; after: Report }
interface Item {
  file: File;
  name: string; // 同じ名前が重ならないようにした保存名
  thumbUrl: string | null;
  report: Report | null;
  problem: string | null;
  cleaned: Cleaned | null;
  el: HTMLLIElement;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} がありません`);
  return el as T;
};

const items: Item[] = [];
const cardsEl = $('cards');
const statusEl = $('status');
const actionsEl = $('actions');
const dropEl = $('drop');
const fileEl = $<HTMLInputElement>('file');
const btnClean = $<HTMLButtonElement>('btn-clean');
const btnZip = $<HTMLButtonElement>('btn-zip');
const btnShare = $<HTMLButtonElement>('btn-share');
let mode: Mode = readMode();
let busy = false;

function readMode(): Mode {
  try { return localStorage.getItem('photo-clean.mode') === 'all' ? 'all' : 'location'; } catch { return 'location'; }
}

// ---------- 小さな部品 ----------
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  el.append(...kids);
  return el;
}

const sizeText = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function uniqueName(name: string): string {
  const used = new Set(items.map((i) => i.name));
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) if (!used.has(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
}

function setStatus(text: string): void {
  statusEl.textContent = text;
}

// ---------- カードの表示 ----------
function facts(r: Report): HTMLElement {
  const rows: Array<[string, Node | string]> = [];
  if (r.gps) {
    const { lat, lon } = r.gps;
    const map = h('a', { href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`, target: '_blank', rel: 'noopener noreferrer' }, '地図で見る');
    rows.push(['撮影場所', h('span', {}, `${lat.toFixed(5)}, ${lon.toFixed(5)}　`, map)]);
  } else if (r.hasGpsIfd || r.gpsInXmp) rows.push(['撮影場所', '位置情報あり（座標は読み取れません）']);
  else rows.push(['撮影場所', 'なし']);
  if (r.dateTime) rows.push(['撮影日時', r.dateTime]);
  const device = [r.make, r.model].filter(Boolean).join(' ');
  if (device) rows.push(['機種', device]);
  if (r.lens) rows.push(['レンズ', r.lens]);
  if (r.software) rows.push(['編集ソフト', r.software]);
  const others = [r.hasXmp && 'XMP', r.hasIptc && 'IPTC', r.hasComment && 'コメント', r.hasMakerNote && 'メーカー独自の情報'].filter(Boolean);
  if (others.length) rows.push(['そのほか', others.join('・')]);
  const dl = h('dl', { class: 'facts' });
  for (const [k, v] of rows) dl.append(h('dt', {}, k), h('dd', {}, v));
  return dl;
}

function render(item: Item): void {
  const { report, problem, cleaned } = item;
  const info = h('div', {});
  info.append(h('p', { class: 'name' }, item.name));
  if (report) info.append(h('p', { class: 'meta' }, `${report.format.toUpperCase()} ・ ${sizeText(item.file.size)}`));
  if (problem) info.append(h('p', { class: 'problem', role: 'alert' }, problem));
  if (report) {
    const badges = h('div', { class: 'badges' });
    if (cleaned) badges.append(h('span', { class: 'badge ok' }, '位置情報：なし（確認ずみ）'), h('span', { class: 'badge' }, `保存サイズ ${sizeText(cleaned.blob.size)}`));
    else badges.append(hasLocation(report) ? h('span', { class: 'badge warn' }, '位置情報あり') : h('span', { class: 'badge' }, '位置情報なし'));
    info.append(badges, facts(cleaned ? cleaned.after : report));
  }

  const thumb = item.thumbUrl ? h('img', { class: 'thumb', src: item.thumbUrl, alt: '' }) : h('div', { class: 'thumb none' }, '表示なし');
  const side = h('div', { class: 'card-side' });
  if (cleaned) side.append(h('a', { class: 'save', href: cleaned.url, download: item.name }, '保存'));
  const remove = h('button', { class: 'icon-btn', type: 'button', ariaLabel: `${item.name} を取り除く` }, '✕');
  remove.addEventListener('click', () => removeItem(item));
  side.append(remove);
  item.el.replaceChildren(thumb, info, side);
}

function refreshActions(): void {
  actionsEl.hidden = items.length === 0;
  const ready = items.filter((i) => i.report && !i.problem?.startsWith('HEIC'));
  btnClean.disabled = busy || ready.length === 0;
  const done = items.filter((i) => i.cleaned);
  btnZip.hidden = done.length < 2;
  btnShare.hidden = !(done.length >= 1 && 'canShare' in navigator && navigator.canShare(toFiles(done)));
}

// ---------- 追加・取り除き ----------
async function addFiles(list: File[]): Promise<void> {
  if (busy) return;
  const room = MAX_FILES - items.length;
  const accepted = list.slice(0, Math.max(0, room));
  if (list.length > accepted.length) setStatus(`一度に扱えるのは ${MAX_FILES} 枚までです。${list.length - accepted.length} 枚は追加していません。`);
  busy = true;
  refreshActions();
  for (const file of accepted) {
    const item: Item = { file, name: uniqueName(file.name || 'photo'), thumbUrl: null, report: null, problem: null, cleaned: null, el: h('li', { class: 'card' }) };
    items.push(item);
    cardsEl.append(item.el);
    if (file.size > MAX_BYTES) item.problem = `大きすぎます（${sizeText(file.size)}）。1 枚 50MB までです。`;
    else {
      try {
        item.report = inspect(new Uint8Array(await file.arrayBuffer()));
        item.thumbUrl = URL.createObjectURL(file);
      } catch (e) {
        item.problem = e instanceof PhotoError ? (e.code === 'heic' ? `HEIC：${e.message}` : e.message) : '読み込めませんでした。';
      }
    }
    render(item);
    await new Promise((r) => setTimeout(r, 0)); // 1枚ずつ。画面を固めない
  }
  busy = false;
  const found = items.filter((i) => i.report && hasLocation(i.report)).length;
  setStatus(items.length === 0 ? '' : found > 0 ? `${found} 枚に位置情報が入っています。「消して保存」を押してください。` : '位置情報が入っている写真はありません。');
  refreshActions();
}

function removeItem(item: Item): void {
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  if (item.cleaned) URL.revokeObjectURL(item.cleaned.url);
  items.splice(items.indexOf(item), 1);
  item.el.remove();
  refreshActions();
}

function clearAll(): void {
  for (const i of [...items]) removeItem(i);
  setStatus('');
}

function discardResults(): void {
  for (const i of items) {
    if (!i.cleaned) continue;
    URL.revokeObjectURL(i.cleaned.url);
    i.cleaned = null;
    if (!i.problem) render(i);
  }
}

// ---------- 消して保存 ----------
async function cleanAll(): Promise<void> {
  if (busy) return;
  busy = true;
  refreshActions();
  const targets = items.filter((i) => i.report);
  let done = 0;
  for (const item of targets) {
    setStatus(`処理しています… ${done + 1} / ${targets.length}`);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const result = clean(new Uint8Array(await item.file.arrayBuffer()), mode);
      if (item.cleaned) URL.revokeObjectURL(item.cleaned.url);
      const blob = new Blob([result.bytes as BlobPart], { type: MIME[result.after.format] });
      item.cleaned = { blob, url: URL.createObjectURL(blob), after: result.after };
      item.problem = null;
      done++;
    } catch (e) {
      item.cleaned = null;
      item.problem = e instanceof PhotoError ? e.message : '処理できませんでした。';
    }
    render(item);
  }
  busy = false;
  setStatus(done > 0 ? `${done} 枚から位置情報を消しました（消えたことを読み直して確認ずみ）。${done === 1 ? '' : '下の「保存」か、まとめて保存を使ってください。'}` : '消せた写真はありません。');
  refreshActions();
  const only = items.filter((i) => i.cleaned);
  if (only.length === 1 && items.length === 1) download(only[0]!.cleaned!.url, only[0]!.name);
}

function download(url: string, name: string): void {
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

function toFiles(list: Item[]): { files: File[] } {
  return { files: list.filter((i) => i.cleaned).map((i) => new File([i.cleaned!.blob], i.name, { type: i.cleaned!.blob.type })) };
}

async function saveZip(): Promise<void> {
  const entries = await Promise.all(items.filter((i) => i.cleaned).map(async (i) => ({ name: i.name, data: new Uint8Array(await i.cleaned!.blob.arrayBuffer()) })));
  const blob = new Blob([makeZip(entries) as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  download(url, 'photos-clean.zip');
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function share(): Promise<void> {
  const data = toFiles(items);
  try { await navigator.share(data); } catch { /* 取りやめたときなど */ }
}

// ---------- つなぐ ----------
btnClean.addEventListener('click', () => void cleanAll());
btnZip.addEventListener('click', () => void saveZip());
btnShare.addEventListener('click', () => void share());
$('btn-clear').addEventListener('click', clearAll);

fileEl.addEventListener('change', () => {
  void addFiles([...(fileEl.files ?? [])]);
  fileEl.value = '';
});

for (const type of ['dragenter', 'dragover']) dropEl.addEventListener(type, (e) => { e.preventDefault(); dropEl.classList.add('over'); });
for (const type of ['dragleave', 'drop']) dropEl.addEventListener(type, () => dropEl.classList.remove('over'));
dropEl.addEventListener('drop', (e) => { e.preventDefault(); void addFiles([...(e.dataTransfer?.files ?? [])]); });
// ドロップ先を外したときに、ブラウザが写真を開いてしまわないように
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => { if (e.target !== dropEl && !dropEl.contains(e.target as Node)) e.preventDefault(); });
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) void addFiles(files);
});

document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => {
  r.checked = r.value === mode;
  r.addEventListener('change', () => {
    if (!r.checked) return;
    mode = r.value === 'all' ? 'all' : 'location';
    try { localStorage.setItem('photo-clean.mode', mode); } catch { /* 保存できなくてもよい */ }
    if (items.some((i) => i.cleaned)) {
      discardResults();
      setStatus('消し方を変えました。もう一度「消して保存」を押してください。');
    }
    refreshActions();
  });
});

refreshActions();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 登録できなくても通常どおり使える */ });
  });
}
