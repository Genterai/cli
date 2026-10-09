import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collect, ms, render, specIds } from './test-report.mjs'

const ev = (type, data) => ({ type, data: { file: 'lib/a.test.js', line: 1, ...data } })
const run = [
  ev('test:start', { name: 'Anchors', nesting: 0 }),
  ev('test:start', { name: 'same call [spec:anchors/same-call-same-anchor]', nesting: 1 }),
  ev('test:pass', { name: 'same call [spec:anchors/same-call-same-anchor]', nesting: 1, details: { duration_ms: 3.2, type: 'test' } }),
  ev('test:start', { name: 'a | pipe', nesting: 1 }),
  ev('test:fail', {
    name: 'a | pipe',
    nesting: 1,
    line: 9,
    details: { duration_ms: 1500, type: 'test', error: { failureType: 'testCodeFailure', cause: { message: '1 == 2' } } },
  }),
  ev('test:fail', { name: 'Anchors', nesting: 0, details: { type: 'suite', error: { failureType: 'subtestsFailed' } } }),
  ev('test:start', { name: 'later', nesting: 0 }),
  ev('test:pass', { name: 'later', nesting: 0, skip: true, details: { duration_ms: 0, type: 'test' } }),
  ev('test:diagnostic', { message: 'duration_ms 2000', nesting: 0 }),
]

test('a run folds into tests with their suites, status and time; suites are not tests', () => {
  const { tests, duration } = collect(run)
  assert.equal(duration, 2000)
  assert.deepEqual(
    tests.map((t) => [t.suites.join('/'), t.name, t.status]),
    [
      ['Anchors', 'same call [spec:anchors/same-call-same-anchor]', 'pass'],
      ['Anchors', 'a | pipe', 'fail'],
      ['', 'later', 'skip'],
    ],
  )
  assert.equal(tests[1].error, '1 == 2')
})

test('a file that does not load is one failed entry with what it printed', () => {
  const file = `${process.cwd()}/lib/b.test.js`
  const { tests } = collect([
    { type: 'test:stderr', data: { file, message: 'Error: cannot load\n    at node:internal/x\n' } },
    { type: 'test:fail', data: { file, name: file, nesting: 0, details: { type: 'test', error: { failureType: 'testCodeFailure' } } } },
  ])
  assert.deepEqual(tests.map((t) => [t.file, t.name, t.status, t.error]), [['lib/b.test.js', '(the file did not load)', 'fail', 'Error: cannot load']])
})

test('the report leads with the verdict, then the failures, the statements, the slowest and every test', () => {
  const md = render(collect(run))
  assert.match(md.split('\n')[0], /^## ❌ Тесты: 1 из 2 упали · 2\.00 s$/)
  assert.match(md, /\| 1 \| 1 \| 1 \| 1 \| 2\.00 s \|/)
  assert.match(md, /### Что упало[\s\S]*<code>lib\/a\.test\.js:9<\/code> Anchors › a \\\| pipe[\s\S]*1 == 2/)
  assert.match(md, /\| ✅ \| `anchors\/same-call-same-anchor` \| 1 \| 3 ms \|/)
  assert.match(md, /Тестов без пункта спека.*: 2 из 3/)
  assert.match(md, /### Самые медленные\n\n.*\n.*\n\| 1\.50 s \| Anchors › a \\\| pipe \|/)
  assert.match(md, /<details open><summary>❌ <code>lib\/a\.test\.js<\/code> — 3 · 1\.50 s<\/summary>/)
  assert.ok(md.indexOf('Что упало') < md.indexOf('Пункты спеков'))
})

test('a run with no failures says so in its first line', () => {
  const md = render(collect(run.filter((e) => e.data.name !== 'a | pipe')))
  assert.match(md.split('\n')[0], /^## ✅ Тесты: все 1 прошли/)
  assert.doesNotMatch(md, /Что упало/)
})

test('spec ids are full statement ids in [spec:...] tags; times read as ms or s', () => {
  assert.deepEqual(specIds('x [spec:a/b-c] [spec:d-e/f] [spec:nope]'), ['a/b-c', 'd-e/f'])
  assert.deepEqual([ms(null), ms(0.2), ms(12.4), ms(1234), ms(12345)], ['—', '<1 ms', '12 ms', '1.23 s', '12.3 s'])
})
