import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, idsOf } from './spec-check.mjs'

const P = [/^app\//, /^lib\//]
test('non-product change passes', () => assert.ok(check(['README.md'], '', P).ok))
test('product change without line fails', () => assert.ok(!check(['lib/a.js'], 'fix', P).ok))
test('none with reason passes', () => assert.ok(check(['lib/a.js'], 'x\nSpecs: none - internal refactor', P).ok))
test('none without reason fails', () => assert.ok(!check(['lib/a.js'], 'Specs: none', P).ok))
test('updated with link passes', () => assert.ok(check(['app/x.js'], '- [x] Specs: updated https://github.com/Genterai/specs/pull/3', P).ok))
test('updated without link fails', () => assert.ok(!check(['app/x.js'], 'Specs: updated', P).ok))
test('unchecked template placeholder fails', () => assert.ok(!check(['app/x.js'], 'Specs: <updated|none>', P).ok))
test('implements one statement id passes', () => assert.ok(check(['lib/a.js'], 'Specs: implements agents/account-wide-limit', P).ok))
test('implements several ids, with commas or backticks, passes', () =>
  assert.ok(check(['lib/a.js'], 'Specs: implements `agents/account-wide-limit`, mcp/fact-area', P).ok))
test('implements without ids fails', () => assert.ok(!check(['lib/a.js'], 'Specs: implements', P).ok))
test('implements a spec without a statement fails', () => assert.ok(!check(['lib/a.js'], 'Specs: implements agents', P).ok))
test('implements a template placeholder fails', () =>
  assert.ok(!check(['lib/a.js'], 'Specs: implements <spec-id/statement-id>, <spec-id/statement-id>', P).ok))
test('implements with an id that is not kebab-case fails', () => assert.ok(!check(['lib/a.js'], 'Specs: implements Agents/Limit', P).ok))
test('idsOf returns the ids in order', () => assert.deepEqual(idsOf('a-b/c-d, e/f'), ['a-b/c-d', 'e/f']))
