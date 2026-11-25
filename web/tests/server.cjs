// Starts the real app server for e2e tests and FAILS LOUDLY: a stale process already on the port, an early exit or
// a server that never becomes healthy throws (never continue against whatever else answers on the port).
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..', '..');

exports.startServer = async (port, prefix, webDist = path.join(root, 'web/dist')) => {
  const base = `http://localhost:${port}`;
  let stale = false;
  try { stale = (await fetch(base + '/api/health')).ok; } catch { /* nothing listening: good */ }
  if (stale) throw new Error(`port ${port} already serves /api/health (stale server?); stop it first`);
  const tmp = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), prefix));
  const srv = spawn('node', ['server/src/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), DB_PATH: path.join(tmp, 'app.db'), WEB_DIST: webDist } });
  let log = '', exited = null;
  srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
  srv.on('exit', (c) => { exited = c; });
  for (let i = 0; i < 100; i++) {
    if (exited !== null) throw new Error(`server exited with ${exited}: ${log}`);
    try { if ((await fetch(base + '/api/health')).ok) return { srv, base, tmp, log: () => log }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  srv.kill();
  throw new Error('server never became healthy: ' + log);
};
