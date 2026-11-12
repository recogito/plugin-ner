import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { parseXML } from '@recogito/standoff-converter';
import { heartbeats as coreHeartbeats } from '@trigger.dev/core/v3';
import { StandardHeartbeatsManager } from '../node_modules/@trigger.dev/core/dist/esm/v3/heartbeats/manager.js';

process.env.CORENLP_URL_EN = 'https://corenlp-en.test';
process.env.CORENLP_URL_DE = 'https://corenlp-de.test';
const state = { tasks: [], logs: [], uploads: [], mentionLimit: 1 };
mock.module('@trigger.dev/sdk/v3', { namedExports: {
  heartbeats: { async yield() {
    state.yieldCalls = (state.yieldCalls || 0) + 1;
    if (state.yieldHook) await state.yieldHook();
  } },
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
const { nerToXML } = await import('../dist/trigger/tasks/nerToXML.js');
const { indexedXPointers } = await import('../dist/trigger/indexedXPointers.js');
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

test('dense large XML conversion keeps SDK heartbeats running and retains annotations', async () => {
  setup('');
  const text = 'Berlin 😀 '.repeat(150000);
  const originalXML = `<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc/></teiHeader><text><body><p>${text}</p></body></text></TEI>`;
  const original = parseXML(originalXML);
  const entries = Array.from({ length: 2000 }, (_, i) => ({
    text: 'Berlin', startIndex: i * 750, endIndex: i * 750 + 6,
    localizedTag: 'Location', inlineTag: 'placeName', attributes: {},
  }));
  // Use the installed SDK's real heartbeat manager with a shortened interval;
  // no Trigger API/network is involved. A synchronous loop starves this timer.
  const manager = new StandardHeartbeatsManager(10);
  let completed = false;
  let liveHeartbeats = 0;
  manager.registerListener(async () => { if (!completed) liveHeartbeats++; });
  coreHeartbeats.setGlobalManager(manager);
  state.yieldCalls = 0;
  state.yieldHook = () => coreHeartbeats.yield();
  manager.startHeartbeat('local-test');
  let result;
  try {
    result = await nerToXML({ nerData: { entries }, text, originalXML });
    completed = true;
    assert.ok(liveHeartbeats > 0, 'heartbeats must run before conversion completes');
    assert.ok(state.yieldCalls >= entries.length);
  } finally {
    manager.stopHeartbeat();
    coreHeartbeats.disable();
    delete state.yieldHook;
  }
  const parsed = parseXML(result.tei);
  // Converter.text() also includes taxonomy labels added to teiHeader; compare
  // the actual document body and resolve targets against the original source.
  assert.ok(parsed.xml().getElementsByTagName('body')[0].textContent === text);
  const annotations = parsed.xml().getElementsByTagName('annotation');
  assert.equal(annotations.length, entries.length);
  for (const i of [0, 1000, entries.length - 1]) {
    const target = annotations[i].getAttribute('target');
    const [startTarget, endTarget] = target.split(' ');
    const start = original.getCharacterOffset(startTarget);
    const end = original.getCharacterOffset(endTarget);
    assert.equal(start, entries[i].startIndex);
    assert.equal(end, entries[i].endIndex);
    assert.equal(text.slice(start, end), 'Berlin');
  }
  const messages = state.logs.map(x => x[0]);
  assert.ok(messages.includes('NER annotation progress'));
  assert.ok(messages.includes('NER XML conversion completed'));
});

test('indexed targets match converter pointers across Unicode, markup, IDs and boundaries', async () => {
  const sources = [
    '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc/></teiHeader><text><body><p>Berlin 😀<hi>München</hi> end.</p><p>Next <lb/>line.</p></body></text></TEI>',
    '<TEI xmlns="http://www.tei-c.org/ns/1.0" xml:id="source"><teiHeader><fileDesc/></teiHeader><text><body> A<p xml:id="p1">B<hi>C</hi>D</p><p>E</p> F</body></text></TEI>',
  ];
  for (const xml of sources) {
    const original = parseXML(xml);
    const offsets = Array.from({ length: original.text().length }, (_, i) => i);
    // Duplicate and unsorted boundaries are normal for overlapping entities.
    const actual = await indexedXPointers(original.tokens, [...offsets].reverse().concat(offsets));
    for (const offset of offsets) assert.equal(actual.get(offset), original.getXPointer(offset));
  }
});

test('bulk conversion preserves existing markup, annotations and taxonomy', async () => {
  setup('');
  const xml = '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc/><encodingDesc><classDecl><taxonomy xml:id="existing"><category xml:id="old"><catDesc>Old label</catDesc></category></taxonomy></classDecl></encodingDesc></teiHeader><standOff xml:id="previous"><listAnnotation><annotation xml:id="old-annotation" target="/TEI[1]/text[1]/body[1]/p[1]::0 /TEI[1]/text[1]/body[1]/p[1]::6"><rs ana="#old"/></annotation></listAnnotation></standOff><text><body><p xml:id="source-p">Berlin &amp; <hi>München 😀</hi>.</p></body></text></TEI>';
  const original = parseXML(xml);
  const text = original.text();
  const startIndex = text.indexOf('München');
  const { tei } = await nerToXML({ originalXML: xml, text, nerData: { entries: [
    { text: 'München', startIndex, endIndex: startIndex + 7, localizedTag: 'Location', inlineTag: 'placeName', attributes: {} },
  ] } });
  assert.match(tei, /xml:id="old-annotation"/);
  assert.match(tei, /xml:id="existing"/);
  assert.match(tei, /<hi>München 😀<\/hi>/);
  assert.match(tei, /xml:id="source-p"/);
  assert.equal((tei.match(/<annotation\b/g) || []).length, 2);
});

test('bulk conversion handles 61,683 annotations over a large multi-paragraph source', async () => {
  setup('');
  const paragraphs = Array.from({ length: 2000 }, () => `<p>${'Berlin 😀 '.repeat(75)}</p>`).join('');
  const xml = `<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc/></teiHeader><text><body>${paragraphs}</body></text></TEI>`;
  const original = parseXML(xml);
  const text = original.text();
  const entries = Array.from({ length: 61683 }, (_, i) => ({
    text: 'Berlin', startIndex: Math.floor(i * 150000 / 61683) * 10,
    endIndex: Math.floor(i * 150000 / 61683) * 10 + 6,
    localizedTag: 'Location', inlineTag: 'placeName', attributes: {},
  }));
  const startedAt = Date.now();
  const { tei } = await nerToXML({ text, originalXML: xml, nerData: { entries } });
  const annotations = [...tei.matchAll(/<annotation\s[^>]*target="([^"]+)"/g)];
  assert.equal(annotations.length, entries.length);
  assert.equal((tei.match(/<category\s/g) || []).length, 1);
  assert.ok(tei.includes(`<body>${paragraphs}</body>`), 'source body markup must be unchanged');
  for (const i of [0, 1000, 21000, entries.length - 1]) {
    assert.equal(annotations[i][1], `${original.getXPointer(entries[i].startIndex)} ${original.getXPointer(entries[i].endIndex)}`);
  }
  console.log(JSON.stringify({ benchmark: 'bulk-61683', elapsedMs: Date.now() - startedAt, sourceBytes: Buffer.byteLength(xml), outputBytes: Buffer.byteLength(tei) }));
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
