import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { XMLParser } from 'fast-xml-parser';
import { blobOf, bytesOf, testContext } from '../../core/testing';
import type { FormatId } from '../../core/formats';
import { expandEdges } from '../../core/graph';
import { edges, stagesFor } from './edges';
import engine from './engine';
import { analyze, outline } from './tree';
import { xmlName } from './xmlmap';

async function run(from: FormatId, to: FormatId, input: Uint8Array | string, options: Record<string, unknown> = {}) {
  const ctx = testContext();
  const result = await engine.convert({ input: blobOf(input), name: `in.${from}`, from, to, options }, ctx);
  const bytes = await bytesOf(result.output);
  return { result, ctx, bytes, text: new TextDecoder().decode(bytes) };
}
const j = async (from: FormatId, to: FormatId, input: string) => (await run(from, to, input)).text;
const toJson = async (from: FormatId, input: string) => JSON.parse(await j(from, 'json', input));

const SAMPLE = {
  name: 'Ann',
  age: 30,
  pi: 3.14159,
  neg: -7,
  ok: true,
  nothing: null,
  empty_list: [],
  empty_map: {},
  list: [1, 'two', { three: 3 }, [4, 5]],
  nested: { a: { b: { c: ['deep'] } } },
  unicode: 'café ☕ 日本語 😀',
  multiline: 'line1\nline2\n',
  lookalikes: ['yes', 'no', 'on', 'off', 'null', '~', 'true', '1.0', '007', '0x1F', '2001-12-14', '1e3', '', ' lead', 'trail ', 'a: b', '# not a comment', '- dash', "it's", 'say "hi"'],
  'key with spaces': 1,
  'yes': 'key that is a yaml 1.1 boolean',
  y: 'n',
};

/* ---------------------------------------------------------------- json <-> yaml */

describe('json <-> yaml', () => {
  it('json -> yaml -> json is lossless for the sample, including look-alike strings', async () => {
    const yaml = await j('json', 'yaml', JSON.stringify(SAMPLE));
    expect(await toJson('yaml', yaml)).toEqual(SAMPLE);
    // Also correct under YAML 1.1 rules (PyYAML-style readers): strings that look like booleans/dates stay quoted.
    expect(YAML.parse(yaml, { version: '1.1' })).toEqual(SAMPLE);
    expect(yaml).toContain('"on"');
    expect(yaml).toContain('"2001-12-14"');
  });

  it('yaml -> json -> yaml -> json is stable', async () => {
    const yaml = 'a: 1\nb:\n  - x\n  - {y: 2, z: [3, 4]}\nc: |\n  multi\n  line\nd: "quoted: yes"\n';
    const json1 = await j('yaml', 'json', yaml);
    const yaml2 = await j('json', 'yaml', json1);
    expect(await j('yaml', 'json', yaml2)).toBe(json1);
    expect(JSON.parse(json1)).toEqual({ a: 1, b: ['x', { y: 2, z: [3, 4] }], c: 'multi\nline\n', d: 'quoted: yes' });
  });

  it('does not wrap long lines and keeps key order', async () => {
    const long = 'word '.repeat(60).trim();
    const yaml = await j('json', 'yaml', JSON.stringify({ z: 1, a: long, m: 2 }));
    expect(yaml.split('\n')[1]).toContain(long);
    expect(Object.keys(await toJson('yaml', yaml))).toEqual(['z', 'a', 'm']);
  });

  it('YAML comments are dropped; anchors, aliases and merge keys are expanded', async () => {
    const yaml = '# top comment\nbase: &b {x: 1, y: 2} # trailing\nderived:\n  <<: *b\n  y: 3\nlist: &l [1, 2]\ncopy: *l\n';
    expect(await toJson('yaml', yaml)).toEqual({ base: { x: 1, y: 2 }, derived: { x: 1, y: 3 }, list: [1, 2], copy: [1, 2] });
  });

  it('multi-document YAML becomes an array; a single document stays itself', async () => {
    const out = await run('yaml', 'json', 'a: 1\n---\nb: 2\n---\n- 3\n');
    expect(JSON.parse(out.text)).toEqual([{ a: 1 }, { b: 2 }, [3]]);
    expect(out.ctx.logs.join(' ')).toMatch(/3 documents/);
    expect(await toJson('yaml', '---\na: 1\n')).toEqual({ a: 1 });
    expect(await toJson('yaml', '# only a comment\n')).toBeNull();
  });

  it('YAML core schema: dates and yes/no stay strings, ints and floats are numbers', async () => {
    expect(await toJson('yaml', 'd: 2001-12-14\nt: yes\ni: 0x1F\nf: 1e3\nn: ~\nb: true\n')).toEqual({ d: '2001-12-14', t: 'yes', i: 31, f: 1000, n: null, b: true });
  });

  it('own "__proto__" / "constructor" keys survive and pollute nothing', async () => {
    const json = '{"__proto__": {"polluted": true}, "constructor": 1, "a": 2}';
    const yaml = await j('json', 'yaml', json);
    const back = JSON.parse(await j('yaml', 'json', yaml));
    expect(Object.keys(back)).toEqual(['__proto__', 'constructor', 'a']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects billion-laughs YAML quickly', async () => {
    let yaml = 'a0: &a0 [x, x, x, x, x, x, x, x, x]\n';
    for (let i = 1; i < 10; i++) yaml += `a${i}: &a${i} [${Array(9).fill(`*a${i - 1}`).join(', ')}]\n`;
    const t0 = Date.now();
    await expect(run('yaml', 'json', yaml)).rejects.toThrow(/billion laughs/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a self-referencing alias is rejected, not looped on', async () => {
    await expect(run('yaml', 'json', 'a: &x\n  b: *x\n')).rejects.toThrow(/refers back to itself|circular/i);
  });

  it('reports YAML syntax errors with a line number; duplicate keys are errors', async () => {
    await expect(run('yaml', 'json', 'a: [1, 2\nb: 3\n')).rejects.toThrow(/not valid YAML.*line \d+/);
    await expect(run('yaml', 'json', 'a: 1\na: 2\n')).rejects.toThrow(/unique.*line 2/);
  });

  it('rejects values JSON cannot hold (.inf, .nan)', async () => {
    await expect(run('yaml', 'json', 'a: .inf\n')).rejects.toThrow(/Infinity/);
    await expect(run('yaml', 'json', 'a: .nan\n')).rejects.toThrow(/NaN/);
  });

  it('rejects data nested deeper than the limit, for every input type', async () => {
    const deep = (n: number) => '['.repeat(n) + ']'.repeat(n);
    await expect(run('json', 'yaml', deep(300))).rejects.toThrow(/nested/);
    await expect(run('yaml', 'json', deep(300))).rejects.toThrow(/nested/);
    await expect(run('json', 'xml', deep(100_000))).rejects.toThrow(/nested/);
    expect((await run('json', 'yaml', deep(200))).text.length).toBeGreaterThan(0);
  });

  it('warns when integers exceed 2^53', async () => {
    const out = await run('json', 'yaml', '{"big": 12345678901234567890, "ok": 9007199254740991}');
    expect(out.ctx.logs.join(' ')).toMatch(/larger than 2\^53/);
    expect((await run('json', 'yaml', '{"ok": 9007199254740991}')).ctx.logs).toEqual([]);
  });

  it('rejects invalid and empty input clearly', async () => {
    await expect(run('json', 'yaml', '{oops')).rejects.toThrow(/not valid JSON/);
    await expect(run('json', 'yaml', '   \n')).rejects.toThrow(/empty/);
    await expect(run('yaml', 'json', '')).rejects.toThrow(/empty/);
  });

  it('strips a UTF-8 BOM', async () => {
    const out = await run('json', 'yaml', new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]));
    expect(out.text).toBe('a: 1\n');
  });
});

/* ------------------------------------------------------------------- xml -> data */

const XML_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!-- catalog -->
<catalog xmlns:x="urn:x" id="c1">
  <book id="b1" lang="en">
    <title>Dune &amp; Sons</title>
    <price currency="USD">9.99</price>
    <tag>a</tag>
    <tag>b</tag>
  </book>
  <book id="b2"><title>Café &#233; &#x41;</title><empty/><note><![CDATA[<raw> & text]]></note></book>
  <x:meta>m</x:meta>
</catalog>`;

describe('xml -> json / yaml', () => {
  it('maps attributes, text, repeated elements, empties, CDATA, namespaces and entities as documented', async () => {
    expect(await toJson('xml', XML_SAMPLE)).toEqual({
      catalog: {
        '@_xmlns:x': 'urn:x',
        '@_id': 'c1',
        book: [
          { '@_id': 'b1', '@_lang': 'en', title: 'Dune & Sons', price: { '@_currency': 'USD', '#text': '9.99' }, tag: ['a', 'b'] },
          { '@_id': 'b2', title: 'Café é A', empty: '', note: '<raw> & text' },
        ],
        'x:meta': 'm',
      },
    });
  });

  it('attributes are listed first, then text, then children', async () => {
    const out = JSON.parse(await j('xml', 'json', '<a><b z="1" y="2">t<c/></b></a>'));
    expect(Object.keys(out.a.b)).toEqual(['@_z', '@_y', '#text', 'c']);
  });

  it('values stay strings (no number/boolean guessing)', async () => {
    expect(await toJson('xml', '<r><n>007</n><t>true</t><f>1.50</f></r>')).toEqual({ r: { n: '007', t: 'true', f: '1.50' } });
  });

  it('does not double-decode &amp;#65;', async () => {
    expect(await toJson('xml', '<a>&amp;#65; &#65;</a>')).toEqual({ a: '&#65; A' });
  });

  it('expands simple internal DTD entities', async () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE note [<!ENTITY w "Walter">]><note>&w; wrote this</note>';
    expect(await toJson('xml', xml)).toEqual({ note: 'Walter wrote this' });
  });

  it('accepts a DOCTYPE that points at an external DTD without ever fetching it', async () => {
    const xml = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist><k>v</k></plist>';
    expect(await toJson('xml', xml)).toEqual({ plist: { k: 'v' } });
  });

  it('honours a declared legacy encoding', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><a>caf'), 0xe9, ...new TextEncoder().encode('</a>')]);
    expect(JSON.parse((await run('xml', 'json', bytes)).text)).toEqual({ a: 'café' });
  });

  it('yaml output of the same tree is equivalent', async () => {
    const asJson = await toJson('xml', XML_SAMPLE);
    expect(await toJson('yaml', await j('xml', 'yaml', XML_SAMPLE))).toEqual(asJson);
  });

  it('drops comments and processing instructions', async () => {
    const out = await j('xml', 'json', '<?xml version="1.0"?><?pi data?><!-- c --><a><!-- c2 -->x</a>');
    expect(JSON.parse(out)).toEqual({ a: 'x' });
  });

  describe('hostile XML', () => {
    it('refuses external entities (XXE) and never reads them', async () => {
      const xxe = '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>';
      await expect(run('xml', 'json', xxe)).rejects.toThrow(/external entities/i);
      await expect(run('xml', 'json', '<!DOCTYPE a [<!ENTITY x PUBLIC "p" "http://evil/x">]><a>&x;</a>')).rejects.toThrow(/external entities/i);
      await expect(run('xml', 'json', '<!DOCTYPE a [<!ENTITY % p "x">]><a/>')).rejects.toThrow(/parameter entities/i);
    });

    it('refuses nested entity definitions (billion laughs / quadratic blowup)', async () => {
      const lol = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol3;</lolz>';
      await expect(run('xml', 'json', lol)).rejects.toThrow(/entity in terms of another/i);
    });

    it('caps the expansion of a plain entity used many times', async () => {
      const big = 'x'.repeat(9000);
      const xml = `<!DOCTYPE a [<!ENTITY e "${big}">]><a>${'&e;'.repeat(500)}</a>`;
      const out = await run('xml', 'json', xml).then(
        (r) => JSON.parse(r.text).a as string,
        (e: Error) => e.message,
      );
      // either rejected, or expansion was cut off by the parser's length cap - never 4.5 MB of text
      expect(typeof out === 'string' ? out.length : 0).toBeLessThan(2_000_000);
    });

    it('rejects documents nested deeper than the limit', async () => {
      const deep = '<a>'.repeat(300) + 'x' + '</a>'.repeat(300);
      await expect(run('xml', 'json', deep)).rejects.toThrow(/nested|Maximum/i);
    });

    it('reports malformed XML with a position', async () => {
      await expect(run('xml', 'json', '<a><b></a>')).rejects.toThrow(/not valid XML.*line 1/);
      await expect(run('xml', 'json', '<a x=1/>')).rejects.toThrow(/not valid XML/);
      await expect(run('xml', 'json', 'just text')).rejects.toThrow(/not valid XML/);
    });

    it('a <__proto__> element cannot pollute prototypes', async () => {
      await expect(run('xml', 'json', '<a><__proto__>x</__proto__></a>')).rejects.toThrow(/reserved|proto/i);
      expect(({} as Record<string, unknown>).x).toBeUndefined();
    });
  });
});

/* --------------------------------------------------------------- json/yaml -> xml */

describe('json / yaml -> xml', () => {
  const parse = (xml: string) => new XMLParser({ ignoreAttributes: false, parseTagValue: false, ignoreDeclaration: true }).parse(xml);

  it('a single top-level key is the root; @_ keys are attributes, #text is text', async () => {
    const out = await run('json', 'xml', '{"book":{"@_id":"1","title":"T","price":{"@_cur":"USD","#text":"9.99"},"tag":["a","b"],"gap":null,"s":""}}');
    expect(out.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<book id="1">')).toBe(true);
    expect(parse(out.text)).toEqual({ book: { title: 'T', price: { '#text': '9.99', '@_cur': 'USD' }, tag: ['a', 'b'], gap: '', s: '', '@_id': '1' } });
    expect(out.ctx.logs).toEqual([]);
  });

  it('wraps data without a single root in <root> and says so', async () => {
    const out = await run('json', 'xml', '{"a":1,"b":[true,null]}');
    expect(parse(out.text)).toEqual({ root: { a: '1', b: ['true', ''] } });
    expect(out.ctx.logs.join(' ')).toMatch(/wrapped in <root>/);
    expect(parse((await run('json', 'xml', '{"a":1,"b":2}', { rootName: 'data' })).text)).toEqual({ data: { a: '1', b: '2' } });
  });

  it('arrays and scalars at the top level become <item> children / text', async () => {
    expect(parse((await run('json', 'xml', '[1,"x",{"k":"v"},[2,3]]')).text)).toEqual({ root: { item: ['1', 'x', { k: 'v' }, { item: ['2', '3'] }] } });
    expect(parse((await run('json', 'xml', '"hello"')).text)).toEqual({ root: 'hello' });
    expect(parse((await run('json', 'xml', '42')).text)).toEqual({ root: '42' });
  });

  it('a top-level object with a single array value is wrapped (arrays cannot be the root)', async () => {
    expect(parse((await run('json', 'xml', '{"items":[1,2]}')).text)).toEqual({ root: { items: ['1', '2'] } });
  });

  it('escapes markup characters in text and attributes', async () => {
    const out = (await run('json', 'xml', JSON.stringify({ r: { '@_a': 'x"<&\'', t: 'a < b & c > d "q"' } }))).text;
    expect(out).not.toMatch(/<t>[^<]*[<&]\s/);
    expect(parse(out)).toEqual({ r: { '@_a': 'x"<&\'', t: 'a < b & c > d "q"' } });
  });

  it('renames keys that are not valid XML names, and reports it', async () => {
    const out = await run('json', 'xml', JSON.stringify({ r: { 'first name': 1, '2nd': 2, 'a/b': 3, 'ok-name': 4, '': 5, 'x:y': 6 } }));
    expect(parse(out.text).r).toEqual({ first_name: '1', _2nd: '2', a_b: '3', 'ok-name': '4', _: '5', 'x:y': '6' });
    expect(out.ctx.logs.join(' ')).toMatch(/4 key\(s\) were renamed/);
    expect(xmlName('a b')).toBe('a_b');
    expect(xmlName('9x')).toBe('_9x');
    expect(xmlName('日本語')).toBe('日本語');
  });

  it('keeps sibling names unique when sanitising would collide', async () => {
    const xml = (await run('json', 'xml', JSON.stringify({ r: { 'a b': 1, a_b: 2 } }))).text;
    const r = parse(xml).r;
    expect(Object.keys(r).sort()).toEqual(['a_b', 'a_b_2']);
  });

  it('rejects characters XML 1.0 cannot hold', async () => {
    await expect(run('json', 'xml', JSON.stringify({ r: 'bad \u0001 char' }))).rejects.toThrow(/U\+0001/);
    await expect(run('json', 'xml', JSON.stringify({ r: 'lone \ud800' }))).rejects.toThrow(/XML 1\.0/);
    expect(parse((await run('json', 'xml', JSON.stringify({ r: 'ok \u0009 \n 😀' }))).text).r).toContain('😀');
  });

  it('keeps empty arrays and objects as empty elements instead of dropping them', async () => {
    expect(parse((await run('json', 'xml', '{"r":{"a":[],"b":{},"c":[[]]}}')).text).r).toEqual({ a: '', b: '', c: { item: '' } });
  });

  it('yaml -> xml uses the same mapping', async () => {
    const out = await run('yaml', 'xml', 'book:\n  "@_id": b1\n  title: T\n  tags: [a, b]\n');
    expect(parse(out.text)).toEqual({ book: { title: 'T', tags: ['a', 'b'], '@_id': 'b1' } });
  });

  it('xml -> json -> xml reproduces the document semantically', async () => {
    const json = await j('xml', 'json', XML_SAMPLE);
    const xml = await j('json', 'xml', json);
    expect(await toJson('xml', xml)).toEqual(await toJson('xml', XML_SAMPLE));
  });

  it('xml -> yaml -> xml and yaml -> xml -> yaml are stable', async () => {
    const yaml = await j('xml', 'yaml', XML_SAMPLE);
    expect(await toJson('xml', await j('yaml', 'xml', yaml))).toEqual(await toJson('xml', XML_SAMPLE));
    const y2 = 'doc:\n  "@_v": "1"\n  item: [a, b]\n  deep:\n    k: v\n';
    expect(await toJson('yaml', await j('xml', 'yaml', await j('yaml', 'xml', y2)))).toEqual(await toJson('yaml', y2));
  });

  it('json -> xml -> json gives strings (XML has no types) but the same shape', async () => {
    const back = await toJson('xml', await j('json', 'xml', '{"r":{"n":1,"b":true,"s":"x","l":[1,2]}}'));
    expect(back).toEqual({ r: { n: '1', b: 'true', s: 'x', l: ['1', '2'] } });
  });
});

/* ---------------------------------------------------------------- facts/preview */

describe('facts, preview and progress', () => {
  it('analyze counts nodes and depth', () => {
    expect(analyze(1)).toMatchObject({ nodes: 1, depth: 1 });
    expect(analyze({ a: { b: 1 } })).toMatchObject({ nodes: 3, depth: 3 });
    expect(analyze({ a: [1, 2, [3]], b: 'x' })).toMatchObject({ nodes: 7, depth: 4 });
    const shared = { z: 1 };
    expect(analyze({ a: shared, b: shared })).toMatchObject({ nodes: 5 }); // shared (aliased) values count per use
  });

  it('emits real tree facts and an outline of top-level keys', async () => {
    const out = await run('json', 'yaml', JSON.stringify({ users: [{ n: 'a' }, { n: 'b' }], meta: { v: 1 }, title: 'T' }));
    expect(out.ctx.factsSeen).toEqual([{ kind: 'tree', nodes: 9, depth: 4 }]);
    const p = out.ctx.previews[0]!;
    expect(p.kind).toBe('outline');
    if (p.kind === 'outline') {
      expect(p.items[0]).toEqual({ level: 0, text: 'users [2 items]' });
      expect(p.items.map((i) => i.level)).toContain(1);
      expect(p.items.length).toBeLessThanOrEqual(40);
      expect(p.items.every((i) => i.text.length <= 80)).toBe(true);
    }
  });

  it('outline of an XML root lists its children', async () => {
    const out = await run('xml', 'json', '<root><a>1</a><b x="1"><c>2</c></b></root>');
    const p = out.ctx.previews[0]!;
    expect(p.kind === 'outline' && p.items.map((i) => `${i.level}:${i.text}`)).toEqual(['0:root {2 keys}', '1:a: "1"', '1:b {2 keys}', '2:@_x: "1"', '2:c: "2"']);
  });

  it('outline is capped and clips long text', () => {
    const big = outline(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, { a: 1, b: 2, c: 3, d: 4, e: 5 }])));
    expect(big.length).toBeLessThanOrEqual(40);
    const clipped = outline({ k: 'x'.repeat(500) });
    expect(clipped[0]!.text.length).toBeLessThanOrEqual(80);
  });

  it('progress is measured: read bytes, and XML mapping by nodes; never above 1', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, name: `n${i}`, tags: ['a', 'b'] }));
    const out = await run('json', 'xml', JSON.stringify({ rows }));
    expect(out.ctx.progressValues.length).toBeGreaterThan(1);
    expect(out.ctx.progressValues.every((v) => v >= 0 && v <= 1)).toBe(true);
    const yaml = await run('json', 'yaml', JSON.stringify({ rows }));
    // json -> yaml reports only the read stage's progress; it never invents any for parse/encode
    expect(yaml.ctx.stages).toEqual(['read', 'decode', 'encode']);
  });
});

/* -------------------------------------------------------------------- edges */

describe('edges', () => {
  const hops = expandEdges(edges.map((e) => ({ ...e, engine: 'datatree' })));

  it('declares exactly the six json/yaml/xml directions, nothing for tables', () => {
    expect(hops.map((h) => `${h.from}->${h.to}`).sort()).toEqual(
      ['json->yaml', 'json->xml', 'yaml->json', 'yaml->xml', 'xml->json', 'xml->yaml'].sort(),
    );
    expect(hops.some((h) => ['csv', 'tsv', 'xlsx', 'ods', 'xls'].includes(h.to) || ['csv', 'tsv', 'xlsx', 'ods', 'xls'].includes(h.from))).toBe(false);
    expect(hops.some((h) => h.mayBundle)).toBe(false);
  });

  it('fidelity: json<->yaml lossless, anything with xml semantic; notes say what is dropped', () => {
    const by = (a: string, b: string) => hops.find((h) => h.from === a && h.to === b)!;
    expect(by('json', 'yaml').fidelity).toBe('lossless');
    expect(by('yaml', 'json').fidelity).toBe('lossless');
    for (const [a, b] of [['json', 'xml'], ['xml', 'json'], ['yaml', 'xml'], ['xml', 'yaml']] as const) expect(by(a, b).fidelity).toBe('semantic');
    expect(by('yaml', 'json').note).toMatch(/comments are dropped/i);
    expect(by('yaml', 'xml').note).toMatch(/comments are dropped/i);
    expect(by('json', 'xml').note).toMatch(/<root>/);
    expect(by('xml', 'json').note).toMatch(/@_name/);
    expect(by('json', 'yaml').note).toBeUndefined();
  });

  it('every pair reports exactly the declared stages, in order, with facts and a preview', async () => {
    const fixtures: Record<string, string> = {
      json: '{"catalog":{"@_id":"1","book":[{"title":"A"},{"title":"B"}]}}',
      yaml: 'catalog:\n  "@_id": "1"\n  book:\n    - title: A\n    - title: B\n',
      xml: '<catalog id="1"><book><title>A</title></book><book><title>B</title></book></catalog>',
    };
    for (const h of hops) {
      const { ctx, result } = await run(h.from, h.to, fixtures[h.from]!);
      expect(ctx.stages, `${h.from}->${h.to}`).toEqual(stagesFor(h.from, h.to).map((s) => s.id));
      expect(h.stages.map((s) => s.id)).toEqual(ctx.stages);
      expect(result.ext).toBe(h.to === 'yaml' ? 'yaml' : h.to);
      expect(ctx.factsSeen).toHaveLength(1);
      expect(ctx.previews).toHaveLength(1);
      expect(new Set(h.stages.map((s) => s.label)).size).toBe(h.stages.length);
    }
  });
});
