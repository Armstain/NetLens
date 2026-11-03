const assert = require('assert');
const { detectFormat, parseStream, inferShape, eventTime, isStreamEntry } = require('./stream-format.js');

const sse = (objs) => objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');

{
  const raw = sse([
    { id: 'chatcmpl-abc123def456', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
    { id: 'chatcmpl-abc123def456', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hello' } }] },
    { id: 'chatcmpl-abc123def456', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: ', world' } }] },
    { id: 'chatcmpl-abc123def456', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]) + 'data: [DONE]\n\n';
  const p = parseStream(raw, { done: true });
  assert.strictEqual(p.format, 'sse');
  assert.strictEqual(p.events.length, 5);
  assert.ok(p.events[4].sentinel);
  const s = inferShape(p.events);
  assert.strictEqual(s.texts[0].path, 'choices[].delta.content');
  assert.strictEqual(s.texts[0].text, 'Hello, world');
  assert.strictEqual(s.collections.length, 0);
}

{
  const raw = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01XYZabcdefgh","model":"claude"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');
  const p = parseStream(raw, { done: true });
  assert.deepStrictEqual(p.events.map((e) => e.type), ['message_start', 'content_block_delta', 'content_block_delta', 'message_stop']);
  const s = inferShape(p.events);
  assert.strictEqual(s.texts[0].path, 'delta.text');
  assert.strictEqual(s.texts[0].text, 'Hi there');
  assert.strictEqual(s.types.content_block_delta, 2);
}

{
  const hotel = (id, sup, name) => ({ hotel_id: id, hotel_name: name, address: 'Dubai', distance_km: '3.2', supplier: { supplier_uid: sup, title: sup.toUpperCase() } });
  const raw = sse([
    { hotels: [hotel('H1', 'sa', 'Alpha'), hotel('H2', 'sa', 'Beta'), hotel('H3', 'sa', 'Gamma')] },
    { hotels: [hotel('H4', 'sb', 'Delta'), hotel('H2', 'sb', 'Beta')] },
    { hotels: [] },
  ]);
  const timeline = [[raw.indexOf('{"hotels":[{"hotel_id":"H4"'), 120], [raw.length, 900]];
  const p = parseStream(raw, { done: true, timeline });
  assert.strictEqual(p.events.length, 3);
  const s = inferShape(p.events);
  assert.strictEqual(s.texts.length, 0);
  const c = s.collections[0];
  assert.strictEqual(c.path, 'hotels');
  assert.strictEqual(c.total, 5);
  assert.strictEqual(c.keyField, 'hotel_id');
  assert.strictEqual(c.unique, 4);
  assert.strictEqual(c.duplicates, 1);
  assert.strictEqual(c.merged.length, 4);
  assert.strictEqual(c.groupBy, 'supplier.supplier_uid');
  assert.deepStrictEqual(c.groups.map((g) => [g.value, g.count]), [['sa', 3], ['sb', 2]]);
  assert.strictEqual(c.groups[0].firstT, 120);
  assert.strictEqual(c.groups[1].firstT, 900);
}

{
  const raw = '{"hotels":[{"hotel_id":"A"},{"hotel_id":"B"}]}\n{"hotels":[{"hotel_id":"C"},{"hotel_id":"D"}]}\n{"hot';
  assert.strictEqual(detectFormat(raw), 'ndjson');
  const live = parseStream(raw, { done: false });
  assert.strictEqual(live.events.length, 2);
  assert.strictEqual(live.rest, '{"hot');
}

{
  const raw = 'data: {"a":1}\r\ndata: {"a":2}\r\n\r\n: keepalive\r\n\r\nid: 7\r\nevent: tick\r\ndata: line one\r\ndata: line two\r\n\r\n';
  const p = parseStream(raw, { done: true });
  assert.strictEqual(p.events.length, 3);
  assert.deepStrictEqual(p.events.slice(0, 2).map((e) => e.json.a), [1, 2]);
  assert.strictEqual(p.events[2].data, 'line one\nline two');
  assert.strictEqual(p.events[2].type, 'tick');
  assert.strictEqual(p.events[2].id, '7');
}

{
  const p = parseStream('data: {"x":1}\n\ndata: {"x"', { done: false });
  assert.strictEqual(p.events.length, 1);
  assert.strictEqual(p.rest, 'data: {"x"');
}

{
  const raw = sse([{ text: 'He' }, { text: 'Hell' }, { text: 'Hello' }]);
  const s = inferShape(parseStream(raw, { done: true }).events);
  assert.strictEqual(s.texts[0].mode, 'snapshot');
  assert.strictEqual(s.texts[0].text, 'Hello');
}

{
  const raw = sse([{ candidates: [{ content: { parts: [{ text: 'Gem' }] } }] }, { candidates: [{ content: { parts: [{ text: 'ini' }] } }] }]);
  const s = inferShape(parseStream(raw, { done: true }).events);
  assert.strictEqual(s.texts[0].text, 'Gemini');
}

{
  const raw = 'data: {"a":1}\n\n';
  const p = parseStream(raw + 'data: {"a":2}\n\n', { done: true, timeline: [[raw.length, 10], [raw.length * 2, 4010]] });
  assert.deepStrictEqual(p.events.map((e) => e.t), [10, 4010]);
  const s = inferShape(p.events);
  assert.strictEqual(s.timing.maxGap, 4000);
  assert.strictEqual(eventTime([[5, 1]], 99), 1);
}

assert.strictEqual(detectFormat('plain old text'), 'text');
assert.ok(isStreamEntry({ contentType: 'text/event-stream;charset=UTF-8' }));
assert.ok(!isStreamEntry({ contentType: 'application/json' }));

console.log('All stream format assertions passed!');
