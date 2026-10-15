// Local database access for the flow suite through the `mysql` client, with the
// credentials of api_john's .env (DATABASE_URL). Nothing here prints them.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function databaseUrl(apiDir) {
  const env = fs.readFileSync(path.join(apiDir, '.env'), 'utf8');
  const line = env.split('\n').find((l) => /^\s*DATABASE_URL\s*=/.test(l));
  if (!line) throw new Error(`No hay DATABASE_URL en ${apiDir}/.env`);
  return line.replace(/^\s*DATABASE_URL\s*=\s*/, '').trim().replace(/^["']|["']$/g, '');
}

function connection(apiDir) {
  const url = new URL(databaseUrl(apiDir));
  return {
    args: ['-u', decodeURIComponent(url.username), '-h', url.hostname, '-P', url.port || '3306', url.pathname.replace(/^\//, ''), '--default-character-set=utf8mb4', '-N', '-B'],
    env: { ...process.env, MYSQL_PWD: decodeURIComponent(url.password) },
  };
}

/** Runs SQL and returns the rows as arrays of strings. */
function makeQuery(apiDir) {
  const conn = connection(apiDir);
  return (sql) => {
    const out = execFileSync('mysql', conn.args, { input: sql, encoding: 'utf8', env: conn.env, stdio: ['pipe', 'pipe', 'pipe'] });
    return out.trim() ? out.trim().split('\n').map((l) => l.split('\t')) : [];
  };
}

module.exports = { makeQuery };
