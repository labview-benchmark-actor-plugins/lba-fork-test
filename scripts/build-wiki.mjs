#!/usr/bin/env node
// Wiki GENERATOR (LBA-REQ-103, ADR-0089): builds the repository wiki as an Obsidian vault from docs/, the single
// source of truth. Dependency-free and deterministic: the same docs/ always produce the same vault, byte for byte.
//
// Usage:
//   node scripts/build-wiki.mjs                -- validate the generated vault (the wiki-vault gate; default)
//   node scripts/build-wiki.mjs --out <dir>    -- write the vault into <dir>, keeping <dir>/.git and pruning stale files
//   node scripts/build-wiki.mjs --check <dir>  -- exit 1 when <dir> (a wiki clone) differs from the generated vault
//
// Vault layout:
//   Home, _Sidebar, the specification notes, and every other docs/ page at the root;
//   requirements/LBA-REQ-NNN, tests/T-NNN, architecture/ADR-NNNN and architecture/ADR-Index;
//   images/ for documentation screenshots; .obsidian/ for the vault settings.
// Links are alias-free [[Note]] wikilinks: Obsidian reads [[Note|alias]] while the GitHub wiki reads [[alias|Note]],
// so only the plain form means the same thing in both.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, posix } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..');
export const REPO_URL = 'https://github.com/svelderrainruiz/labview-benchmark-actor';
export const SOURCE_BRANCH = 'develop';
export const WIKI_CLONE_URL = `${REPO_URL}.wiki.git`;

const SRS = 'docs/requirements/srs.md';
const RTM = 'docs/requirements/rtm.csv';
const TRACE = 'docs/requirements/traceability-matrix.md';
const OVERVIEW = 'docs/architecture/overview.md';
const ADR_DIR = 'docs/architecture/adr';
const ADR_INDEX = 'docs/architecture/adr/README.md';
const TEST_PLAN = 'docs/testing/test-plan.md';

// Fixed note names for the specification set; every other page derives its name from its file name.
const NAME_OVERRIDES = {
  [SRS]: 'Software-Requirements-Specification',
  [TRACE]: 'Requirements-Traceability-Matrix',
  [RTM]: 'Requirements-Traceability-Matrix',
  [OVERVIEW]: 'Architecture-Packet',
  [ADR_INDEX]: 'ADR-Index',
  'docs/information-for-users/plan.md': 'Information-For-Users-Plan',
};
const WORDS = { cm: 'CM', cli: 'CLI', faq: 'FAQ', labview: 'LabVIEW', lvkit: 'LVKit', mcp: 'MCP' };

const SECTIONS = [
  ['information-for-users', 'Information for users'],
  ['release', 'Release'],
  ['cm', 'Process and assurance'],
  ['dod', 'Process and assurance'],
  ['compliance', 'Process and assurance'],
  ['testing', 'Testing'],
  ['benchmarks', 'Benchmarks'],
  ['proposals', 'Proposals'],
];

const ID_RE = /(?<![A-Za-z0-9_\-/.])(LBA-REQ-\d{3}|ADR-\d{4}|T-\d{3})(?![A-Za-z0-9_]|-[A-Za-z0-9])/g;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const LINK_RE = /(!?)\[((?:[^[\]]|\[[^[\]]*\])*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(\s+"[^"]*")?\)/g;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

// ---- small helpers --------------------------------------------------------------------------------------------
function read(rel) {
  return readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}
function walk(rel) {
  const out = [];
  for (const entry of readdirSync(join(repoRoot, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(child));
    else out.push(child);
  }
  return out.sort();
}
function blobUrl(rel) {
  const full = join(repoRoot, rel);
  const kind = existsSync(full) && statSync(full).isDirectory() ? 'tree' : 'blob';
  return `${REPO_URL}/${kind}/${SOURCE_BRANCH}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}
function titleOf(markdown, fallback) {
  const m = markdown.match(/^#\s+(.+?)\s*$/m);
  return (m ? m[1] : fallback)
    .replace(/^labview-benchmark-actor\s+[\u2014-]+\s+/i, '')
    .replace(/\s+[\u2014-]+\s+labview-benchmark-actor(?=\s*(\(|$))/i, '');
}
function deriveName(rel) {
  if (NAME_OVERRIDES[rel]) return NAME_OVERRIDES[rel];
  const adr = posix.basename(rel).match(/^(ADR-\d{4})-.+\.md$/);
  if (adr) return adr[1];
  const base = posix.basename(rel, '.md').replace(/\./g, '-');
  const words = base.split('-').filter(Boolean).map((w) => WORDS[w] ?? (w[0].toUpperCase() + w.slice(1)));
  return (rel.startsWith('docs/proposals/') ? 'Proposal-' : '') + words.join('-');
}
function splitRow(line) {
  const cells = [];
  let cell = '';
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && line[i + 1] === '|') { cell += '\\|'; i += 1; continue; }
    if (line[i] === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += line[i];
  }
  cells.push(cell.trim());
  return cells.slice(1, -1);
}
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQ = false; } } else { field += c; }
    } else if (c === '"') { inQ = true; } else if (c === ',') { row.push(field); field = ''; } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c !== '\r') { field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const kept = rows.filter((r) => r.length > 1 && r.some((x) => x.trim()));
  const header = kept[0].map((h) => h.trim());
  return kept.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}
function cell(text) {
  return String(text).replace(/\|/g, '\\|');
}

// ---- source model ---------------------------------------------------------------------------------------------
export function loadModel() {
  const problems = [];
  const docs = walk('docs');
  const pages = docs.filter((rel) => rel.endsWith('.md') && rel !== TRACE);
  const images = docs.filter((rel) => /\/images\//.test(rel) && /\.(png|jpe?g|gif|svg|webp)$/i.test(rel));

  const srsText = read(SRS);
  const lines = srsText.split('\n');
  const requirements = [];
  const registerRows = new Map();
  const registerAt = lines.findIndex((l) => /^##\s+Requirements \(governed register\)/.test(l));
  const traceAt = lines.findIndex((l) => /^##\s+Traceability \(requirement/.test(l));
  let firstBlock = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^###\s+(LBA-REQ-\d{3}):\s*(.+?)\s*$/);
    if (!m) continue;
    if (firstBlock < 0) firstBlock = i;
    let end = i + 1;
    while (end < lines.length && !/^#{2,3}\s/.test(lines[end])) end += 1;
    const body = lines.slice(i + 1, end);
    while (body.length && /^(\s*|---)$/.test(body[body.length - 1])) body.pop();
    while (body.length && /^\s*$/.test(body[0])) body.shift();
    requirements.push({ id: m[1], title: m[2], body: body.join('\n') });
  }
  if (registerAt < 0 || traceAt < 0 || firstBlock < 0) problems.push('SRS layout changed: register, requirement sections, or traceability section not found');
  const registerEnd = firstBlock < 0 ? lines.length : firstBlock;
  for (const line of lines.slice(Math.max(registerAt, 0), registerEnd)) {
    if (!/^\|\s*LBA-REQ-\d{3}\s*\|/.test(line)) continue;
    const cells = splitRow(line);
    if (cells.length < 5) { problems.push(`SRS register row ${cells[0]} has ${cells.length} cells, expected 5`); continue; }
    const [id, statement, rationale, fit, ...verification] = cells;
    registerRows.set(id, { statement, rationale, fit, verification: verification.join(' | ') });
  }
  const tableAt = lines.findIndex((l, i) => i > registerAt && /^\|\s*ID\s*\|/.test(l));
  const srsParts = {
    intro: lines.slice(0, Math.max(registerAt, 0)).join('\n'),
    registerHeading: lines[registerAt] ?? '## Requirements',
    registerPreamble: lines.slice(registerAt + 1, tableAt > registerAt ? tableAt : registerAt + 1).join('\n'),
    tail: traceAt >= 0 ? lines.slice(traceAt).join('\n') : '',
  };

  const rtm = new Map();
  for (const r of parseCsv(read(RTM))) {
    if (/^LBA-REQ-\d{3}$/.test(r.ReqID || '')) rtm.set(r.ReqID, r);
  }

  const reqView = new Map();
  for (const m of read(OVERVIEW).matchAll(/^###\s+(\d+\.\d+)\s+(.+?)\s+[\u2014-]+\s+addresses\s+(.+?)\s*$/gm)) {
    const label = `\u00a7${m[1]} ${m[2].replace(/\s+view$/i, '')}`;
    for (const rm of m[3].matchAll(/LBA-REQ-\d{3}/g)) if (!reqView.has(rm[0])) reqView.set(rm[0], label);
  }

  const adrs = new Map();
  for (const rel of pages.filter((p) => p.startsWith(`${ADR_DIR}/ADR-`))) adrs.set(deriveName(rel), { rel, traces: [] });
  const reqAdrs = new Map();
  for (const line of read(ADR_INDEX).split('\n')) {
    const idMatch = line.match(/^\|\s*\[(ADR-\d{4})\]/);
    if (!idMatch) continue;
    const cells = splitRow(line);
    const traces = [...new Set([...(cells[cells.length - 1] || '').matchAll(/LBA-REQ-\d{3}/g)].map((x) => x[0]))];
    if (adrs.has(idMatch[1])) adrs.get(idMatch[1]).traces = traces;
    for (const req of traces) {
      if (!reqAdrs.has(req)) reqAdrs.set(req, []);
      reqAdrs.get(req).push(idMatch[1]);
    }
  }

  const tests = [];
  const planLines = read(TEST_PLAN).split('\n');
  const itemsAt = planLines.findIndex((l) => /^##\s+Test items/.test(l));
  for (let i = itemsAt + 1; itemsAt >= 0 && i < planLines.length && !/^##\s/.test(planLines[i]); i += 1) {
    if (!/^\|\s*T-\d{3}\s*\|/.test(planLines[i])) continue;
    const cells = splitRow(planLines[i]);
    if (cells.length < 4) { problems.push(`test plan row ${cells[0]} has ${cells.length} cells, expected 4`); continue; }
    const [id, reqs, level, ...approach] = cells;
    tests.push({ id, requirements: [...reqs.matchAll(/LBA-REQ-\d{3}/g)].map((x) => x[0]), level, approach: approach.join(' | ') });
  }

  return { problems, pages, images, srsParts, requirements, registerRows, rtm, reqView, adrs, reqAdrs, tests };
}

// ---- vault construction ---------------------------------------------------------------------------------------
export function buildVault(model = loadModel()) {
  const files = new Map();
  const noteFor = new Map();
  const notePath = new Map();
  const problems = [...model.problems];
  const register = (name, path) => {
    if (notePath.has(name) && notePath.get(name) !== path) problems.push(`note name collision: ${name}`);
    notePath.set(name, path);
  };

  for (const rel of model.pages) {
    const name = deriveName(rel);
    noteFor.set(rel, name);
    if (rel.startsWith(`${ADR_DIR}/`)) register(name, `architecture/${name}.md`);
    else register(name, `${name}.md`);
  }
  noteFor.set(RTM, NAME_OVERRIDES[RTM]);
  noteFor.set(TRACE, NAME_OVERRIDES[TRACE]);
  register(NAME_OVERRIDES[TRACE], `${NAME_OVERRIDES[TRACE]}.md`);
  for (const r of model.requirements) register(r.id, `requirements/${r.id}.md`);
  for (const t of model.tests) register(t.id, `tests/${t.id}.md`);
  register('Home', 'Home.md');
  register('_Sidebar', '_Sidebar.md');

  const assets = new Map();
  for (const rel of model.images) {
    const dest = `images/${rel.slice(rel.lastIndexOf('/images/') + '/images/'.length)}`;
    if (assets.has(dest)) problems.push(`image name collision: ${dest}`);
    assets.set(dest, rel);
  }

  // Rewrites one markdown source into vault form: relative links become wikilinks (docs pages), GitHub URLs (other
  // repository files), or vault image paths; bare LBA-REQ/ADR/T identifiers become wikilinks. Code is untouched.
  function convert(markdown, srcRel, self) {
    const noteDir = posix.dirname(notePath.get(self) ?? `${self}.md`);
    const out = [];
    let fence = null;
    for (const line of markdown.split('\n')) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        out.push(line);
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && line.trim() === marker[1]) fence = null;
        continue;
      }
      if (marker) { fence = marker[1]; out.push(line); continue; }
      out.push(convertLine(line, srcRel, self, noteDir));
    }
    return out.join('\n');
  }

  function convertLine(line, srcRel, self, noteDir) {
    const saved = [];
    const keep = (text) => { saved.push(text); return `\u0001${saved.length - 1}\u0001`; };
    let s = line.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m) => keep(m));
    s = s.replace(/<!--.*?-->/g, (m) => keep(m));
    s = s.replace(WIKILINK_RE, (m) => keep(m));
    s = s.replace(LINK_RE, (whole, bang, text, target, title = '') => keep(rewriteLink(whole, bang, text, target, title, srcRel, self, noteDir, saved)));
    s = s.replace(/<?https?:\/\/[^\s)>\]]+>?/g, (m) => keep(m));
    // Issue references are relative to a repository; in a wiki they need an explicit URL.
    s = s.replace(/(?<![\w&#/.-])([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#(\d+)\b/g, (m, repo, n) => keep(`[${m}](https://github.com/${repo}/issues/${n})`));
    s = s.replace(/(?<![\w&#/\u0001])#(\d+)\b(?![\w-])/g, (m, n) => keep(`[#${n}](${REPO_URL}/issues/${n})`));
    // A bracketed plain identifier ("[LBA-REQ-044]") would become an ambiguous triple bracket; use parentheses.
    s = s.replace(/\[(LBA-REQ-\d{3}|ADR-\d{4}|T-\d{3})\]/g, (m, id) => (notePath.has(id) && id !== self ? `(${id})` : m));
    s = s.replace(ID_RE, (id, _g, offset, whole) => {
      if (id === self || !notePath.has(id)) return id;
      if (/mprr\s+$/i.test(whole.slice(Math.max(0, offset - 5), offset))) return id;
      return `[[${id}]]`;
    });
    let previous;
    do { previous = s; s = s.replace(/\u0001(\d+)\u0001/g, (_m, i) => saved[Number(i)]); } while (s !== previous);
    return s;
  }

  function rewriteLink(whole, bang, text, target, title, srcRel, self, noteDir, saved) {
    if (!target || target.startsWith('#') || SCHEME_RE.test(target) || target.startsWith('/')) return whole;
    const hash = target.indexOf('#');
    const rawPath = hash >= 0 ? target.slice(0, hash) : target;
    const fragment = hash >= 0 ? target.slice(hash + 1) : '';
    let decoded = rawPath;
    try { decoded = decodeURI(rawPath); } catch { /* keep the raw path */ }
    const resolved = posix.normalize(posix.join(posix.dirname(srcRel), decoded)).replace(/\/$/, '');
    if (resolved.startsWith('..')) return whole;
    if (bang) {
      const asset = [...assets.entries()].find(([, src]) => src === resolved);
      if (asset) return `![${text}](${posix.relative(noteDir, asset[0])}${title})`;
      return `![${text}](${blobUrl(resolved)}?raw=true${title})`;
    }
    let name = noteFor.get(resolved);
    if (name === NAME_OVERRIDES[SRS]) {
      const req = fragment.match(/^lba-req-(\d{3})/i);
      if (req && notePath.has(`LBA-REQ-${req[1]}`)) name = `LBA-REQ-${req[1]}`;
    }
    if (!name) return `[${text}](${blobUrl(resolved)}${fragment ? `#${fragment}` : ''}${title})`;
    const shown = text.replace(/\u0001(\d+)\u0001/g, (_m, i) => saved[Number(i)]);
    const plain = shown.replace(/`/g, '').trim();
    if (name === self) return shown;
    if (plain === name || plain.endsWith('.md') || plain.includes('/') || plain === posix.basename(resolved) || !plain) return `[[${name}]]`;
    return `${text} ([[${name}]])`;
  }

  const footer = (rel) => `\n\n---\n\nGenerated from [${rel}](${blobUrl(rel)}) on \`${SOURCE_BRANCH}\`. Edit the source in the repository, not this page.\n`;
  const put = (name, body) => files.set(notePath.get(name), `${body.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`);
  const withNav = (markdown, nav) => markdown.replace(/^(#\s+.+\n)/, `$1\n${nav}\n`);

  // Requirement notes.
  for (const r of model.requirements) {
    const row = model.registerRows.get(r.id);
    const rtm = model.rtm.get(r.id) || {};
    const decisions = (model.reqAdrs.get(r.id) || []).slice().sort();
    const testIds = [...(rtm.TestID || '').matchAll(/T-\d{3}/g)].map((x) => x[0]);
    const refs = (rtm.CodeRef || '').split(';').map((x) => x.trim()).filter(Boolean);
    const parts = [`# ${r.id}: ${r.title}`, ''];
    if (row) {
      parts.push('## Governed requirement', '',
        `- **Requirement:** ${row.statement}`,
        `- **Rationale:** ${row.rationale}`,
        `- **Fit criterion:** ${row.fit}`,
        `- **Verification:** ${row.verification}`, '');
    }
    parts.push('## Specification', '', r.body, '');
    parts.push('## Traceability', '',
      `- **Specification:** [[Software-Requirements-Specification]]`,
      `- **Status:** ${rtm.Status || 'not in the RTM'} (see [[Requirements-Traceability-Matrix]])`,
      `- **Architecture view:** ${model.reqView.get(r.id) || 'none recorded'} in [[Architecture-Packet]]`,
      `- **Decisions:** ${decisions.length ? decisions.map((d) => `[[${d}]]`).join(', ') : 'none recorded'}`,
      `- **Tests:** ${testIds.length ? testIds.map((t) => `[[${t}]]`).join(', ') : 'none recorded'}`);
    if (rtm.Requirement) parts.push(`- **RTM statement:** ${rtm.Requirement}`);
    if (refs.length) {
      parts.push('- **Code references:**');
      for (const ref of refs) {
        const path = ref.split(/\s+/)[0];
        const known = noteFor.get(path);
        if (known) parts.push(`  - [[${known}]]`);
        else if (existsSync(join(repoRoot, path))) parts.push(`  - [${ref}](${blobUrl(path)})`);
        else parts.push(`  - \`${ref}\``);
      }
    }
    if (rtm.Notes) parts.push('', '### RTM notes', '', rtm.Notes);
    put(r.id, convert(parts.join('\n'), SRS, r.id) + footer(SRS));
  }

  // Test notes.
  for (const t of model.tests) {
    const parts = [`# ${t.id}`, '',
      `- **Verifies:** ${t.requirements.length ? t.requirements.map((id) => `[[${id}]]`).join(', ') : 'no requirement'}`,
      `- **Level:** ${t.level}`,
      '- **Plan:** [[Test-Plan]]; **results:** [[Test-Report]]', '',
      '## Approach', '', t.approach];
    put(t.id, convert(parts.join('\n'), TEST_PLAN, t.id) + footer(TEST_PLAN));
  }

  // Specification set and every other docs page.
  const srsNav = 'Related: [[Requirements-Traceability-Matrix]], [[Architecture-Packet]], [[Test-Plan]], [[Home]].';
  const reqList = model.requirements.map((r) => `- [[${r.id}]]: ${r.title} (${(model.rtm.get(r.id) || {}).Status || 'not in the RTM'})`);
  const srsBody = [withNav(model.srsParts.intro, srsNav), model.srsParts.registerHeading, '', model.srsParts.registerPreamble.trim(), '',
    `Each requirement has its own note with its governed row, acceptance detail, and traceability (${model.requirements.length} requirements):`, '',
    ...reqList, '', model.srsParts.tail].join('\n');
  put(NAME_OVERRIDES[SRS], convert(srsBody, SRS, NAME_OVERRIDES[SRS]) + footer(SRS));

  const rtmRows = model.requirements.map((r) => {
    const rtm = model.rtm.get(r.id) || {};
    const decisions = (model.reqAdrs.get(r.id) || []).slice().sort().map((d) => `[[${d}]]`).join(', ') || '\u2014';
    const tests = [...(rtm.TestID || '').matchAll(/T-\d{3}/g)].map((x) => `[[${x[0]}]]`).join(', ') || '\u2014';
    return `| [[${r.id}]] | ${cell(r.title)} | ${rtm.Status || '\u2014'} | ${cell(model.reqView.get(r.id) || '\u2014')} | ${decisions} | ${tests} |`;
  });
  put(NAME_OVERRIDES[TRACE], [
    '# Requirements Traceability Matrix', '',
    'Related: [[Software-Requirements-Specification]], [[Architecture-Packet]], [[ADR-Index]], [[Test-Plan]], [[Home]].', '',
    'Requirement to architecture view, decisions, and tests, from the same sources as the repository matrix: the SRS,',
    '`rtm.csv`, the architecture description, and the ADR index "Traces to" column.', '',
    '| Requirement | Title | Status | Architecture view | Decisions | Tests |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rtmRows,
  ].join('\n') + footer(RTM));

  for (const rel of model.pages) {
    const name = noteFor.get(rel);
    if (name === NAME_OVERRIDES[SRS]) continue;
    let text = read(rel);
    if (rel === OVERVIEW) text = withNav(text, 'Related: [[ADR-Index]], [[Software-Requirements-Specification]], [[Requirements-Traceability-Matrix]], [[Home]].');
    if (rel === ADR_INDEX) text = withNav(text, 'Related: [[Architecture-Packet]], [[Requirements-Traceability-Matrix]], [[Home]].');
    let body = convert(text, rel, name);
    if (model.adrs.has(name)) {
      const traces = model.adrs.get(name).traces;
      body += `\n\n---\n\n- **Index:** [[ADR-Index]]; **packet:** [[Architecture-Packet]]\n- **Traces to:** ${traces.length ? traces.map((id) => `[[${id}]]`).join(', ') : 'no requirement'}\n`;
    }
    put(name, body + footer(rel));
  }

  // Home and sidebar.
  const groups = new Map();
  for (const rel of model.pages) {
    const name = noteFor.get(rel);
    if (rel.startsWith(`${ADR_DIR}/`) || [SRS, OVERVIEW, TEST_PLAN].includes(rel) || rel === 'docs/testing/test-report.md') continue;
    const folder = rel.split('/')[1];
    const section = (SECTIONS.find(([dir]) => dir === folder) || [null, 'More documentation'])[1];
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(`- [[${name}]]: ${titleOf(read(rel), name)}`);
  }
  const order = [...new Set([...SECTIONS.map(([, s]) => s), 'More documentation'])];
  const home = [
    '# labview-benchmark-actor Wiki', '',
    `The spec-driven documentation of [labview-benchmark-actor](${REPO_URL}), a VS Code extension for benchmarking`,
    'LabVIEW across Codespaces, golden VMs, and a coordination mesh.', '',
    `This wiki is an Obsidian vault. Clone \`${WIKI_CLONE_URL}\` and open the folder in Obsidian`,
    '("Open folder as vault") for the graph, backlink, and outline views. Links are plain `[[Page]]` wikilinks, which',
    'Obsidian and the GitHub wiki both understand.', '',
    `Every page is generated from the repository's \`docs/\` folder on \`${SOURCE_BRANCH}\` by \`scripts/build-wiki.mjs\` and`,
    'published by the `wiki-publish` workflow. Edit `docs/`, not these pages; a change made here is overwritten.', '',
    '## Specifications', '',
    `- [[Software-Requirements-Specification]]: ${model.requirements.length} requirements, one note each under \`requirements/\`.`,
    '- [[Requirements-Traceability-Matrix]]: requirement to architecture view, decisions, and tests.',
    `- [[Architecture-Packet]]: the ISO/IEC/IEEE 42010 architecture description; ${model.adrs.size} decisions in [[ADR-Index]].`,
    `- [[Test-Plan]] and [[Test-Report]]: ${model.tests.length} test items, one note each under \`tests/\`.`,
    '',
  ];
  for (const section of order) {
    if (!groups.has(section)) continue;
    home.push(`## ${section}`, '', ...groups.get(section), '');
  }
  put('Home', home.join('\n'));
  put('_Sidebar', ['**[[Home]]**', '', '- [[Software-Requirements-Specification]]', '- [[Requirements-Traceability-Matrix]]',
    '- [[Architecture-Packet]]', '- [[ADR-Index]]', '- [[Test-Plan]]', '- [[Test-Report]]', '- [[Getting-Started]]', '- [[User-Guide]]'].join('\n'));

  files.set('.obsidian/app.json', `${JSON.stringify({ useMarkdownLinks: false, newLinkFormat: 'shortest' }, null, 2)}\n`);
  files.set('.obsidian/core-plugins.json', `${JSON.stringify(['file-explorer', 'global-search', 'switcher', 'graph', 'backlink', 'outgoing-link', 'page-preview', 'outline'], null, 2)}\n`);
  files.set('.obsidian/graph.json', `${JSON.stringify({ colorGroups: [
    { query: 'path:requirements', color: { a: 1, rgb: 5210103 } },
    { query: 'path:tests', color: { a: 1, rgb: 3381555 } },
    { query: 'path:architecture', color: { a: 1, rgb: 15761536 } },
  ] }, null, 2)}\n`);
  for (const [dest, src] of assets) files.set(dest, readFileSync(join(repoRoot, src)));

  return { files: new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), notePath, problems, model };
}

// ---- validation -----------------------------------------------------------------------------------------------
function maskCode(text) {
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && line.trim() === marker[1]) fence = null;
      out.push('');
      continue;
    }
    if (marker) { fence = marker[1]; out.push(''); continue; }
    out.push(line.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, ''));
  }
  return out.join('\n');
}

export function validateVault({ files, problems = [], model }) {
  const errors = [...problems];
  const notes = new Map();
  for (const [path, content] of files) {
    if (!path.endsWith('.md')) continue;
    const name = posix.basename(path, '.md');
    if (!/^[A-Za-z0-9_-]+$/.test(name)) errors.push(`${path}: page name must use only letters, digits, '-' and '_'`);
    const lower = name.toLowerCase();
    if ([...notes.keys()].some((n) => n.toLowerCase() === lower)) errors.push(`${path}: page name collides with another page`);
    notes.set(name, { path, text: maskCode(String(content)) });
  }
  if (!notes.has('Home')) errors.push('Home.md is missing');
  for (const required of ['.obsidian/app.json', '.obsidian/core-plugins.json']) {
    try { JSON.parse(String(files.get(required))); } catch { errors.push(`${required} is missing or not JSON`); }
  }

  const edges = new Map();
  for (const [name, { path, text }] of notes) {
    const targets = new Set();
    for (const m of text.matchAll(WIKILINK_RE)) {
      const raw = m[1];
      if (raw.includes('|')) { errors.push(`${path}: aliased wikilink [[${raw}]] reads differently in Obsidian and the GitHub wiki`); continue; }
      const target = raw.split('#')[0].trim();
      if (!notes.has(target)) errors.push(`${path}: unresolved wikilink [[${raw}]]`);
      else targets.add(target);
    }
    for (const m of text.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
      const target = m[2];
      if (SCHEME_RE.test(target) || target.startsWith('#')) continue;
      if (m[1]) {
        const asset = posix.normalize(posix.join(posix.dirname(path), target));
        if (!files.has(asset)) errors.push(`${path}: image ${target} is not in the vault`);
      } else {
        errors.push(`${path}: relative link ${target} does not resolve in a wiki; use a [[wikilink]] or a URL`);
      }
    }
    edges.set(name, targets);
  }

  const seen = new Set(['Home']);
  const queue = ['Home'];
  while (queue.length) for (const next of edges.get(queue.shift()) || []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  for (const name of notes.keys()) if (!seen.has(name) && name !== '_Sidebar') errors.push(`${notes.get(name).path}: not reachable from Home`);

  if (model) {
    for (const r of model.requirements) {
      const note = notes.get(r.id);
      if (!note) { errors.push(`requirement ${r.id} has no note`); continue; }
      const links = edges.get(r.id);
      const rtm = model.rtm.get(r.id) || {};
      for (const t of rtm.TestID ? [...rtm.TestID.matchAll(/T-\d{3}/g)].map((x) => x[0]) : []) {
        if (!links.has(t)) errors.push(`${note.path}: does not link its test ${t}`);
      }
      for (const adr of model.reqAdrs.get(r.id) || []) if (!links.has(adr)) errors.push(`${note.path}: does not link its decision ${adr}`);
    }
    for (const t of model.tests) {
      const links = edges.get(t.id) || new Set();
      for (const req of t.requirements) if (!links.has(req)) errors.push(`tests/${t.id}.md: does not link its requirement ${req}`);
    }
  }
  return { ok: errors.length === 0, errors, notes: notes.size, links: [...edges.values()].reduce((n, s) => n + s.size, 0) };
}

function sameBytes(a, b) {
  return Buffer.compare(Buffer.isBuffer(a) ? a : Buffer.from(a), Buffer.isBuffer(b) ? b : Buffer.from(b)) === 0;
}

function negativeControls(vault) {
  const mutate = (fn) => { const files = new Map(vault.files); fn(files); return validateVault({ ...vault, files }); };
  const home = String(vault.files.get('Home.md'));
  const firstReq = vault.model.requirements[0];
  const reqPath = `requirements/${firstReq.id}.md`;
  const firstTest = ((vault.model.rtm.get(firstReq.id) || {}).TestID || '').match(/T-\d{3}/)?.[0];
  const controls = [
    ['orphan note', mutate((f) => f.set('Orphan-Control.md', '# Orphan\n'))],
    ['unresolved wikilink', mutate((f) => f.set('Home.md', `${home}\n[[Missing-Control]]\n`))],
    ['aliased wikilink', mutate((f) => f.set('Home.md', `${home}\n[[Home|alias]]\n`))],
    ['relative markdown link', mutate((f) => f.set('Home.md', `${home}\n[x](srs.md)\n`))],
    ['requirement without its test', mutate((f) => f.set(reqPath, String(f.get(reqPath)).split(`[[${firstTest}]]`).join(firstTest)))],
  ];
  return controls.map(([name, result]) => ({ name, failsClosed: !result.ok }));
}

// ---- CLI ------------------------------------------------------------------------------------------------------
function listTree(dir) {
  const out = [];
  const visit = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (child === '.git') continue;
      if (entry.isDirectory()) visit(child);
      else out.push(child);
    }
  };
  visit('');
  return out.sort();
}

function main(argv) {
  const outAt = argv.indexOf('--out');
  const checkAt = argv.indexOf('--check');
  const vault = buildVault();

  if (outAt >= 0) {
    const dir = resolve(argv[outAt + 1] || '');
    if (!argv[outAt + 1]) throw new Error('--out needs a directory');
    mkdirSync(dir, { recursive: true });
    for (const rel of listTree(dir)) if (!vault.files.has(rel)) rmSync(join(dir, rel));
    for (const [rel, content] of vault.files) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    console.log(`wiki: wrote ${vault.files.size} files to ${dir}`);
    return 0;
  }

  if (checkAt >= 0) {
    const dir = resolve(argv[checkAt + 1] || '');
    if (!argv[checkAt + 1] || !existsSync(dir)) throw new Error('--check needs an existing directory');
    const present = listTree(dir);
    const drift = [];
    for (const rel of present) if (!vault.files.has(rel)) drift.push(`extra: ${rel}`);
    for (const [rel, content] of vault.files) {
      if (!present.includes(rel)) drift.push(`missing: ${rel}`);
      else if (!sameBytes(readFileSync(join(dir, rel)), content)) drift.push(`differs: ${rel}`);
    }
    if (drift.length) {
      console.error(`wiki: DRIFT, ${drift.length} file(s) differ from the generated vault`);
      for (const line of drift.slice(0, 20)) console.error(`  ${line}`);
      console.error('  Run: node scripts/build-wiki.mjs --out <wiki clone>, then commit and push the wiki.');
      return 1;
    }
    console.log(`wiki: current (${vault.files.size} files)`);
    return 0;
  }

  const result = validateVault(vault);
  const again = buildVault();
  const deterministic = again.files.size === vault.files.size
    && [...vault.files].every(([rel, content]) => again.files.has(rel) && sameBytes(again.files.get(rel), content));
  if (!deterministic) result.errors.push('two builds from the same sources differ');
  const controls = negativeControls(vault);
  for (const c of controls) if (!c.failsClosed) result.errors.push(`negative control "${c.name}" was not detected`);
  if (result.errors.length) {
    console.error(`wiki-vault: FAIL, ${result.errors.length} problem(s)`);
    for (const e of result.errors.slice(0, 40)) console.error(`  - ${e}`);
    return 1;
  }
  const m = vault.model;
  console.log(`wiki-vault: PASS, ${result.notes} notes (${m.requirements.length} requirements, ${m.tests.length} tests, ${m.adrs.size} ADRs), `
    + `${result.links} wikilinks, all reachable from Home; deterministic; ${controls.length}/${controls.length} negative controls fail closed`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`wiki: ${error.message}`);
    process.exit(2);
  }
}
