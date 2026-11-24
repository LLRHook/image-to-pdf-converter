# datatree engine

json ⇄ yaml ⇄ xml (all six directions). yaml 2.9.1, fast-xml-parser 5.12.1. (JSON → CSV/XLSX lives in the `sheet` engine.)

## XML ⇄ data mapping

```
<item id="1">A</item>      { "item": { "@_id": "1", "#text": "A" } }
<item>A</item>             { "item": "A" }                   only text
<e/>                       { "e": "" }
<i>1</i><i>2</i>           { "i": ["1", "2"] }               repeated siblings
<x:t xmlns:x="u">v</x:t>   { "x:t": { "@_xmlns:x": "u", "#text": "v" } }
```
* attributes are `@_name` keys (listed first), element text beside attributes is `#text`, every value stays a string, the root element is the single top-level key
* dropped: comments, processing instructions, XML declaration, DTDs, the order of differently-named siblings and text mixed between elements
* JSON/YAML → XML: one top-level key (not an array, not `@_`/`#text`) is the root, otherwise the data is wrapped in `<root>` (`options.rootName`); arrays at the top become `<item>` children; `null`, `""`, `[]`, `{}` become empty elements; keys that are not XML names are renamed (`a b` → `a_b`, `2nd` → `_2nd`) and the count is logged; text with characters XML 1.0 cannot hold (U+0000…, lone surrogates) is rejected

## Fidelity

* JSON ⇄ YAML: lossless apart from YAML comments, anchors (expanded), merge keys (expanded), non-string keys (stringified); multi-document YAML → JSON array; YAML output is written in YAML 1.1 mode so `yes/no/on/off`, `2001-12-14`, `007` … stay quoted for PyYAML-style readers. Integers beyond ±2^53 lose precision (a log line says so).
* XML ⇄ others: semantic.

## Safety

* YAML: alias expansion is bounded (`maxAliasCount` 1000, product-based, so billion-laughs is rejected immediately); duplicate keys are errors; self-referencing aliases are rejected; `.inf`/`.nan` rejected.
* XML: well-formedness validated first (line/column in the error); external (`SYSTEM`/`PUBLIC`) and parameter entities rejected, entities defined through other entities rejected, ≤100 entities of ≤10,000 characters, ≤1,000 expansions / 1,000,000 characters; DTDs are never fetched; `<__proto__>` rejected.
* all: input ≤ 64 MB, depth ≤ 256, ≤ 10,000,000 values; iterative walkers, no recursion on hostile depth.
