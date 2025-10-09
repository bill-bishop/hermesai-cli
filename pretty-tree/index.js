#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'coverage']);

function printTree(dir, prefix = '') {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  entries = entries.filter(entry => !IGNORE_DIRS.has(entry.name));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  entries.forEach((entry, idx) => {
    const isLast = idx === entries.length - 1;
    const pointer = isLast ? '└── ' : '├── ';
    console.log(prefix + pointer + entry.name);
    if (entry.isDirectory()) {
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');
      printTree(path.join(dir, entry.name), nextPrefix);
    }
  });
}

const targetPath = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
console.log(path.basename(targetPath));
printTree(targetPath);

//
// Integration notes:
// - Add "bin": { "pretty-tree": "./index.js" } to package.json for CLI usage.
// - Make sure to run `chmod +x index.js` if on Unix/Mac.
// - Usage: `node index.js [optional-path]` or `npx ./index.js [optional-path]`
//