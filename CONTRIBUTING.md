# Contributing to AI Bouncer

Thank you for your interest in improving AI Bouncer. This document explains
how contributions work, what is welcome, and the legal terms under which
contributions are accepted.

---

## Contributor Licence Agreement (CLA)

**This is important. Please read before submitting anything.**

By submitting a pull request, patch, issue, or any other contribution to
this repository, you agree to the following:

1. **You own what you submit.** You wrote the contribution yourself, or you
   have the legal right to submit it under these terms.

2. **You grant a broad licence to the maintainers.** You grant the project
   maintainers a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable licence to use, reproduce, modify, distribute, sublicense,
   and otherwise exploit your contribution as part of this project — including
   under commercial licences offered to paying customers.

3. **You understand the project licence.** Your contribution will be made
   available to the public under the PolyForm Noncommercial License 1.0.0.
   The maintainers separately retain the right to licence the project
   commercially. Your contribution is part of that arrangement.

4. **You are not entitled to revenue.** Contributing to the project does not
   entitle you to any share of commercial licensing revenue or any other
   compensation, unless separately agreed in writing with the maintainers.

**Why is this CLA necessary?**
Without it, each contributor would hold a copyright stake that could block
the maintainers from offering commercial licences. The CLA ensures the
project can be sustainably maintained and commercially licensed in the
future without needing to locate and obtain consent from every contributor.

If you are contributing on behalf of an employer or company, you confirm
that you are authorised to agree to these terms on that entity's behalf.

If you do not agree to these terms, please do not submit contributions.

---

## What contributions are welcome

### Highest impact

**Calibration data** — if you have labelled samples of AI-generated and
human-written text, measuring feature values and proposing updated Gaussian
parameters (μ, σ) for any signal group is the most valuable contribution
possible. Document your methodology, sample sources, and measurements clearly.

**New signal groups** — well-reasoned proposals for additional distributional
signals with empirical evidence of discrimination between AI and human text.
The architecture is designed so new groups can be added without modifying
existing ones. Open an issue before implementing to discuss design fit.

**Genre detector expansion** — Group F currently covers formal/technical and
conversational genres. News articles, legal writing, and social media posts
are known false-positive cases not yet handled. A calibrated detector for
any of these would be genuinely useful.

**Bug reports** — clear descriptions of texts the engine scores incorrectly,
including the text or a representative excerpt, the score received, and why
you believe it is wrong. The more specific the better.

### Also welcome

- Documentation improvements and corrections
- Browser compatibility testing and fixes
- Performance optimisations in the engine (with benchmarks)
- Accessibility improvements in the UI

### Not accepted

- **External API or service dependencies** — the zero-external-call
  architecture is a core design constraint, not a limitation to work around.
- **ML model integration** — the deterministic, heuristic architecture is
  intentional. See the design philosophy comments at the top of `popup.js`.
- **Calibration changes without supporting data** — changing Gaussian
  parameters without providing the measurements and methodology that
  justify the change will not be accepted.
- **UI redesigns** without prior discussion — open an issue first.

---

## How to submit a contribution

1. **Open an issue first** for anything beyond a small isolated bug fix.
   Describe what you want to change and why. This avoids wasted effort and
   ensures alignment before you invest time building something.

2. **Fork the repository** and work in a descriptively named branch, e.g.
   `calibrate-long-stratum-tfidf` or `fix-sentence-splitter-abbreviations`.

3. **Test across text types** — AI-generated articles, human blog posts,
   academic papers, chat messages, news articles, short texts, long texts.
   Document your test results in the pull request description.

4. **Update inline documentation** — if you change any Gaussian parameter,
   update the corresponding calibration comment in `popup.js` with the new
   values, your sample source, and methodology. If you add a new signal,
   follow the existing comment format for the group header block.

5. **Submit a pull request** with a clear description of what changed,
   why, and what testing you did. Reference the issue it addresses.

---

## Code style

`popup.js` uses ES6 throughout. Please match this style:

- `const` and `let` — no `var`
- Arrow functions `(a, b) => ...` for callbacks
- Template literals `` `text ${variable}` `` where they aid clarity
- Spread operator `...array` instead of positional array access where cleaner
- All calibration constants as named arrays `[aiMean, aiSd, humanMean, humanSd]`
  with an inline comment documenting their source
- Section headers using the `// ══════` style established in the file
- Signal group functions must return `{ llr, msg }` or `null` — no exceptions

---

## Questions

Open an issue with the `question` label. All issues are read.
