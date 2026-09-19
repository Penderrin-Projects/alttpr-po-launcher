// Compiles native/WinHelper.cs -> native/bin/WinHelper.exe with the .NET Framework compiler that
// ships with Windows. Run by `npm run build` (and CI) so release builds carry a prebuilt helper.
// Same compiler, same flags the launcher has always used at runtime.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const src = path.join(root, 'native', 'WinHelper.cs');
const outDir = path.join(root, 'native', 'bin');
const out = path.join(outDir, 'WinHelper.exe');
fs.mkdirSync(outDir, { recursive: true });

if (process.platform !== 'win32') {
  console.log('[build-helper] not Windows - skipped (the app falls back to compiling at first run)');
  process.exit(0);
}
const csc = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
].find(p => fs.existsSync(p));
if (!csc) {
  console.error('[build-helper] csc.exe (.NET Framework 4) not found - cannot prebuild WinHelper.exe');
  process.exit(1);
}
execFileSync(csc, ['/nologo', '/optimize', '/reference:System.Windows.Forms.dll', `/out:${out}`, src], { stdio: 'inherit' });
console.log(`[build-helper] ${path.relative(root, out)} (${fs.statSync(out).size} bytes)`);
