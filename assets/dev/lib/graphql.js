/* GraphQL helpers (pure): standard introspection query, operation detection, type-ref printing. */

export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
    directives { name description locations args { ...InputValue } }
  }
}
fragment FullType on __Type {
  kind name description
  fields(includeDeprecated: true) { name description args { ...InputValue } type { ...TypeRef } isDeprecated deprecationReason }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
  possibleTypes { ...TypeRef }
}
fragment InputValue on __InputValue { name description type { ...TypeRef } defaultValue }
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } }
}`;

/** Find operations in a document (comments and strings ignored). → [{type, name}] */
export function findOperations(src) {
  const clean = String(src).replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/#[^\n]*/g, '');
  const ops = [];
  // depth-0 scanning: operations start at brace depth 0
  let depth = 0;
  const re = /[{}]|\b(query|mutation|subscription|fragment)\b(\s+([_A-Za-z]\w*))?/g;
  let m;
  while ((m = re.exec(clean))) {
    if (m[0] === '{') { if (depth === 0 && !ops.pending) ops.push({ type: 'query', name: null }); ops.pending = false; depth++; continue; }
    if (m[0] === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0) {
      if (m[1] !== 'fragment') ops.push({ type: m[1], name: m[3] || null });
      ops.pending = true;
    }
  }
  delete ops.pending;
  return ops;
}

export function typeRefToString(t) {
  if (!t) return '?';
  if (t.kind === 'NON_NULL') return typeRefToString(t.ofType) + '!';
  if (t.kind === 'LIST') return '[' + typeRefToString(t.ofType) + ']';
  return t.name || '?';
}
export function namedType(t) { while (t && t.ofType) t = t.ofType; return t && t.name; }

/** Build the request body. Throws on invalid variables JSON or a subscription. */
export function buildGraphQLBody({ query, variables, operationName }) {
  if (!String(query || '').trim()) throw new Error('Write a query first.');
  let vars;
  if (variables && variables.trim()) {
    try { vars = JSON.parse(variables); } catch (e) { throw new Error('Variables must be valid JSON: ' + e.message); }
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw new Error('Variables must be a JSON object, e.g. {"id": 1}');
  }
  const ops = findOperations(query);
  const chosen = operationName ? ops.find((o) => o.name === operationName) : ops.length === 1 ? ops[0] : null;
  if (operationName && !chosen) throw new Error(`No operation named “${operationName}” in the document.`);
  if (!operationName && ops.length > 1) throw new Error(`The document has ${ops.length} operations — enter which one to run in “Operation name”.`);
  if (chosen && chosen.type === 'subscription') throw new Error('Subscriptions need a persistent WebSocket connection (graphql-ws protocol) and are not supported by this playground. Queries and mutations work.');
  const body = { query };
  if (vars) body.variables = vars;
  if (operationName) body.operationName = operationName;
  return body;
}
