'use strict';
// Explicitly used only for a new migration target, never by read-only verifier.
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto'); const assert = require('node:assert/strict');
function digest(file) {
  const hash = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); const chunk = Buffer.allocUnsafe(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, chunk)) > 0) hash.update(chunk.subarray(0, n)); } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function inspect(root, relative = '', output = []) {
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const rel = path.join(relative, name); const stat = fs.lstatSync(path.join(root, rel));
    assert(!stat.isSymbolicLink(), 'Symlink refused');
    if (stat.isDirectory()) { output.push({ path: rel, type: 'directory', mode: stat.mode & 511, uid: stat.uid, gid: stat.gid }); inspect(root, rel, output); }
    else { assert(stat.isFile(), 'Special file refused'); output.push({ path: rel, type: 'file', size: stat.size, mode: stat.mode & 511, uid: stat.uid, gid: stat.gid, sha256: digest(path.join(root, rel)) }); }
  }
  return output;
}
try {
  const copying = process.argv.includes('--copy-new-target');
  assert(copying || process.argv.includes('--inspect-source'), 'Explicit copy or readonly inspection mode required');
  if (copying) assert.equal(fs.readdirSync('/target').length, 0, 'Target is not empty');
  const options = JSON.parse(fs.readFileSync(0, 'utf8'));
  const reports = {};
  for (const [name, relative] of Object.entries({ db: options.dbSource, configdb: options.configSource })) {
    assert(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.split('/').some(x => !x || x === '.' || x === '..'), 'Invalid source subpath');
    let component = '/source';
    for (const part of relative.split('/')) { component = path.join(component, part); const st = fs.lstatSync(component); assert(st.isDirectory() && !st.isSymbolicLink(), 'Source parent symlink refused'); }
    const source = path.join('/source', relative); const target = path.join('/target', name);
    assert(fs.statSync(source).isDirectory());
    if (name === 'db') assert(fs.statSync(path.join(source, 'WiredTiger')).isFile(), 'Source is not a WiredTiger directory');
    const before = inspect(source);
    if (copying) {
      fs.cpSync(source, target, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true });
      for (const entry of before) {
        const file = path.join(target, entry.path); fs.chmodSync(file, entry.mode); fs.chownSync(file, entry.uid, entry.gid);
      }
      const sourceStat = fs.statSync(source); fs.chmodSync(target, sourceStat.mode & 511); fs.chownSync(target, sourceStat.uid, sourceStat.gid);
      assert.deepEqual(inspect(target), before, 'Copy content/ownership mismatch');
      assert.deepEqual(inspect(source), before, 'Source changed during copy');
    }
    reports[name] = { files: before.filter(x => x.type === 'file').length, bytes: before.reduce((s, x) => s + (x.size || 0), 0),
      manifestSha256: crypto.createHash('sha256').update(JSON.stringify(before)).digest('hex') };
  }
  process.stdout.write(JSON.stringify({ passed: true, readOnly: !copying, sourceUnchanged: true, trees: reports }) + '\n');
} catch (error) { process.stdout.write(JSON.stringify({ passed: false, errorType: error.name, message: 'Copy failed; new target retained for inspection; source was not modified.' }) + '\n'); process.exitCode = 1; }
