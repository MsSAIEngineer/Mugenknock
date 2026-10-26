#!/usr/bin/env node
// デザイントークン規約（CLAUDE.md「余白・間隔・サイズの標準」「色」）の違反を数えるチェック。
//
// 既存の違反（2026-10-26 時点で約1,300件）は一度に直すと画面を壊しやすいので、ファイルごとの件数を
// scripts/design-token-baseline.json に記録し、「基準より増えたら失敗」にする（ラチェット方式）。
// 直して減ったら `node scripts/check-design-tokens.mjs --update` で基準を下げる。
//
//   node scripts/check-design-tokens.mjs           # 増えていないか確認（増えたら exit 1）
//   node scripts/check-design-tokens.mjs --update  # 現在の件数を基準として保存
//   node scripts/check-design-tokens.mjs --list src/views/Home.tsx  # そのファイルの違反行を表示
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE = join(ROOT, 'scripts/design-token-baseline.json');
const SCAN_DIRS = ['src/views', 'src/components'];
const SPACING_OK = new Set(['0', '4', '8', '16', '24', '32']);

// 検出ルール。値は style={{ ... }} のインライン指定を想定した正規表現
const RULES = {
  // gap / padding / margin の生px（スケール外）。'8px 12px' のような複数値も1つずつ見る
  spacing: {
    re: /\b(gap|rowGap|columnGap|padding\w*|margin\w*)\s*:\s*('([^']*)'|(\d+))/g,
    bad: m => {
      const raw = m[3] ?? m[4];
      if (raw === undefined || raw.includes('var(') || raw.includes('calc(') || raw.includes('auto') || raw.includes('%')) return false;
      return raw.split(/\s+/).some(v => { const n = v.replace(/px$/, ''); return /^\d+$/.test(n) && !SPACING_OK.has(n); });
    },
  },
  fontSize: { re: /\bfontSize\s*:\s*(\d+)/g, bad: m => Number(m[1]) <= 22 }, // 装飾用の特大サイズは対象外
  borderRadius: { re: /\bborderRadius\s*:\s*('?\d+(px)?'?)(?=[,\s}])/g, bad: () => true },
  hexColor: { re: /'#[0-9a-fA-F]{3,8}'/g, bad: () => true },
};

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

function scan(file) {
  const counts = {};
  const hits = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    for (const [rule, { re, bad }] of Object.entries(RULES)) {
      for (const m of line.matchAll(re)) {
        if (!bad(m)) continue;
        counts[rule] = (counts[rule] ?? 0) + 1;
        hits.push(`${i + 1}: [${rule}] ${m[0]}`);
      }
    }
  });
  return { counts, hits };
}

const files = SCAN_DIRS.flatMap(d => walk(join(ROOT, d))).sort();
const args = process.argv.slice(2);

if (args[0] === '--list') {
  const { hits } = scan(join(ROOT, args[1]));
  console.log(hits.join('\n') || '違反なし');
  process.exit(0);
}

const current = Object.fromEntries(files.map(f => [relative(ROOT, f), scan(f).counts]).filter(([, c]) => Object.keys(c).length));

if (args[0] === '--update') {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  const total = Object.values(current).reduce((a, c) => a + Object.values(c).reduce((x, y) => x + y, 0), 0);
  console.log(`基準を更新しました（${Object.keys(current).length}ファイル・計${total}件）`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const worse = [];
let improved = 0;
for (const [file, counts] of Object.entries(current)) {
  for (const [rule, n] of Object.entries(counts)) {
    const base = baseline[file]?.[rule] ?? 0;
    if (n > base) worse.push(`${file}  ${rule}: ${base} → ${n}（+${n - base}）`);
    if (n < base) improved += base - n;
  }
}
for (const [file, counts] of Object.entries(baseline)) {
  for (const [rule, base] of Object.entries(counts)) if (!current[file]?.[rule]) improved += base;
}

if (worse.length) {
  console.error('デザイントークン規約の違反が増えました（CLAUDE.md「余白・間隔・サイズの標準」「色」）:');
  console.error(worse.map(w => '  ' + w).join('\n'));
  console.error('違反行は `node scripts/check-design-tokens.mjs --list <file>` で確認できます。');
  process.exit(1);
}
console.log(`OK: 違反は基準以下です${improved ? `（基準より ${improved} 件減。--update で基準を下げてください）` : ''}`);
