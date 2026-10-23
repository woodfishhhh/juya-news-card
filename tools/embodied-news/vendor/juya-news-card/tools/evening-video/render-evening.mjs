#!/usr/bin/env node
// Optional Node ESM entry point for the Next/React repository toolchain.
// The renderer itself stays an offline Python CLI with explicit Pillow/FFmpeg dependencies.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, 'render_evening.py');
const python = process.env.PYTHON ?? 'python3';
const result = spawnSync(python, [renderer, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) {
  console.error(`Could not launch ${python}: ${result.error.message}`);
  process.exit(127);
}
process.exit(result.status ?? 1);
