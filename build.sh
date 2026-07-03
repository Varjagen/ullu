#!/usr/bin/env bash
# build.sh — recompile app.js → app.compiled.js for The Plague's Call.
#
# In-browser Babel was removed in v7 (it added ~10MB of dead weight to
# every page load and was painfully slow on cold loads). app.js still
# contains JSX, but it's now compiled ahead-of-time into app.compiled.js,
# which is what the browser actually loads.
#
# Run this after every edit to app.js. The compiled output is what
# GitHub Pages serves.
#
# Requires: Node.js 18+ and the @babel/core + @babel/preset-react
# packages on a path npm/node can find. The simplest way:
#
#   npm install --save-dev @babel/core @babel/preset-react
#   ./build.sh
#
# or, with a global install:
#
#   npm install -g @babel/core @babel/preset-react
#   BABEL_PATH=$(npm root -g) ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
BABEL_BASE="${BABEL_PATH:-./node_modules}"
node -e "
const babel = require('${BABEL_BASE}/@babel/core');
const fs = require('fs');
const t0 = Date.now();
const src = fs.readFileSync('./app.js', 'utf8');
const result = babel.transformSync(src, {
  presets: [['${BABEL_BASE}/@babel/preset-react', { runtime: 'classic' }]],
  comments: true,
  compact: false,
});
fs.writeFileSync('./app.compiled.js', result.code);
console.log('built app.compiled.js (' + result.code.length + ' bytes) in ' + (Date.now() - t0) + 'ms');
"
