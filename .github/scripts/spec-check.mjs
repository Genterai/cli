// Spec check: a PR that touches product code says how it relates to Genterai/specs, in one line of its description:
//   Specs: implements <spec-id/statement-id>, <spec-id/statement-id>   the accepted statements it builds or restores
//   Specs: updated <link to the Genterai/specs pull request or commit>  the spec change it goes with
//   Specs: none - <reason>                                              no behaviour changes
// Rules: Genterai/specs governance/spec-repository.md. Used by .github/workflows/spec-check.yml;
// run `node --test .github/scripts/spec-check.test.mjs` to test.

export const MARKER = /^\s*(?:[-*]\s*)?(?:\[[xX]\]\s*)?specs?\s*:\s*(implements|updated|none)\b\s*[-:–—]?\s*(.*)$/im
// A full statement id: <spec-id>/<statement-id>, both kebab-case.
export const STATEMENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/

// The statement ids of an `implements` line, or null when one of them is not an id.
export function idsOf(detail) {
  const ids = detail.split(/[\s,]+/).map((s) => s.replace(/^`|`$/g, '')).filter(Boolean)
  return ids.length && ids.every((id) => STATEMENT_ID.test(id)) ? ids : null
}

export function check(files, body, patterns) {
  const touched = files.filter((f) => patterns.some((p) => p.test(f)))
  if (!touched.length) return { ok: true, reason: 'no product-code files changed', touched }
  const m = MARKER.exec(body || '')
  if (!m) return { ok: false, reason: 'missing "Specs:" line', touched }
  const kind = m[1].toLowerCase()
  const detail = m[2].trim()
  if (kind === 'implements' && !idsOf(detail))
    return { ok: false, reason: '"Specs: implements" needs full statement ids, as spec-id/statement-id, separated by commas', touched }
  if (kind === 'updated' && !/(github\.com\/Genterai\/specs|Genterai\/specs#|[0-9a-f]{7,40})/i.test(detail))
    return { ok: false, reason: '"Specs: updated" needs a link or sha in Genterai/specs', touched }
  if (kind === 'none' && detail.length < 5)
    return { ok: false, reason: '"Specs: none" needs a short reason', touched }
  return { ok: true, reason: `Specs: ${kind} ${detail}`, touched }
}

if (process.argv[1] && process.argv[1].endsWith('spec-check.mjs') && process.env.PR_FILES !== undefined) {
  const files = process.env.PR_FILES.split('\n').filter(Boolean)
  const patterns = (process.env.SPEC_PATHS || '').split('\n').filter(Boolean).map((s) => new RegExp(s))
  const r = check(files, process.env.PR_BODY, patterns)
  console.log(r.reason)
  if (!r.ok) {
    console.log(`Product files changed: ${r.touched.join(', ')}`)
    console.log('Add one line to the PR description: "Specs: implements <spec-id/statement-id>, ...", "Specs: updated <link/sha in Genterai/specs>" or "Specs: none - <why>".')
    console.log('How to find the specs of a change: https://github.com/Genterai/specs#readme')
    process.exit(1)
  }
}
