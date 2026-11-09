import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseXML } from '@recogito/standoff-converter';

process.env.CORENLP_URL_EN = 'https://corenlp-en.test';
process.env.CORENLP_URL_DE = 'https://corenlp-de.test';
const state = { tasks: [], logs: [], uploads: [], mentionLimit: 1 };
mock.module('@trigger.dev/sdk/v3', { namedExports: {
  logger: { info(...args) { state.logs.push(args); }, log() {}, error() {} },
  task(options) { state.tasks.push(options.id); return options; },
} });
mock.module('@supabase/supabase-js', { namedExports: {
  createClient: (...args) => state.createClient(...args),
} });
mock.module('tus-js-client', { namedExports: {
  Upload: class {
    constructor(file, options) { this.file = file; this.options = options; }
    async findPreviousUploads() { return []; }
    start() {
      state.uploads.push({ file: this.file, options: this.options });
      if (state.fail === 'upload') this.options.onError(new Error('test upload failure'));
      else this.options.onSuccess();
    }
  },
} });
const { stanfordCore } = await import('../dist/trigger/stanfordCore.js');
const { doStanfordNlp } = await import('../dist/trigger/tasks/doStandfordNlp.js');
const { chunkText } = await import('../dist/trigger/chunkText.js');
const payload = { serverURL: 'https://supabase.test', key: 'public-test-key',
  token: 'test-user-session', userId: 'test-user', projectId: 'test-project',
  documentId: 'test-source', nameOut: 'NER test', language: 'en', outputLanguage: 'en' };
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; mock.restoreAll(); });

function setup(text, contentType = 'text/plain', fail) {
  Object.assign(state, { logs: [], uploads: [], inserts: [], links: [], requests: [], fail, mentionLimit: 1 });
  state.createClient = (url, key, options) => {
    assert.equal(url, payload.serverURL); assert.equal(key, payload.key);
    assert.equal(options.global.headers.Authorization, `Bearer ${payload.token}`);
    return {
      storage: { from(bucket) {
        assert.equal(bucket, 'documents');
        return { async download(id) {
          assert.equal(id, payload.documentId);
          return { data: new Blob([text]), error: null };
        } };
      } },
      from(table) {
        let inserted;
        const result = () => inserted ?
          { data: { id: 'new-output-document' }, error: fail === 'notification' && table === 'notifications' ? { message: 'test notification failure' } : null } :
          { data: { content_type: contentType }, error: null };
        const query = {
          select() { return query; }, eq() { return query; },
          insert(row) { inserted = row; state.inserts.push({ table, row }); return query; },
          async single() { return result(); },
          then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
        };
        return query;
      },
      async rpc(name, args) { state.links.push({ name, args }); return { error: null }; },
    };
  };
  globalThis.fetch = async (url, options) => {
    state.requests.push({ url, text: options.body });
    if (fail === 'nlp') return { ok: false, statusText: 'test NLP failure' };
    const matches = [...options.body.matchAll(/Berlin/g)].slice(0, state.mentionLimit);
    return { ok: true, async json() { return { sentences: [{ entitymentions: matches.map(m => ({
      text: 'Berlin', characterOffsetBegin: m.index, characterOffsetEnd: m.index + 6, ner: 'LOCATION',
    })) }] }; } };
  };
}

test('only the small parent task is registered; whole-run retries are bounded', () => {
  assert.deepEqual(state.tasks, ['stanford-core']);
  assert.equal(stanfordCore.retry.maxAttempts, 1);
});

test('English text becomes a stored TEI document, with a small completion result', async () => {
  setup('Berlin & London 😀');
  const result = await stanfordCore.run(payload);
  assert.deepEqual(result, { documentId: 'new-output-document', entityCount: 1 });
  assert.equal(state.uploads.length, 1);
  assert.equal(state.uploads[0].options.metadata.contentType, 'text/xml');
  const xml = state.uploads[0].file.toString('utf8');
  assert.match(xml, /standOff/); assert.match(xml, /Location/);
  assert.match(parseXML(xml).text(), /Berlin & London 😀/);
  assert.equal(state.links.length, 1);
  assert.equal(state.inserts.filter(x => x.table === 'notifications').length, 1);
});

test('German TEI input retains markup and uses the German model/labels', async () => {
  setup('<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>Test</title></titleStmt><publicationStmt><p>Test</p></publicationStmt><sourceDesc><p>Test</p></sourceDesc></fileDesc></teiHeader><text><body><p>Berlin und <hi>München</hi> 😀.</p></body></text></TEI>', 'text/xml');
  const result = await stanfordCore.run({ ...payload, language: 'de', outputLanguage: 'de' });
  assert.equal(result.entityCount, 1);
  assert.ok(state.requests.every(x => x.url.startsWith(process.env.CORENLP_URL_DE)));
  const xml = state.uploads[0].file.toString('utf8');
  assert.match(xml, /<hi>München<\/hi>/); assert.match(xml, /Standort/);
});

test('large text and aggregate entities stay inside the worker, outside task packets', async () => {
  setup('Berlin München 😀 '.repeat(70000));
  const result = await stanfordCore.run(payload);
  assert.ok(result.entityCount > 100);
  assert.ok(state.uploads[0].file.length > 1048576);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 256);
  assert.deepEqual(Object.keys(result).sort(), ['documentId', 'entityCount']);
  assert.ok(state.requests.length > 100);
  assert.deepEqual(state.tasks, ['stanford-core']);
  assert.equal(state.uploads[0].options.chunkSize, 6 * 1024 * 1024);
});

test('chunking preserves all text, bounded size and UTF-16 offsets at awkward boundaries', () => {
  for (const text of ['', 'x'.repeat(25001), 'x'.repeat(4999) + '😀' + 'y'.repeat(10001),
    ' Berlin  München 😀\n\t'.repeat(2000)]) {
    const chunks = chunkText(text);
    assert.equal(chunks.map(x => x.text).join(''), text);
    let offset = 0;
    for (const chunk of chunks) {
      assert.equal(chunk.start, offset);
      assert.ok(chunk.text.length > 0 && chunk.text.length <= 5000);
      assert.ok(!/[\ud800-\udbff]$/.test(chunk.text));
      assert.ok(!/^[\udc00-\udfff]/.test(chunk.text));
      offset += chunk.text.length;
    }
  }
});

test('NER entity offsets still select the exact original Unicode text across chunks', async () => {
  const text = 'München 😀 Berlin  '.repeat(1800);
  setup('');
  const { ner } = await doStanfordNlp({ data: text, language: 'de', outputLanguage: 'de' });
  assert.equal(state.requests.map(x => x.text).join(''), text);
  assert.ok(ner.entries.length > 1);
  for (const entity of ner.entries) {
    assert.equal(text.slice(entity.startIndex, entity.endIndex), entity.text);
    assert.equal(entity.localizedTag, 'Standort');
  }
});

test('aggregate entity result can exceed the historical offload threshold without a child task', async () => {
  setup(''); state.mentionLimit = 10;
  const { ner } = await doStanfordNlp({ data: 'Berlin '.repeat(160000), language: 'en', outputLanguage: 'en' });
  assert.ok(Buffer.byteLength(JSON.stringify(ner)) > 128 * 1024);
  assert.deepEqual(state.tasks, ['stanford-core']);
});

test('NLP failure propagates and does not publish an output document', async () => {
  setup('Berlin', 'text/plain', 'nlp');
  await assert.rejects(stanfordCore.run(payload), /test NLP failure/);
  assert.equal(state.uploads.length, 0); assert.equal(state.inserts.length, 0);
});

test('Storage failure cannot become a successful task completion', async () => {
  setup('Berlin', 'text/plain', 'upload');
  await assert.rejects(stanfordCore.run(payload), /test upload failure/);
  assert.equal(state.links.length, 0);
  assert.equal(state.inserts.filter(x => x.table === 'notifications').length, 0);
});

test('notification failure remains visible after publication (no automatic replay)', async () => {
  setup('Berlin', 'text/plain', 'notification');
  await assert.rejects(stanfordCore.run(payload), /test notification failure/);
  assert.equal(state.uploads.length, 1); assert.equal(state.links.length, 1);
});
