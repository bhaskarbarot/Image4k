import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecText, analyze, schemaTree, exampleFor, resolvePointer, groupByTag, searchOps } from '../../assets/dev/lib/openapi.js';

const OAS30 = `
openapi: 3.0.3
info: { title: Shop, version: '1.0' }
servers: [{ url: 'https://api.shop.test/v1' }]
tags: [{ name: items, description: Catalogue }]
paths:
  /items:
    get:
      tags: [items]
      operationId: listItems
      parameters:
        - $ref: '#/components/parameters/Limit'
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Item' } }
  /items/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: integer } }
    delete:
      tags: [items]
      operationId: deleteItem
      deprecated: true
      security: [{ key: [] }]
      responses: { '204': { description: deleted } }
components:
  securitySchemes:
    key: { type: apiKey, in: header, name: X-Key }
  parameters:
    Limit: { name: limit, in: query, schema: { type: integer, default: 20 } }
  schemas:
    Item:
      type: object
      required: [id]
      properties:
        id: { type: integer, example: 7 }
        name: { type: string }
        parent: { $ref: '#/components/schemas/Item' }
`;

test('OpenAPI 3.0: parses YAML, no issues, operations normalized', () => {
  const m = analyze(parseSpecText(OAS30));
  assert.equal(m.kind, 'openapi30');
  assert.deepEqual(m.issues, []);
  assert.equal(m.operations.length, 2);
  const list = m.operations.find((o) => o.operationId === 'listItems');
  assert.deepEqual(list.parameters.map((p) => [p.name, p.in, p.type]), [['limit', 'query', 'integer']]);
  assert.equal(list.responses[0].content[0].mediaType, 'application/json');
  const del = m.operations.find((o) => o.operationId === 'deleteItem');
  assert.equal(del.deprecated, true);
  assert.deepEqual(del.parameters.map((p) => p.name), ['id']); // path-level parameter inherited
  assert.equal(m.servers[0].url, 'https://api.shop.test/v1');
  assert.equal(m.securitySchemes[0].paramName, 'X-Key');
});

test('recursive $ref schemas are marked circular, not expanded forever', () => {
  const spec = parseSpecText(OAS30);
  const tree = schemaTree(spec, { $ref: '#/components/schemas/Item' });
  const parent = tree.children.find((c) => c.name === 'parent');
  assert.equal(parent.circular, true);
  assert.equal(tree.children.find((c) => c.name === 'id').required, true);
  const ex = exampleFor(spec, { $ref: '#/components/schemas/Item' });
  assert.equal(ex.id, 7);
  assert.equal(ex.parent, '<recursive>');
});

test('direct $ref cycle (A → B → A) does not hang', () => {
  const spec = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {}, components: { schemas: { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' } } } };
  const t = schemaTree(spec, { $ref: '#/components/schemas/A' });
  assert.equal(t.circular, true);
  assert.equal(exampleFor(spec, { $ref: '#/components/schemas/A' }), '<recursive>');
});

test('OpenAPI 3.1: JSON input, type arrays, webhooks-only spec allowed without paths', () => {
  const m = analyze(parseSpecText(JSON.stringify({ openapi: '3.1.0', info: { title: 'W', version: '2' }, webhooks: {}, components: { schemas: { N: { type: ['string', 'null'] } } } })));
  assert.equal(m.kind, 'openapi31');
  assert.equal(m.issues.filter((i) => i.level === 'error').length, 0);
  assert.equal(schemaTree(m.root, { $ref: '#/components/schemas/N' }).type, 'string | null');
});

test('Swagger 2.0: body/formData params become request bodies, host+basePath → servers, securityDefinitions', () => {
  const spec = {
    swagger: '2.0', info: { title: 'Pets', version: '1' }, host: 'pets.test', basePath: '/v2', schemes: ['https'],
    consumes: ['application/json'], produces: ['application/json'],
    securityDefinitions: { basic: { type: 'basic' }, oauth: { type: 'oauth2', flow: 'implicit', authorizationUrl: 'https://auth.test', scopes: { read: 'Read' } } },
    paths: {
      '/pets': { post: { parameters: [{ in: 'body', name: 'pet', required: true, schema: { $ref: '#/definitions/Pet' } }], responses: { 201: { description: 'ok', schema: { $ref: '#/definitions/Pet' } } } } },
      '/pets/{id}/photo': { post: { parameters: [{ in: 'path', name: 'id', required: true, type: 'integer' }, { in: 'formData', name: 'file', type: 'file', required: true }], responses: { 200: { description: 'ok' } } } },
    },
    definitions: { Pet: { type: 'object', properties: { name: { type: 'string' } } } },
  };
  const m = analyze(spec);
  assert.equal(m.kind, 'swagger2');
  assert.deepEqual(m.issues, []);
  assert.equal(m.servers[0].url, 'https://pets.test/v2');
  const post = m.operations.find((o) => o.path === '/pets');
  assert.equal(post.requestBody.required, true);
  assert.equal(post.requestBody.content[0].mediaType, 'application/json');
  assert.equal(post.responses[0].content[0].schema.$ref, '#/definitions/Pet');
  const photo = m.operations.find((o) => o.path === '/pets/{id}/photo');
  assert.equal(photo.requestBody.content[0].mediaType, 'multipart/form-data');
  assert.deepEqual(photo.parameters.map((p) => p.name), ['id']);
  assert.equal(m.securitySchemes.find((s) => s.name === 'basic').scheme, 'basic');
  assert.ok(m.securitySchemes.find((s) => s.name === 'oauth').flows.implicit);
});

test('invalid documents produce precise errors', () => {
  const m = analyze({
    openapi: '3.0.1', info: { title: '' },
    paths: {
      'items': { get: { responses: { 200: { description: 'x' } } } },
      '/a/{id}': { get: { operationId: 'dup', parameters: [{ name: 'other', in: 'path', required: true }], responses: { 200: { description: 'x' } } }, fetch: {} },
      '/b': { post: { operationId: 'dup', parameters: [{ name: 'q', in: 'body' }, { name: 'q', in: 'body' }], responses: { abc: { $ref: '#/components/responses/Nope' } } } },
      '/c': { get: { security: [{ ghost: [] }] } },
      '/d': { put: { responses: { 200: { description: 'x', content: { 'application/json': { schema: { $ref: 'other.yaml#/X' } } } } } } },
    },
  });
  const msgs = m.issues.map((i) => i.level + ': ' + i.message).join('\n');
  for (const re of [/error: Missing required "info.title"/, /error: Missing required "info.version"/, /error: Path "items" must start with "\/"/,
    /error: Path parameter \{id\} is used in the path but not declared/, /error: Path parameter "other" is declared but not used/,
    /warning: "fetch" is not a valid HTTP method/, /error: Duplicate operationId "dup"/, /error: Parameter "q" has invalid location in: "body"/,
    /error: Duplicate parameter "q"/, /warning: Response key "abc"/, /error: Response abc \$ref #\/components\/responses\/Nope cannot be resolved/,
    /error: Security requirement uses undefined scheme "ghost"/, /error: Operation has no "responses"/, /warning: External \$ref "other.yaml#\/X"/]) {
    assert.match(msgs, re);
  }
});

test('non-OpenAPI and parse errors', () => {
  assert.match(analyze({ foo: 1 }).issues[0].message, /does not look like an OpenAPI/);
  assert.throws(() => parseSpecText('{"openapi": "3.0.0",}'), /Trailing comma/);
  assert.throws(() => parseSpecText('openapi: 3.0.0\n info: x\n  bad'), /line/i);
  assert.throws(() => parseSpecText(''), /Paste/);
  assert.throws(() => parseSpecText('a: 1\n---\nb: 2'), /several documents/);
});

test('JSON pointer escaping (~1, ~0) in $ref', () => {
  const spec = { paths: { '/a/b': { x: 1 } }, 'c~d': 2 };
  assert.equal(resolvePointer(spec, '#/paths/~1a~1b/x').value, 1);
  assert.equal(resolvePointer(spec, '#/c~0d').value, 2);
  assert.ok(resolvePointer(spec, '#/nope').missing);
});

test('grouping by tag and search', () => {
  const m = analyze(parseSpecText(OAS30));
  assert.deepEqual(groupByTag(m).map((g) => g.tag), ['items']);
  assert.equal(searchOps(m, 'deleteitem').length, 1);
  assert.equal(searchOps(m, '/items').length, 2);
  assert.equal(searchOps(m, 'zzz').length, 0);
});

test('large spec (2000 operations) analyzes quickly', () => {
  const paths = {};
  for (let i = 0; i < 1000; i++) paths['/r' + i + '/{id}'] = { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], get: { operationId: 'g' + i, responses: { 200: { description: 'ok' } } }, delete: { operationId: 'd' + i, responses: { 204: { description: 'ok' } } } };
  const t0 = performance.now();
  const m = analyze({ openapi: '3.0.0', info: { title: 'big', version: '1' }, paths });
  assert.equal(m.operations.length, 2000);
  assert.deepEqual(m.issues, []);
  assert.ok(performance.now() - t0 < 2000);
});
