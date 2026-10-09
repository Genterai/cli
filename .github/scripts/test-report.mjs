// Test report: a node:test reporter that writes one Markdown page about a run, for the job summary of
// .github/workflows/test.yml. The page says, at a glance, whether the run passed, then: what failed and why, each spec
// statement the tests verify ([spec:<spec-id>/<statement-id>] in a test's name) and whether its tests passed, the
// slowest tests, and every test of every file with its time.
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./.github/scripts/test-report.mjs --test-reporter-destination=test-report.md lib/*.test.js
// Run `node --test .github/scripts/test-report.test.mjs` to test.

const SPEC_TAG = /\[spec:([a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*)\]/g
const SLOWEST = 10

const icon = (t) => (t.status === 'fail' ? '❌' : t.status === 'skip' ? '⏭️' : t.status === 'todo' ? '📝' : '✅')
const cell = (s) => String(s).replace(/\s+/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').trim()
const relative = (file) => (file ? file.replace(`${process.cwd()}/`, '') : '?')

export function ms(n) {
  if (n == null) return '—'
  if (n < 1) return '<1 ms'
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`
}

export function specIds(name) {
  return [...name.matchAll(SPEC_TAG)].map((m) => m[1])
}

// Folds the reporter events into tests: one entry per test (not per suite), with its suites, file, status and time.
export function collect(events) {
  const tests = []
  const stacks = new Map()
  const stderr = new Map()
  let duration = null
  for (const { type, data } of events) {
    if (type === 'test:start') {
      const stack = stacks.get(relative(data.file)) ?? []
      stack[data.nesting] = data.name
      stack.length = data.nesting + 1
      stacks.set(relative(data.file), stack)
    } else if (type === 'test:pass' || type === 'test:fail') {
      const kind = data.details?.type
      // Node 20 wraps each file in a test named after its path, and Node 22 reports a file that fails outside its
      // tests (it does not load) the same way; it is the file, not a test.
      const isFile = data.nesting === 0 && data.file && relative(data.file).endsWith(relative(data.name))
      if (kind === 'suite' || isFile) {
        if (type === 'test:fail' && data.details?.error?.failureType !== 'subtestsFailed') {
          const failure = entry(data, 'fail', stacks, isFile)
          if (isFile && stderr.has(relative(data.file))) failure.error = withoutInternals(stderr.get(relative(data.file)))
          tests.push(failure)
        }
        continue
      }
      tests.push(entry(data, type === 'test:fail' ? 'fail' : data.skip ? 'skip' : data.todo ? 'todo' : 'pass', stacks))
    } else if (type === 'test:stderr' && data.file) {
      stderr.set(relative(data.file), (stderr.get(relative(data.file)) ?? '') + data.message)
    } else if (type === 'test:diagnostic' && data.nesting === 0) {
      const m = /^duration_ms ([\d.]+)/.exec(data.message)
      if (m) duration = Number(m[1])
    }
  }
  return { tests, duration }
}

function entry(data, status, stacks, isFile) {
  const file = relative(data.file)
  const suites = (stacks.get(file) ?? []).slice(0, data.nesting).filter((n) => relative(n) !== file)
  return {
    file,
    suites,
    name: isFile ? '(the file did not load)' : data.name,
    status,
    duration: data.details?.duration_ms ?? null,
    error: status === 'fail' ? errorText(data.details?.error) : null,
    line: data.line ?? null,
  }
}

const withoutInternals = (text) =>
  text
    .split('\n')
    .filter((l) => !/^\s+at .*\bnode:/.test(l))
    .join('\n')
    .replaceAll(`${process.cwd()}/`, '')
    .trim()
    .slice(-2000)

function errorText(error) {
  if (!error) return 'failed'
  const cause = error.cause ?? error
  const text = cause?.message ?? String(cause)
  const stack = typeof cause?.stack === 'string' ? cause.stack.split('\n').filter((l) => /^\s+at /.test(l) && !/\bnode:/.test(l)).slice(0, 3) : []
  return withoutInternals([text, ...stack].join('\n'))
}

const fullName = (t) => [...t.suites, t.name].join(' › ')

export function render({ tests, duration }, { title = 'Тесты' } = {}) {
  const count = (s) => tests.filter((t) => t.status === s).length
  const failed = tests.filter((t) => t.status === 'fail')
  const files = [...new Set(tests.map((t) => t.file))]
  const run = tests.filter((t) => t.status === 'pass' || t.status === 'fail').length
  const out = []

  out.push(
    failed.length
      ? `## ❌ ${title}: ${failed.length} из ${run} упали · ${ms(duration)}`
      : `## ✅ ${title}: все ${run} прошли · ${ms(duration)}`,
    '',
    '| Прошли | Упали | Пропущены | Файлов | Время |',
    '| --: | --: | --: | --: | --: |',
    `| ${count('pass')} | ${count('fail')} | ${count('skip') + count('todo')} | ${files.length} | ${ms(duration)} |`,
    '',
  )

  if (failed.length) {
    out.push('### Что упало', '')
    for (const t of failed)
      out.push(
        `<details open><summary>❌ <code>${cell(t.file)}${t.line ? `:${t.line}` : ''}</code> ${cell(fullName(t))}</summary>`,
        '',
        '```',
        t.error.replace(/```/g, "'''"),
        '```',
        '</details>',
        '',
      )
  }

  const statements = new Map()
  for (const t of tests)
    for (const id of specIds(t.name)) statements.set(id, [...(statements.get(id) ?? []), t])
  out.push('### Пункты спеков', '')
  if (statements.size) {
    out.push('| | Пункт | Тестов | Время |', '| :-: | --- | --: | --: |')
    for (const [id, ts] of [...statements].sort(([a], [b]) => a.localeCompare(b))) {
      const status = ts.some((t) => t.status === 'fail') ? 'fail' : ts.every((t) => t.status === 'pass') ? 'pass' : 'skip'
      const time = ts.reduce((s, t) => s + (t.duration ?? 0), 0)
      out.push(`| ${icon({ status })} | \`${id}\` | ${ts.length} | ${ms(time)} |`)
    }
    out.push('')
  }
  const untagged = tests.filter((t) => !specIds(t.name).length).length
  out.push(`Тестов без пункта спека (\`[spec:<spec-id>/<statement-id>]\` в имени): ${untagged} из ${tests.length}.`, '')

  const timed = tests.filter((t) => t.duration != null).sort((a, b) => b.duration - a.duration).slice(0, SLOWEST)
  if (timed.length) {
    out.push('### Самые медленные', '', '| Время | Тест | Файл |', '| --: | --- | --- |')
    for (const t of timed) out.push(`| ${ms(t.duration)} | ${cell(fullName(t))} | \`${cell(t.file)}\` |`)
    out.push('')
  }

  out.push('### Все тесты', '')
  for (const file of files) {
    const ts = tests.filter((t) => t.file === file)
    const bad = ts.some((t) => t.status === 'fail')
    const time = ts.reduce((s, t) => s + (t.duration ?? 0), 0)
    out.push(
      `<details${bad ? ' open' : ''}><summary>${bad ? '❌' : '✅'} <code>${cell(file)}</code> — ${ts.length} · ${ms(time)}</summary>`,
      '',
      '| | Тест | Время |',
      '| :-: | --- | --: |',
      ...ts.map((t) => `| ${icon(t)} | ${cell(fullName(t))} | ${ms(t.duration)} |`),
      '',
      '</details>',
      '',
    )
  }
  return out.join('\n')
}

export default async function* testReport(source) {
  const events = []
  for await (const event of source) events.push(event)
  yield render(collect(events), { title: process.env.TEST_REPORT_TITLE || 'Тесты' })
}
