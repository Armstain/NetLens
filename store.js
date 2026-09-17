// Durable request history.
//
// chrome.storage.local is the obvious home and the wrong one: a single
// response body runs to the 200KB cap, so its 10MB quota is spent after a few
// dozen requests, and lifting it means asking for the unlimitedStorage
// permission. IndexedDB has neither problem.

const DB_NAME = 'netlens';
const DB_VERSION = 1;

// ponytail: fixed caps. Move them into the settings panel if anyone asks for
// a different budget.
const MAX_SESSIONS = 25;
const MAX_BYTES = 40 * 1024 * 1024;

// Rough per-entry cost. The bodies dominate; the rest is headers and metadata
// that never approach them, so a flat allowance covers it.
function entryBytes(d) {
  if (!d) return 0;
  const req = typeof d.requestBody === 'string' ? d.requestBody.length : 0;
  const res = typeof d.responseBody === 'string' ? d.responseBody.length : 0;
  // Socket frames carry their payload on .data, not a body field.
  const frame = typeof d.data === 'string' ? d.data.length : 0;
  return req + res + frame + 512;
}

// Which sessions have to go, oldest first, to get back under both caps.
// Pure so it can be tested without a database.
function sessionsToPrune(sessions, maxSessions = MAX_SESSIONS, maxBytes = MAX_BYTES) {
  const sorted = [...(sessions || [])].sort((a, b) => a.startedAt - b.startedAt);
  const doomed = [];
  let total = sorted.reduce((n, s) => n + (s.bytes || 0), 0);
  let count = sorted.length;
  for (const s of sorted) {
    if (count <= maxSessions && total <= maxBytes) break;
    // The newest session is the one being written to right now; dropping it
    // would delete the capture in progress.
    if (count <= 1) break;
    doomed.push(s.id);
    total -= s.bytes || 0;
    count--;
  }
  return doomed;
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let dbPromise = null;

function dbOpen() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('entries')) {
        const store = db.createObjectStore('entries', { keyPath: 'key', autoIncrement: true });
        store.createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // A failed open must not poison every later call with the same rejection.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function dbStartSession(url, startedAt) {
  const db = await dbOpen();
  const tx = db.transaction('sessions', 'readwrite');
  const id = await idbReq(tx.objectStore('sessions').add({
    url: url || '',
    startedAt: startedAt || Date.now(),
    count: 0,
    errors: 0,
    bytes: 0,
  }));
  await idbDone(tx);
  return id;
}

async function dbUpdateSession(id, url, startedAt) {
  const db = await dbOpen();
  const tx = db.transaction('sessions', 'readwrite');
  const store = tx.objectStore('sessions');
  const session = await idbReq(store.get(id));
  if (session) {
    session.url = url || session.url;
    session.startedAt = startedAt || session.startedAt;
    store.put(session);
  }
  await idbDone(tx);
}

async function dbAddEntries(sessionId, batch) {
  if (sessionId == null || !batch || !batch.length) return;
  const db = await dbOpen();
  const tx = db.transaction(['entries', 'sessions'], 'readwrite');
  const entries = tx.objectStore('entries');
  const sessions = tx.objectStore('sessions');

  let bytes = 0;
  let errors = 0;
  for (const d of batch) {
    // __bodyHay is a lazily built search cache, not capture data — storing it
    // would roughly double the size of every row on disk.
    const { __bodyHay, ...clean } = d;
    entries.add({ sessionId, data: clean });
    bytes += entryBytes(d);
    if (isError(d)) errors++;
  }

  const session = await idbReq(sessions.get(sessionId));
  if (session) {
    session.count += batch.length;
    session.errors += errors;
    session.bytes += bytes;
    sessions.put(session);
  }
  await idbDone(tx);
}

async function dbListSessions() {
  const db = await dbOpen();
  const tx = db.transaction('sessions', 'readonly');
  const all = await idbReq(tx.objectStore('sessions').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

async function dbLoadEntries(sessionId) {
  const db = await dbOpen();
  const tx = db.transaction('entries', 'readonly');
  const rows = await idbReq(tx.objectStore('entries').index('sessionId').getAll(sessionId));
  return rows.map((r) => r.data);
}

async function dbDeleteSessions(ids) {
  if (!ids || !ids.length) return;
  const db = await dbOpen();
  const tx = db.transaction(['entries', 'sessions'], 'readwrite');
  const entries = tx.objectStore('entries');
  const index = entries.index('sessionId');
  for (const id of ids) {
    tx.objectStore('sessions').delete(id);
    // Deleting by cursor rather than getAll: the keys are all that is needed,
    // and pulling whole bodies into memory to throw them away is wasteful.
    const cursorReq = index.openKeyCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      entries.delete(cursor.primaryKey);
      cursor.continue();
    };
  }
  await idbDone(tx);
}

async function dbClearAll() {
  const db = await dbOpen();
  const tx = db.transaction(['entries', 'sessions'], 'readwrite');
  tx.objectStore('entries').clear();
  tx.objectStore('sessions').clear();
  await idbDone(tx);
}

async function dbPrune() {
  const doomed = sessionsToPrune(await dbListSessions());
  if (doomed.length) await dbDeleteSessions(doomed);
  return doomed.length;
}

if (typeof module !== 'undefined') {
  module.exports = { entryBytes, sessionsToPrune, MAX_SESSIONS, MAX_BYTES };
}
