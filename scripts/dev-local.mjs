#!/usr/bin/env node
//
// scripts/dev-local.mjs — all of Onyx on this machine: Postgres, an S3 bucket
// and the app, with no cloud account and no mail provider.
//
//   npm run dev:local    first run sets everything up; then Postgres + S3, then `next dev`
//   npm run dev:stop     stop Postgres + S3
//
// Everything lives in .dev/ (gitignored): the Postgres cluster, the bucket,
// and a log for each. Nothing is registered as a service and nothing outside
// the repository is written, so `npm run dev:stop && rm -rf .dev` is a
// complete reset. The two servers come from Homebrew:
//
//   brew install postgresql@17 versitygw
//
// The bucket is versitygw, not MinIO. MinIO's community builds are no longer
// maintained, and its last Homebrew binary segfaults at startup on macOS 27 —
// a cgo CPU probe (shoenig/go-m1cpu) crashes before main() runs. versitygw's
// posix backend also keeps every object as a plain file, so .dev/s3/onyx/ IS
// the bucket, and it opens in Finder.
//
// Sign-in needs no mail provider: with RESEND_API_KEY unset, `next dev` prints
// the magic link to this terminal (printsSignInLinks in lib/signin-email.js).
//
// This only ever runs the app against the database it manages. When the
// DATABASE_URL `next dev` would see points anywhere else — a Supabase project
// left in .env.local, say — it refuses to start rather than put a local
// session on top of real data.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  CreateBucketCommand, HeadBucketCommand, ListBucketsCommand, S3Client,
} from '@aws-sdk/client-s3';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Ports are the defaults with a 5 in front, clear of a Homebrew Postgres on
// 5432, a MinIO on 9000, and the Supabase CLI's 543xx block.
const PG_PORT = 55432;
const S3_PORT = 59000;
const S3_REGION = 'us-east-1';
const BUCKET = 'onyx';
const LOCAL_DATABASE_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/onyx`;
const S3_ENDPOINT = `http://127.0.0.1:${S3_PORT}`;

// Both servers listen on loopback only, so fixed credentials are fine here —
// the same trade every docker-compose file with minioadmin/minioadmin makes.
const S3_ACCESS_KEY = 'onyx-local';
const S3_SECRET_KEY = 'onyx-local-secret';

const DEV = join(root, '.dev');
const PG_DATA = join(DEV, 'postgres');
const S3_DATA = join(DEV, 's3');
const PG_LOG = join(DEV, 'postgres.log');
const S3_LOG = join(DEV, 's3.log');
const ENV_FILE = join(root, '.env.local');

// ── output ───────────────────────────────────────────────────────────────────
const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', bold: '\x1b[1m' };
const paint = (c, s) => (process.stdout.isTTY ? `${c}${s}${C.reset}` : s);
const ok = (label, detail = '') => console.log(`  ${paint(C.green, '✓')} ${label}${detail ? paint(C.dim, `  ${detail}`) : ''}`);
const note = (text) => console.log(`  ${paint(C.dim, `· ${text}`)}`);
const rel = (p) => relative(root, p);

function die(message, detail = '') {
  console.error(`\n  ${paint(C.red, `✗ ${message}`)}${detail ? `\n\n${detail}` : ''}\n`);
  process.exit(1);
}

function tail(file, lines = 15) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).map((l) => `    ${l}`).join('\n');
  } catch {
    return '';
  }
}

// ── tools ────────────────────────────────────────────────────────────────────
// postgresql@17 is keg-only, so its binaries are not on PATH unless someone
// linked them. Look in the keg first, then fall back to whatever PATH has.
const BREW_PREFIXES = ['/opt/homebrew', '/usr/local'];

function findBinary(name, kegs = []) {
  for (const prefix of BREW_PREFIXES) {
    for (const keg of kegs) {
      const candidate = join(prefix, 'opt', keg, 'bin', name);
      if (existsSync(candidate)) return candidate;
    }
    const candidate = join(prefix, 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  const which = spawnSync('which', [name], { encoding: 'utf8' });
  return which.status === 0 ? which.stdout.trim() : null;
}

const findPgCtl = () => findBinary('pg_ctl', ['postgresql@17']);

function requireTools() {
  const pgCtl = findPgCtl();
  const initdb = pgCtl && join(dirname(pgCtl), 'initdb');
  const vgw = findBinary('versitygw');
  const missing = [];
  if (!pgCtl || !existsSync(initdb)) missing.push('postgresql@17');
  if (!vgw) missing.push('versitygw');
  if (missing.length) die('Missing tools. Install them with:', `    brew install ${missing.join(' ')}`);
  return { pgCtl, initdb, vgw };
}

function run(cmd, args, label, log) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    die(`${label} failed.`, [r.stdout, r.stderr, log && `${rel(log)}:\n${tail(log)}`].filter(Boolean).join('\n').trimEnd());
  }
  return r.stdout;
}

// ── .env.local ───────────────────────────────────────────────────────────────
// Same parser as scripts/doctor.mjs, so the two agree about what a file says.
function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let [, key, value] = m;
    value = value.trim().replace(/\s+#.*$/, '');
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Replace KEY=… lines in place, appending any key the text does not have. */
function setEnvValues(text, values) {
  const pending = new Map(Object.entries(values));
  const lines = text.split('\n').map((line) => {
    const m = /^(\s*(?:export\s+)?)([A-Z0-9_]+)\s*=/.exec(line);
    if (!m || !pending.has(m[2])) return line;
    const value = pending.get(m[2]);
    pending.delete(m[2]);
    return `${m[1]}${m[2]}=${value}`;
  });
  for (const [key, value] of pending) lines.push(`${key}=${value}`);
  return lines.join('\n');
}

const ENV_HEADER = `# Written by \`npm run dev:local\` for local development — Postgres and S3
# run on this machine (scripts/dev-local.mjs). RESEND_API_KEY is blank on
# purpose: under \`next dev\` the sign-in link is printed to the terminal.
# Point DATABASE_URL anywhere else and dev:local refuses to start, rather than
# run a local session against a database it does not manage.

`;

function ensureEnvFile() {
  if (!existsSync(ENV_FILE)) {
    const example = readFileSync(join(root, '.env.local.example'), 'utf8');
    writeFileSync(ENV_FILE, ENV_HEADER + setEnvValues(example, {
      DATABASE_URL: LOCAL_DATABASE_URL,
      AUTH_SECRET: randomBytes(32).toString('base64'),
      CRON_SECRET: randomBytes(24).toString('hex'),
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    }));
    ok('.env.local', 'written from .env.local.example');
    return;
  }

  // An existing file is the developer's: fill in what is blank, nothing else.
  const text = readFileSync(ENV_FILE, 'utf8');
  const current = parseEnv(text);
  const blanks = {};
  if (!current.DATABASE_URL && !current.POSTGRES_URL) blanks.DATABASE_URL = LOCAL_DATABASE_URL;
  if (!current.AUTH_SECRET) blanks.AUTH_SECRET = randomBytes(32).toString('base64');
  if (Object.keys(blanks).length) {
    writeFileSync(ENV_FILE, setEnvValues(text, blanks));
    ok('.env.local', `filled in ${Object.keys(blanks).join(', ')}`);
  }
}

/**
 * What `next dev` will see: the shell's environment first, then the files in
 * the order Next loads them, the first file to define a key winning.
 */
function nextDevEnv() {
  const files = {};
  for (const name of ['.env.development.local', '.env.local', '.env.development', '.env']) {
    let text;
    try { text = readFileSync(join(root, name), 'utf8'); } catch { continue; }
    for (const [key, value] of Object.entries(parseEnv(text))) {
      if (!(key in files)) files[key] = value;
    }
  }
  return (key) => (key in process.env ? process.env[key] : files[key]);
}

function isLocalCluster(raw) {
  try {
    const u = new URL(raw);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && Number(u.port) === PG_PORT;
  } catch {
    return false;
  }
}

// ── Postgres ─────────────────────────────────────────────────────────────────
const pgInitialized = () => existsSync(join(PG_DATA, 'PG_VERSION'));

function pgRunning(pgCtl) {
  return pgInitialized() && spawnSync(pgCtl, ['-D', PG_DATA, 'status'], { stdio: 'ignore' }).status === 0;
}

/** Returns whether this call started it. */
function startPostgres({ pgCtl, initdb }) {
  mkdirSync(DEV, { recursive: true });
  if (!pgInitialized()) {
    run(initdb, ['-D', PG_DATA, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=en_US.UTF-8'], 'initdb');
    ok('Postgres cluster created', rel(PG_DATA));
  }
  if (pgRunning(pgCtl)) return false;
  // TCP on loopback only, and no Unix socket: nothing here should depend on
  // /tmp, and the connection string names the port.
  run(pgCtl, ['-D', PG_DATA, '-l', PG_LOG, '-w', '-t', '30', '-o', `-p ${PG_PORT} -h 127.0.0.1 -k ''`, 'start'], 'Starting Postgres', PG_LOG);
  return true;
}

/** Create the database the URL names, if it does not exist. Returns whether it did. */
async function ensureDatabase(url) {
  const name = decodeURIComponent(new URL(url).pathname.slice(1)) || 'postgres';
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const sql = postgres(maintenance.toString(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql`SELECT 1 AS present FROM pg_database WHERE datname = ${name}`;
    if (row) return false;
    await sql.unsafe(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    return true;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

// ── S3 (versitygw) ───────────────────────────────────────────────────────────
const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 },
  maxAttempts: 1,
});

// A signed request rather than a bare probe of the port: it proves the thing
// listening is an S3 that accepts these credentials.
async function s3Answers() {
  try {
    await s3.send(new ListBucketsCommand({}));
    return true;
  } catch {
    return false;
  }
}

/** Returns whether this call started it. */
async function startS3(vgw) {
  if (await s3Answers()) return false;
  mkdirSync(S3_DATA, { recursive: true });
  const log = openSync(S3_LOG, 'a');
  // Detached into its own process group, so Ctrl-C on `next dev` leaves it
  // running for the next start. `npm run dev:stop` is what ends it.
  const child = spawn(vgw, ['--port', `127.0.0.1:${S3_PORT}`, '--region', S3_REGION, '--quiet', 'posix', S3_DATA], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ROOT_ACCESS_KEY_ID: S3_ACCESS_KEY, ROOT_SECRET_ACCESS_KEY: S3_SECRET_KEY },
  });
  child.unref();
  closeSync(log);
  for (let i = 0; i < 50 && child.exitCode === null; i++) {
    if (await s3Answers()) return true;
    await sleep(200);
  }
  die('S3 (versitygw) did not come up.', `${rel(S3_LOG)}:\n${tail(S3_LOG)}`);
}

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    return false;
  } catch (e) {
    if (e?.$metadata?.httpStatusCode !== 404) throw e;
  }
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  return true;
}

/** The versitygw listening on our port, if any — the only process `stop` may signal. */
function s3Pid() {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${S3_PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  for (const pid of r.stdout.split('\n').map(Number).filter(Boolean)) {
    const ps = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    if (/versitygw/.test(ps.stdout)) return pid;
  }
  return null;
}

// ── The app's own state ──────────────────────────────────────────────────────
// Done through lib/ rather than raw SQL, so the schema and the storage row are
// written by exactly the code a request would use.
async function prepareApp(url) {
  process.env.DATABASE_URL = url;
  const db = await import('../lib/db.js');
  const storage = await import('../lib/storage.js');
  try {
    const failed = (await db.ensureSchema()).filter((r) => !r.ok);
    if (failed.length) die('Creating the schema failed.', failed.map((r) => `    ${r.label}: ${r.error}`).join('\n'));
    ok('Schema', 'every ensure* guard applied');

    // Only fill in storage that is not configured. Anything set in Admin →
    // Storage — a real bucket being tried out locally — is left alone.
    let cfg = await storage.getStorageConfig({ strict: true });
    if (!storage.s3Ready(cfg)) {
      cfg = await storage.setStorageConfig(storage.sanitizeStorageSubmission({
        provider: 's3', endpoint: S3_ENDPOINT, region: S3_REGION, bucket: BUCKET,
        accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY, prefix: 'files',
      }), 'scripts/dev-local.mjs');
      ok('Storage', 'Admin → Storage now points at the local bucket');
    }
    if (storage.normalizeEndpoint(cfg.endpoint).endpoint === S3_ENDPOINT) {
      // Any origin: the bucket is only reachable from this machine, every
      // request still needs a signature, and `next dev` moves to :3001 when
      // :3000 is taken — uploads have to keep working when it does.
      await storage.s3PutBucketCors(cfg, { origins: ['*'] });
    } else {
      note(`storage points at ${cfg.endpoint || 'AWS S3'} (set in Admin → Storage), left as it is`);
    }
  } finally {
    await db.sql.end({ timeout: 1 });
  }
}

// ── next dev ─────────────────────────────────────────────────────────────────
function startNext(args) {
  const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
  const child = spawn(process.execPath, [nextBin, 'dev', ...args], { cwd: root, stdio: 'inherit' });
  // Ctrl-C reaches `next dev` directly (same process group). This process
  // only waits for it to exit, then says what is still running.
  process.on('SIGINT', () => {});
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => {
    console.log(paint(C.dim, '\nPostgres and S3 are still running — `npm run dev:stop` stops them.'));
    process.exit(code ?? 0);
  });
}

// ── commands ─────────────────────────────────────────────────────────────────
async function stop() {
  const pgCtl = findPgCtl();
  if (pgCtl && pgRunning(pgCtl)) {
    run(pgCtl, ['-D', PG_DATA, '-m', 'fast', '-w', 'stop'], 'Stopping Postgres', PG_LOG);
    ok('Postgres stopped');
  } else {
    note('Postgres was not running');
  }

  const pid = s3Pid();
  if (pid) {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 50 && s3Pid(); i++) await sleep(100);
    ok('S3 stopped');
  } else {
    note('S3 was not running');
  }
}

async function start(args) {
  const tools = requireTools();
  ensureEnvFile();

  const env = nextDevEnv();
  const url = env('DATABASE_URL') || env('POSTGRES_URL') || '';
  if (!isLocalCluster(url)) {
    let where = 'nowhere';
    try { where = new URL(url).host; } catch { /* unset or unparseable */ }
    die(`DATABASE_URL points at ${where}, not at the local cluster.`,
      `    dev:local only runs the app against the database it manages. Set\n`
      + `    DATABASE_URL=${LOCAL_DATABASE_URL} in .env.local, or move .env.local\n`
      + '    aside to have a fresh one written. (`npm run dev` still runs against\n'
      + '    whatever .env.local names.)');
  }

  const pgStarted = startPostgres(tools);
  ok('Postgres', `${url}${pgStarted ? '' : '  (already running)'}`);
  if (await ensureDatabase(url)) ok('Database created', new URL(url).pathname.slice(1));

  const s3Started = await startS3(tools.vgw);
  ok('S3', `${S3_ENDPOINT}  ${s3Started ? '' : '(already running)  '}bucket "${BUCKET}" is ${rel(join(S3_DATA, BUCKET))}/`);
  if (await ensureBucket()) ok('Bucket created', BUCKET);

  await prepareApp(url);

  // No URL here: `next dev` prints its own, and it moves off :3000 when
  // something else already has it.
  const admin = String(env('ADMIN_EMAILS') || '').split(',')[0].trim();
  console.log(`\n  Sign in${admin ? ` as ${paint(C.bold, admin)}` : ''} at the address below.`
    + ' The link is printed here — nothing is emailed.\n');
  startNext(args);
}

console.log(`\n${paint(C.bold, 'Onyx — local development')}`);
const [command, ...rest] = process.argv.slice(2);
if (command === 'stop') {
  await stop();
} else {
  // Anything else is for `next dev`: npm run dev:local -- --turbo
  await start(command ? [command, ...rest] : []);
}
