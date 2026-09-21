#!/usr/bin/env node
/* check-imports.js — verify every named import in renderer ES modules
   actually exists in the target file's exports. Catches load-time
   SyntaxErrors that cause a silent black screen. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'src', 'renderer', 'js');
let failures = 0;

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  // export const/let/function/class NAME  (incl. async fns, generators, multi-declarator)
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  // export { a, b as c }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim(); if (!seg) continue;
      const as = seg.match(/[\w$]+\s+as\s+([\w$]+)/);
      names.add(as ? as[1] : seg.split(/\s/)[0]);
    }
  }
  return names;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(ROOT).filter(f => !f.includes('mock-bridge'));
const cache = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(f), m[3]);
    if (!cache.has(target)) cache.set(target, fs.existsSync(target) ? exportsOf(target) : null);
    const exp = cache.get(target);
    if (exp === null) { console.log(`MISSING FILE: ${m[3]} (imported by ${path.relative(ROOT, f)})`); failures++; continue; }
    const names = [];
    if (m[1]) names.push(m[1]);
    if (m[2]) for (const part of m[2].split(',')) {
      const seg = part.trim(); if (!seg) continue;
      names.push(seg.match(/[\w$]+\s+as\s+([\w$]+)/)?.[1] || seg.split(/\s/)[0]);
    }
    for (const n of names) {
      if (!exp.has(n)) {
        console.log(`BROKEN IMPORT: ${n} from ${path.relative(ROOT, target)} (used by ${path.relative(ROOT, f)})`);
        failures++;
      }
    }
  }
}
console.log(failures ? `\n${failures} broken import(s) FOUND` : 'All named imports resolve OK');
process.exit(failures ? 1 : 0);
