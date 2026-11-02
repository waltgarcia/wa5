// WA5 access gate: fixed profile name + local password.
//
// - The password is stored as a scrypt hash with a random salt; the plain text
//   never touches the disk and is never written to logs.
// - The file lives in the app's data folder, outside the repository.
// - Without the right password the WhatsApp window is never created, so nobody
//   gets to see the conversations from the app.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ACCESS_FILE = (dataDir) => path.join(dataDir, 'access.json');
const SESSION_FILE = (dataDir) => path.join(dataDir, 'session.json');
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000; // 30 s of penalty after 5 failures

// --- legacy file names ------------------------------------------------------
// Both files used to be named in Spanish. An install configured before the
// rename must keep working, so the old name is moved to the new one on first
// touch instead of starting over from "no password configured".
function migrateLegacyFiles(dataDir) {
  for (const [legacy, current] of [['acceso.json', 'access.json'], ['sesion.json', 'session.json']]) {
    try {
      const from = path.join(dataDir, legacy);
      const to = path.join(dataDir, current);
      // Only when the new name is missing: an existing access.json is never
      // overwritten by a stale copy.
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    } catch { /* the readers below still fall back to the legacy name */ }
  }
}

// Reads the first file of the list that parses; the legacy name goes last so a
// migration that could not rename still reads the old file.
function readJson(dataDir, names) {
  for (const name of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
      if (j) return j;
    } catch { /* try the next name */ }
  }
  return null;
}

function readAccess(dataDir) {
  migrateLegacyFiles(dataDir);
  const j = readJson(dataDir, ['access.json', 'acceso.json']);
  if (!j || !j.hash) return null;
  // Accept the pre-rename field names too: a file written before the rename
  // would otherwise read as "not configured" and lock the user out.
  const profile = j.profile || j.perfil;
  if (!profile) return null;
  return {
    profile,
    salt: j.salt || j.sal,
    iterations: j.iterations || j.iteraciones,
    hash: j.hash,
    created: j.created || j.creado
  };
}

function derive(password, salt, iterations) {
  return crypto.scryptSync(password.normalize('NFKC'), salt, 64, { N: iterations }).toString('hex');
}

function configure(dataDir, profile, password) {
  const name = String(profile || '').trim();
  if (name.length < 2 || name.length > 40) {
    throw new Error('The profile name must be between 2 and 40 characters');
  }
  if (String(password || '').length < 6) {
    throw new Error('The password must be at least 6 characters long');
  }
  const iterations = 16384;
  const salt = crypto.randomBytes(16).toString('hex');
  const data = {
    profile: name,
    salt,
    iterations,
    hash: derive(password, salt, iterations),
    created: new Date().toISOString()
  };
  migrateLegacyFiles(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(ACCESS_FILE(dataDir), JSON.stringify(data, null, 2), { mode: 0o600 });
  return { profile: name };
}

function createVerifier(dataDir) {
  let failures = 0;
  let lockedUntil = 0;

  return function verify(password) {
    const data = readAccess(dataDir);
    if (!data) throw new Error('There is no password configured yet');

    const now = Date.now();
    if (now < lockedUntil) {
      const remaining = Math.ceil((lockedUntil - now) / 1000);
      throw new Error(`Too many attempts. Wait ${remaining} s.`);
    }

    const attempt = derive(String(password || ''), data.salt, data.iterations);
    const matches =
      attempt.length === data.hash.length &&
      crypto.timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(data.hash, 'hex'));

    if (!matches) {
      failures += 1;
      if (failures >= MAX_ATTEMPTS) {
        failures = 0;
        lockedUntil = Date.now() + LOCKOUT_MS;
        throw new Error(`Too many attempts. Wait ${LOCKOUT_MS / 1000} s.`);
      }
      throw new Error(`Wrong password. ${MAX_ATTEMPTS - failures} attempts left.`);
    }

    failures = 0;
    return { profile: data.profile };
  };
}

// --- idle lock -------------------------------------------------------------
// The password is not asked for on every start: only after minutes without
// anyone touching the app. The last-activity mark is signed with the hash, so
// editing the file by hand does not get past the password.
function signActivity(data, at) {
  return crypto.createHmac('sha256', `${data.hash}:${data.salt}`)
    .update(String(at)).digest('hex');
}

function saveActivity(dataDir, at = Date.now()) {
  migrateLegacyFiles(dataDir);
  const data = readAccess(dataDir);
  if (!data) return false;
  try {
    const mark = { at, signature: signActivity(data, at) };
    fs.writeFileSync(SESSION_FILE(dataDir), JSON.stringify(mark), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds since the last recorded activity, or Infinity when there is no valid mark. */
function idleMs(dataDir) {
  migrateLegacyFiles(dataDir);
  const data = readAccess(dataDir);
  if (!data) return Infinity;
  try {
    const mark = readJson(dataDir, ['session.json', 'sesion.json']);
    // The field names are read both ways for the same reason as in readAccess():
    // a session.json migrated from sesion.json still carries the old ones.
    const at = mark && (mark.at ?? mark.cuando);
    const signature = mark && (mark.signature ?? mark.firma);
    if (!at || !signature) return Infinity;
    const expected = signActivity(data, at);
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return Infinity;
    return Math.max(0, Date.now() - Number(at));
  } catch {
    return Infinity;
  }
}

function forgetActivity(dataDir) {
  for (const name of ['session.json', 'sesion.json']) {
    try { fs.unlinkSync(path.join(dataDir, name)); } catch { /* was not there */ }
  }
}

module.exports = {
  readAccess, configure, createVerifier, ACCESS_FILE,
  saveActivity, idleMs, forgetActivity
};
