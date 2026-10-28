// Builds the tracker (Muffins Tracker 2.0) into tracker/ from the commit pinned in
// tracker-source.json. Run by `npm start`, `npm run build` and CI; does nothing when tracker/
// already holds that commit (`--force` rebuilds anyway).
//
// The source is our fork of KrisDavie/alttptracker: branch `po` = upstream react_rewrite plus a
// few commits of ours (default prize marker, launcher colours, /tracker?last=1). To update:
//   1. rebase `po` onto upstream react_rewrite in the fork and push it
//   2. put the new commit sha in tracker-source.json
// The tracker is built with bun (its lockfile is bun.lock); npm is used as a fallback.
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'tracker-source.json'), 'utf8'));
const outDir = path.join(root, 'tracker');
const stamp = path.join(outDir, 'build-source.txt');
const srcDir = path.join(root, 'build', 'tracker-src');
const force = process.argv.includes('--force');

if (!/^[0-9a-f]{40}$/.test(source.commit)) throw new Error('tracker-source.json: commit must be a full 40-character sha');

if (!force && fs.existsSync(stamp) && fs.existsSync(path.join(outDir, 'index.html'))) {
  const built = fs.readFileSync(stamp, 'utf8').trim().split(/\s+/)[0];
  if (built === source.commit) {
    console.log(`[build-tracker] tracker/ is already ${source.commit.slice(0, 7)} - skipped`);
    process.exit(0);
  }
}

const shell = process.platform === 'win32';
function run(cmd, args, opts = {}) {
  console.log(`[build-tracker] ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
}
function have(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell });
  return !r.error && r.status === 0;
}

// 1. The pinned commit, fetched into build/tracker-src (shallow, just that commit)
fs.rmSync(srcDir, { recursive: true, force: true });
fs.mkdirSync(srcDir, { recursive: true });
run('git', ['init', '-q'], { cwd: srcDir });
run('git', ['fetch', '-q', '--depth', '1', source.repo, source.commit], { cwd: srcDir });
run('git', ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], { cwd: srcDir });

// 2. Install and build
if (have('bun')) {
  run('bun', ['install', '--frozen-lockfile'], { cwd: srcDir });
  run('bun', ['run', 'build'], { cwd: srcDir });
} else {
  console.warn('[build-tracker] bun not found - falling back to npm (versions may drift from bun.lock; install bun for a reproducible build)');
  run('npm', ['install', '--no-package-lock', '--no-audit', '--no-fund'], { cwd: srcDir });
  run('npm', ['run', 'build'], { cwd: srcDir });
}

// 3. Replace tracker/ with the build output
const dist = path.join(srcDir, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('tracker build produced no dist/index.html');
fs.rmSync(outDir, { recursive: true, force: true });
fs.cpSync(dist, outDir, { recursive: true });
fs.writeFileSync(stamp, `${source.commit} ${new Date().toISOString()}\n`);
const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`[build-tracker] tracker/ <- ${source.commit.slice(0, 7)} (${(size(outDir) / 1048576).toFixed(1)} MB)`);
