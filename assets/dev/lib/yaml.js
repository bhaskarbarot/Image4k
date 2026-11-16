/* YAML ⇄ JSON using js-yaml 4.1.1 (MIT, self-hosted). js-yaml 4 `load` is safe by default:
 * it never constructs JavaScript functions/regexps/classes from YAML tags. */
import yaml from '../../vendor/js-yaml-4.1.1/js-yaml.mjs';
import { parseJson } from './json.js';

export class YamlError extends Error {
  constructor(e) {
    const line = e.mark ? e.mark.line + 1 : null, col = e.mark ? e.mark.column + 1 : null;
    const reason = (e.reason || e.message || 'Invalid YAML').replace(/^./, (c) => c.toUpperCase());
    super(line ? `${reason} (line ${line}, column ${col})` : reason);
    this.name = 'YamlError'; this.reason = reason; this.line = line; this.col = col;
    this.snippet = e.mark && e.mark.snippet;
  }
}

/** Parse YAML (one or several '---' documents). Returns { value, docs } — value is an array when there are several docs. */
export function parseYaml(text) {
  try {
    const docs = [];
    yaml.loadAll(text, (d) => docs.push(d), { json: false });
    return { value: docs.length === 1 ? docs[0] : docs.length === 0 ? null : docs, docs: docs.length };
  } catch (e) {
    if (e.name === 'YAMLException') throw new YamlError(e);
    throw e;
  }
}

export function yamlToJson(text, indent = 2) {
  const { value } = parseYaml(text);
  return JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? v.toString() : v), indent === 'tab' ? '\t' : indent);
}

export function jsonToYaml(text, opts = {}) {
  const value = parseJson(text); // precise JSON errors
  return dumpYaml(value, opts);
}

export function dumpYaml(value, opts = {}) {
  return yaml.dump(value, {
    indent: Number(opts.indent) || 2,
    lineWidth: -1,        // never fold long strings
    noRefs: true,         // repeated objects are written out, not as &anchors
    sortKeys: !!opts.sortKeys,
    quotingType: '"',
  });
}
