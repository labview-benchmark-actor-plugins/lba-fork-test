#!/usr/bin/env node
// verify-vsix-links.mjs -- fail closed unless a packaged .vsix advertises only the canonical repository (#56).
//
// WHY: the Marketplace listing and VS Code's extension page show the packaged extension.vsixmanifest
// `Microsoft.VisualStudio.Services.Links.*` properties (Issues comes from Links.Support), not the working-tree
// package.json. VS Code shows those links only from the Marketplace listing, so a reviewer cannot see a stale link
// before publishing: 1.4.14 shipped with Issues pointing at LabVIEW-Community-CI-CD, and nothing caught it. This
// check runs on every `npm run package` (from normalize-vsix.mjs) against the bytes that will be reviewed and
// shipped.
//
// Pure Node (no deps): walks End-of-Central-Directory -> central directory -> local headers and inflates entries.

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const LINK_PREFIX = 'Microsoft.VisualStudio.Services.Links.';
export const REQUIRED_LINKS = ['Source', 'Getstarted', 'GitHub', 'Support', 'Learn'];
export const RETIRED_OWNERS = ['LabVIEW-Community-CI-CD'];
const TEXT_ENTRY = /\.(md|json|js|cjs|mjs|txt|xml|html|css|vsixmanifest)$/i;

/** Read every entry of a zip buffer into a Map of name -> content Buffer (stored or deflated entries only). */
export function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('verify-vsix-links: no End-of-Central-Directory record found (not a zip?)');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < total; n += 1) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error(`verify-vsix-links: bad central-dir signature at offset ${p}`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(lho) !== SIG_LOCAL) throw new Error(`verify-vsix-links: bad local-header signature at offset ${lho}`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(raw));
    else if (method === 8) entries.set(name, inflateRawSync(raw));
    else throw new Error(`verify-vsix-links: unsupported compression method ${method} for ${name}`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const repoKey = (url) => String(url ?? '').trim().replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();

/**
 * Pure check over a packaged manifest. Every Links.* property must name the package.json repository, Links.Support
 * must be its issues page (and equal bugs.url), the five standard links must all be present, and no packaged text
 * may name a retired repository owner.
 */
export function checkVsixLinks({ manifestXml, packageJson, texts = {} } = {}) {
  const findings = [];
  const repo = repoKey(packageJson?.repository?.url ?? packageJson?.repository);
  const issues = `${repo}/issues`;
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo)) findings.push(`package.json repository.url is not a GitHub repository URL: ${repo || '<missing>'}`);
  if (repoKey(packageJson?.bugs?.url) !== issues) findings.push(`package.json bugs.url ${packageJson?.bugs?.url ?? '<missing>'} is not ${issues}`);
  const links = {};
  for (const [, id, value] of String(manifestXml ?? '').matchAll(/<Property\s+Id="([^"]+)"\s+Value="([^"]*)"/g)) {
    if (id.startsWith(LINK_PREFIX)) links[id.slice(LINK_PREFIX.length)] = value;
  }
  for (const key of REQUIRED_LINKS) {
    if (!links[key]) findings.push(`extension.vsixmanifest has no Links.${key}`);
  }
  for (const [key, value] of Object.entries(links)) {
    const link = repoKey(value);
    const ok = key === 'Support'
      ? link === issues
      : link === repo || link.startsWith(`${repo}#`) || link.startsWith(`${repo}/`);
    if (!ok) findings.push(`Links.${key} ${value} does not point to ${key === 'Support' ? issues : repo}`);
  }
  for (const [name, text] of Object.entries(texts)) {
    for (const owner of RETIRED_OWNERS) {
      if (String(text).toLowerCase().includes(owner.toLowerCase())) findings.push(`${name} names the retired owner ${owner}`);
    }
  }
  return { ok: findings.length === 0, links, findings };
}

/** Check a packaged .vsix file on disk. */
export function verifyVsixLinks(path) {
  const entries = readZipEntries(readFileSync(path));
  const manifest = entries.get('extension.vsixmanifest');
  const pkg = entries.get('extension/package.json');
  if (!manifest || !pkg) return { ok: false, links: {}, findings: ['the .vsix has no extension.vsixmanifest or extension/package.json'] };
  const texts = {};
  for (const [name, content] of entries) {
    if (TEXT_ENTRY.test(name)) texts[name] = content.toString('utf8');
  }
  return checkVsixLinks({ manifestXml: manifest.toString('utf8'), packageJson: JSON.parse(pkg.toString('utf8')), texts });
}

export function reportVsixLinks(path) {
  const result = verifyVsixLinks(path);
  if (!result.ok) {
    console.error(`verify-vsix-links: FAIL ${path}`);
    for (const finding of result.findings) console.error(`  - ${finding}`);
    return false;
  }
  console.log(`verify-vsix-links: ${Object.keys(result.links).length} Marketplace links in ${path} point to the canonical repository`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!reportVsixLinks(process.argv[2] || 'labview-benchmark-actor.vsix')) process.exit(1);
}
