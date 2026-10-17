#!/usr/bin/env node
// Installs (symlinks) or removes the llm-wiki Claude skill at ~/.claude/skills/llm-wiki.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'llm-wiki');
const target = path.join(os.homedir(), '.claude', 'skills', 'llm-wiki');
const action = process.argv[2];

function existing() {
  try {
    return fs.lstatSync(target);
  } catch {
    return undefined;
  }
}

if (action === 'install') {
  const st = existing();
  if (st && !st.isSymbolicLink()) {
    console.error(`error: ${target} exists and is not a symlink; move it away first.`);
    process.exit(1);
  }
  if (st) fs.unlinkSync(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, 'dir');
  console.log(`installed: ${target} -> ${source}`);
} else if (action === 'uninstall') {
  const st = existing();
  if (!st) console.log(`nothing to remove at ${target}`);
  else if (!st.isSymbolicLink()) {
    console.error(`error: ${target} is not a symlink created by this script; leaving it.`);
    process.exit(1);
  } else {
    fs.unlinkSync(target);
    console.log(`removed ${target}`);
  }
} else {
  console.error('usage: skill-link.mjs install|uninstall');
  process.exit(1);
}
