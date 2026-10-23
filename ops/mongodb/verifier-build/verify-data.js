'use strict';
// Read-only MongoDB commands only. Never emit documents, credentials or raw errors.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { MongoClient, BSON } = require('mongodb');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const EXCLUDED = new Set(['config.system.sessions']);

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortedObject(value[k])]));
  }
  return value;
}
function metadataHash(value) {
  return hash(JSON.stringify(sortedObject(BSON.EJSON.serialize(value, { relaxed: false }))));
}
function normalizeIndex(index, namespace) {
  const copy = { ...index };
  if (copy.ns !== undefined) { assert.equal(copy.ns, namespace); delete copy.ns; }
  // Historical background specifies index-build scheduling, not index semantics.
  if (copy.background !== undefined) { assert.equal(typeof copy.background, 'boolean'); delete copy.background; }
  return copy;
}
function indexHash(indexes, namespace) {
  const normalized = indexes.map(i => normalizeIndex(i, namespace));
  normalized.sort((a, b) => String(a.name).localeCompare(String(b.name), 'en'));
  // Preserve compound-index key order: encode it as ordered [field,value] pairs.
  for (const index of normalized) index.key = Object.entries(index.key || {});
  return metadataHash(normalized);
}
function contentHash(digests) {
  const output = crypto.createHash('sha256');
  for (const digest of digests.sort(Buffer.compare)) output.update(digest);
  return output.digest('hex');
}
// MongoDB r6.0.28 wiredtiger_record_store.cpp:1820-1830 reports EBUSY
// using this exact warning. The table check was not completed, so retry the
// full command; a valid flag alone is not a substitute for a zero-warning pass.
function transientTableBusy(message) {
  return typeof message === 'string' && /^Could not complete validation of table:[A-Za-z0-9_-]+\. This is a transient issue as the collection was actively in use by other operations\.$/.test(message);
}
async function validateWithRetry(command, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  let initialWarnings = [], result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await command();
    assert(result.valid === true && !(result.errors || []).length, 'Collection validation failed');
    const warnings = result.warnings || [];
    assert(Array.isArray(warnings), 'Malformed validation warnings');
    if (attempt === 0) initialWarnings = warnings;
    if (!warnings.length || !warnings.every(transientTableBusy) || attempt === 2) {
      return { validation: { valid: true, warningCount: warnings.length },
        validationRetryCount: attempt, validationFirstWarningsSha256: metadataHash(initialWarnings) };
    }
    await pause((attempt + 1) * 500);
  }
  throw new Error('Unreachable validation retry state');
}
async function verify(request) {
  assert.equal(request.host || '127.0.0.1', '127.0.0.1');
  assert.equal(request.port || 27017, 27017);
  const limit = request.maxDocumentsPerCollection || 500000;
  assert(Number.isSafeInteger(limit) && limit >= 100000 && limit <= 1000000);
  const options = { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 10000,
    socketTimeoutMS: 120000, maxPoolSize: 1, minPoolSize: 0, retryReads: false, retryWrites: false };
  if (request.auth) {
    assert.equal(typeof request.auth.username, 'string'); assert.equal(typeof request.auth.password, 'string');
    options.auth = { username: request.auth.username, password: request.auth.password };
    options.authSource = request.auth.authDatabase || 'admin';
  }
  const client = new MongoClient('mongodb://127.0.0.1:27017/?directConnection=true', options);
  try {
    await client.connect();
    const admin = client.db('admin');
    const build = await admin.command({ buildInfo: 1 });
    const fcv = await admin.command({ getParameter: 1, featureCompatibilityVersion: 1 });
    assert(!fcv.featureCompatibilityVersion.targetVersion, 'FCV transition is incomplete');
    const databases = await admin.command({ listDatabases: 1, nameOnly: true, authorizedDatabases: false });
    const result = { schema: 1, readOnly: true, serverVersion: build.version,
      fcv: fcv.featureCompatibilityVersion.version, driver: require('mongodb/package.json').version,
      collections: {}, excludedNamespaces: [], excludedDocuments: ['admin.system.version: _id=featureCompatibilityVersion only'], contentAlgorithm: 'SHA256 of sorted SHA256(raw BSON) digests; duplicates retained',
      naturalAlgorithm: 'SHA256 of concatenated length-delimited raw BSON in $natural:1 order',
      indexNormalization: ['drop ns after matching namespace', 'drop boolean background build-scheduling flag', 'preserve compound key field order'],
      usersRoles: {} };
    const startup = await admin.command({ getLog: 'startupWarnings' });
    const warningText = (startup.log || []).join('\n');
    const categories = { transparentHugePages: /transparent.*huge|transparent_hugepage/i,
      maxMapCount: /max_map_count/i, swappiness: /swappiness/i, overcommit: /overcommit/i,
      allocatorRseq: /rseq|tcmalloc/i, filesystem: /XFS|filesystem/i, limits: /rlimit|ulimit/i,
      noAuthExpectedForIsolatedClone: /access control.*not enabled|authorization.*disabled/i };
    result.startupWarnings = { lineCount: (startup.log || []).length,
      categories: Object.fromEntries(Object.entries(categories).map(([name, pattern]) => [name, pattern.test(warningText)])),
      rawMessagesWithheld: true, hostSettingsChanged: false };
    for (const entry of databases.databases.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === 'local') { result.excludedNamespaces.push('local.* (per-process/internal, not business data)'); continue; }
      const db = client.db(entry.name);
      const infos = await db.listCollections({}, { nameOnly: false }).toArray();
      for (const info of infos.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const ns = entry.name + '.' + info.name;
        if (EXCLUDED.has(ns) || info.name === 'system.profile') {
          result.excludedNamespaces.push(ns); continue;
        }
        if (info.name.startsWith('system.buckets.')) {
          const parent = infos.find(v => v.name === info.name.slice('system.buckets.'.length));
          assert(parent && parent.options && parent.options.timeseries, 'Invalid system.buckets namespace');
        }
        const row = { type: info.type, optionsSha256: metadataHash(info.options || {}),
          uuidSha256: info.info && info.info.uuid ? metadataHash(info.info.uuid) : null,
          capped: !!(info.options && info.options.capped),
          cappedMax: info.options && info.options.max !== undefined ? String(info.options.max) : null,
          cappedBytes: info.options && info.options.size !== undefined ? String(info.options.size) : null };
        if (info.type === 'view') { result.collections[ns] = row; continue; }
        const collection = db.collection(info.name);
        const indexes = await collection.listIndexes().toArray();
        for (const index of indexes) {
          if (Object.hasOwn(index, 'expireAfterSeconds')) {
            const value = Number(index.expireAfterSeconds);
            assert(Number.isFinite(value) && value >= 0, 'Invalid TTL specification');
          }
        }
        row.indexCount = indexes.length; row.indexesSha256 = indexHash(indexes, ns);
        const natural = crypto.createHash('sha256'); const digests = []; let count = 0; let bytes = 0;
        const query = ns === 'admin.system.version' ? { _id: { $ne: 'featureCompatibilityVersion' } } : {};
        const cursor = collection.find(query, { raw: true, batchSize: 64, noCursorTimeout: true,
          maxTimeMS: request.maxQueryTimeMS || 300000 }).sort({ $natural: 1 });
        try {
          for await (const document of cursor) {
            assert(Buffer.isBuffer(document), 'Driver did not return raw BSON');
            assert.equal(document.readInt32LE(0), document.length, 'Malformed raw BSON envelope');
            assert(++count <= limit, 'Collection exceeds bounded verification limit');
            natural.update(document); bytes += document.length;
            digests.push(crypto.createHash('sha256').update(document).digest());
          }
        } finally { await cursor.close(); }
        row.count = count; row.rawBsonBytes = bytes;
        row.contentSha256 = contentHash(digests); row.naturalSha256 = natural.digest('hex');
        Object.assign(row, await validateWithRetry(() => db.command({ validate: info.name, full: true, maxTimeMS: 300000 })));
        result.collections[ns] = row;
        if (info.name === 'system.users' || info.name === 'system.roles') {
          result.usersRoles[ns] = { count, contentSha256: row.contentSha256 };
        }
      }
    }
    result.passed = true;
    return result;
  } finally { await client.close(); }
}
async function selfTest() {
  const a = BSON.serialize({ _id: new BSON.ObjectId('000000000000000000000001'), n: new BSON.Int32(1), secret: 'not-output' });
  const b = BSON.serialize({ _id: new BSON.ObjectId('000000000000000000000002'), n: new BSON.Double(1) });
  const digest = raw => crypto.createHash('sha256').update(raw).digest();
  assert.equal(contentHash([digest(a), digest(b)]), contentHash([digest(b), digest(a)]));
  assert.notEqual(contentHash([digest(a)]), contentHash([digest(a), digest(a)]));
  assert.notEqual(hash(a), hash(BSON.serialize({ _id: new BSON.ObjectId('000000000000000000000001'), n: new BSON.Double(1), secret: 'not-output' })));
  assert.equal(indexHash([{ v: 2, key: { a: 1, b: -1 }, name: 'ab', ns: 'd.c', background: true }], 'd.c'), indexHash([{ name: 'ab', key: { a: 1, b: -1 }, v: 2 }], 'd.c'));
  assert.notEqual(indexHash([{ key: { a: 1, b: -1 }, name: 'ab' }], 'd.c'), indexHash([{ key: { b: -1, a: 1 }, name: 'ab' }], 'd.c'));
  assert.throws(() => normalizeIndex({ ns: 'wrong.c' }, 'd.c'));
  assert.equal(metadataHash({ b: 1, a: 2 }), metadataHash({ a: 2, b: 1 }));
  const busy = 'Could not complete validation of table:collection-0-123456789. This is a transient issue as the collection was actively in use by other operations.';
  assert(transientTableBusy(busy));
  assert(!transientTableBusy(busy + ' extra'));
  assert(!transientTableBusy('Index validation encountered an unrelated warning'));
  let calls = 0, pauses = [];
  const recovered = await validateWithRetry(async () => ({ valid: true, errors: [], warnings: ++calls === 1 ? [busy] : [] }), async ms => pauses.push(ms));
  assert.equal(calls, 2); assert.deepEqual(pauses, [500]);
  assert.deepEqual(recovered.validation, { valid: true, warningCount: 0 });
  assert.equal(recovered.validationRetryCount, 1); assert.equal(recovered.validationFirstWarningsSha256, metadataHash([busy]));
  calls = 0; pauses = [];
  const exhausted = await validateWithRetry(async () => { calls++; return { valid: true, errors: [], warnings: [busy] }; }, async ms => pauses.push(ms));
  assert.equal(calls, 3); assert.deepEqual(pauses, [500, 1000]);
  assert.equal(exhausted.validation.warningCount, 1); assert.equal(exhausted.validationRetryCount, 2);
  calls = 0;
  const unrelated = await validateWithRetry(async () => { calls++; return { valid: true, errors: [], warnings: ['Unrelated warning'] }; }, async () => assert.fail('Must not retry unrelated warnings'));
  assert.equal(calls, 1); assert.equal(unrelated.validation.warningCount, 1);
  calls = 0;
  const mixed = await validateWithRetry(async () => { calls++; return { valid: true, errors: [], warnings: [busy, 'Unrelated warning'] }; }, async () => assert.fail('Must not retry mixed warnings'));
  assert.equal(calls, 1); assert.equal(mixed.validation.warningCount, 2);
  await assert.rejects(validateWithRetry(async () => ({ valid: false, errors: [], warnings: [busy] })), /validation failed/);
  await assert.rejects(validateWithRetry(async () => ({ valid: true, errors: ['corrupt'], warnings: [busy] })), /validation failed/);
  return { passed: true, tests: 16, node: process.version, driver: require('mongodb/package.json').version, databaseAccess: false };
}
if (require.main === module) {
  (async () => {
    if (process.argv.includes('--self-test')) return selfTest();
    const input = fs.readFileSync(0, 'utf8'); assert(input.length <= 65536);
    return verify(JSON.parse(input || '{}'));
  })().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stdout.write(JSON.stringify({ passed: false, errorType: error.name,
      message: 'Read-only verification failed; raw server errors and data withheld.' }) + '\n');
    process.exitCode = 1;
  });
}
module.exports = { verify, selfTest, metadataHash, indexHash, contentHash, transientTableBusy, validateWithRetry };
