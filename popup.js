// ══════════════════════════════════════════════════════════════════════════════
// AI Bouncer — popup.js
// Version: 8.0
// ══════════════════════════════════════════════════════════════════════════════
//
// OVERVIEW
// --------
// Detection engine and UI logic for the AI Bouncer Chrome extension.
// Everything runs locally — no API calls, no data leaves the machine.
//
// DETECTION PHILOSOPHY
// --------------------
// Rather than matching surface patterns (word lists, phrase counts alone),
// the engine measures the *statistical shape* of text — distributions,
// variance, entropy. The principle: measure the statistical shape of the text
// rather than attempting to understand its meaning.
//
// AI-generated and human-written text have measurably different distributional
// fingerprints at every level — rhythm, vocabulary, register, surface entropy,
// lexical choice, genre. No single signal is reliable; the composite is.
//
// ARCHITECTURE — six signal groups processed in order:
// ------------
//   1. Text is tokenised into words and sentences.
//
//   2. A LENGTH STRATUM is assigned: short (<200w) | medium (200–800w) | long (>800w).
//      Calibration constants and active signals differ per stratum. For example,
//      TF-IDF kurtosis direction reverses between medium and long texts.
//
//   3. Six SIGNAL GROUPS run independently:
//        A · Rhythm      — sentence length CV, punctuation interval CV
//        B · Vocabulary  — TTR curve SD, TF-IDF kurtosis, word dispersion
//        C · Register    — contraction rate, first-person rate, slang/informal
//        D · Surface     — character trigram entropy, bigram repetition
//        E · Lexical     — filler phrase density, opener entropy, synonym register
//        F · Genre       — formal vs conversational competing score classifier
//
//      Within groups A–E, multiple candidate signals are computed and only the
//      strongest (highest |LLR|) contributes — preventing double-counting of
//      correlated signals (e.g. sentence CV and punctuation CV both measure rhythm).
//
//      Group F uses a different architecture: two competing weighted scores
//      (formal markers vs conversational markers), both rate-normalised per 100
//      words, so a "Thanks" in a 14,000-word paper cannot compete with dense
//      citation markers. The winning genre contributes a single LLR.
//
//   4. Each signal computes a GAUSSIAN LIKELIHOOD RATIO:
//        log( P(observed value | AI text) / P(observed value | Human text) )
//      using empirically calibrated Gaussian parameters (μ, σ) per stratum.
//      Positive LLR = AI evidence. Negative LLR = Human evidence.
//      Each LLR is clamped to [−2.5, +2.5] to prevent explosion when a value
//      lands in the extreme tail of one distribution.
//
//   5. All group LLRs are SUMMED (log-odds accumulation). The sigmoid of the
//      total gives a probability 0–100% of AI authorship.
//
//   6. Group F also applies a CONFIDENCE CAP:
//        Formal genre wins   → cap at 'medium'
//        Conversational wins → cap at 'low'
//        Mixed               → cap at 'low'
//      This is separate from the score — formal text may still be AI, but
//      the engine is less certain because formal writing shares surface
//      properties with AI output for structural, not generative, reasons.
//
//   7. VERDICT BANDS (intentionally wide to avoid false certainty):
//        ≥ 80  Very Likely AI
//        62–79 Possibly AI
//        39–61 Inconclusive
//        21–38 Likely Human
//        ≤ 20  Very Likely Human
//
// CALIBRATION
// -----------
// All Gaussian parameters (μ, σ) and genre marker weights are documented
// inline per signal and per stratum. They were derived empirically from sample
// texts. To retune: measure feature values on labelled AI/human samples and
// update the cal[] arrays or weight constants.
//
// KNOWN LIMITATIONS
// -----------------
// · Paraphrasing attacks reduce accuracy (Xiang et al. 2026).
// · Formal/academic/journalistic genres share surface properties with AI output.
//   Group F partially mitigates this but cannot fully resolve it.
// · Short texts (<200w) have fewer active signals; confidence is naturally lower.
// · Calibrated against GPT-3.5/4-era output; may need retuning for future models.
// · News articles score high-AI due to impersonal register — known false-positive
//   genre not yet covered by Group F.
// ══════════════════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — UI ELEMENT REFERENCES
// ══════════════════════════════════════════════════════════════════════════════

const grabBtn   = document.getElementById('grab-btn');
const checkBtn  = document.getElementById('check-btn');
const clearBtn  = document.getElementById('clear-btn');
const resultEl  = document.getElementById('result');
const textInput = document.getElementById('text-input');
const metaEl    = document.getElementById('meta');


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — UI HANDLERS
//
// Three entry points:
//   autoRun()     — fires automatically on DOMContentLoaded (popup open)
//   grabBtn click — manual re-grab if user navigates to a different page
//   clearBtn click — reset textarea and result area
//   checkBtn click — run analysis on current textarea content (Section 8)
//
// autoRun and grabBtn share the same logic; grabBtn delegates to autoRun
// to avoid duplication.
// ══════════════════════════════════════════════════════════════════════════════

// ── Page text extraction ──────────────────────────────────────────────────────
// Injects content.js into the active tab, retrieves extracted text,
// populates the textarea, then triggers analysis automatically.
// Fails gracefully on non-scriptable pages (chrome://, PDFs, etc.).

async function autoRun() {
  grabBtn.disabled = true;
  resultEl.innerHTML = '<div class="loading"><div class="spinner"></div>Analysing page…</div>';
  metaEl.textContent = '';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    if (!result.success) throw new Error(result.error);
    if (!result.text || result.text.length < 100)
      throw new Error('Not enough content on this page.');

    textInput.value = result.text;
    metaEl.textContent =
      'Extracted ' + result.wordCount.toLocaleString() + ' words via ' + result.method;

    // Auto-trigger analysis immediately after extraction
    checkBtn.click();

  } catch (err) {
    resultEl.innerHTML =
      '<div class="verdict" style="background:#1a1500;border:1px solid #4a3a00">'
      + '<span class="icon">⚠️</span>'
      + '<div>'
      + '<div class="label" style="color:#ffdd57">Could not extract page text</div>'
      + '<div class="sub">' + err.message + ' — paste text manually and hit Check.</div>'
      + '</div>'
      + '</div>';
  } finally {
    grabBtn.disabled = false;
    grabBtn.textContent = '⬇ Grab Current Page / Paste';
  }
}

// ── Button event listeners ────────────────────────────────────────────────────

// Manual grab — delegates to autoRun to avoid code duplication
grabBtn.addEventListener('click', autoRun);

// Clear all state
clearBtn.addEventListener('click', () => {
  textInput.value = '';
  metaEl.textContent = '';
  resultEl.innerHTML = '<div class="loading">✅ Ready</div>';
});

// Auto-run when the popup opens
document.addEventListener('DOMContentLoaded', autoRun);


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — TOKENISERS
//
// Three tokenisation steps used throughout the engine:
//   splitSentences — for rhythm and lexical signals
//   tokenizeWords  — base word list for all signals
//   contentWords   — stopword-filtered for vocabulary signals
// ══════════════════════════════════════════════════════════════════════════════

// ── Sentence splitter ─────────────────────────────────────────────────────────
// Splits on sentence-ending punctuation only when followed by whitespace
// then an uppercase letter or opening quote. Avoids false breaks on
// abbreviations like "U.S.", "e.g.", "Dr.", "Fig. 1".

function splitSentences(text) {
  return text
    .replace(/\n{2,}/g, ' ¶ ')
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .map(s => s.replace(/ ¶ /g, ' ').trim())
    .filter(s => s.length > 0);
}

// ── Word tokeniser ────────────────────────────────────────────────────────────
// Extracts lowercase alphabetic words (2+ chars). Strips numbers,
// punctuation, and URLs. This is the base token list for all signals.

function tokenizeWords(text) {
  return (text.toLowerCase().match(/\b[a-z']{2,}\b/g) || []);
}

// ── Stopword list ─────────────────────────────────────────────────────────────
// High-frequency function words that carry no authorship signal.
// Filtering these gives "content words" for vocabulary-level analysis.

const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','was','are','were','be','been','being','have','has',
  'had','do','does','did','will','would','could','should','may','might',
  'shall','can','this','that','these','those','it','its','i','we','you',
  'he','she','they','my','our','your','his','her','their','not','no',
  'so','as','if','then','than','when','where','who','which','what','how',
  'all','each','every','both','more','most','other','such','into','about',
  'up','out','over','also','just','very','even','still','back','there',
]);

function contentWords(words) {
  return words.filter(w => !STOPWORDS.has(w) && w.length > 2);
}


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — LENGTH STRATUM
//
// Text length fundamentally changes the statistical properties of features.
// The same feature (e.g. TF-IDF kurtosis) has different calibration constants
// and even opposite direction between medium and long texts.
//
// Thresholds:
//   short  < 200 words  — fewer signals active, confidence naturally lower
//   medium 200–800 words — most signals reliable, full calibration available
//   long   > 800 words  — some signals converge (TTR curve), others reverse
//                          direction (kurtosis); stratum-specific calibration
// ══════════════════════════════════════════════════════════════════════════════

function getStratum(wordCount) {
  if (wordCount < 200) return 'short';
  if (wordCount < 800) return 'medium';
  return 'long';
}


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — GAUSSIAN LIKELIHOOD RATIO ENGINE
//
// Core mathematical primitive used by all signal groups A–E.
//
// Each continuous feature is modelled as two Gaussians:
//   P(x | AI text)    — distribution of this feature in AI-generated text
//   P(x | Human text) — distribution of this feature in human-written text
//
// The log likelihood ratio:
//   LLR = log( P(x|AI) / P(x|Human) )
//
//   Positive LLR → AI evidence (feature value is more typical of AI)
//   Negative LLR → Human evidence (feature value is more typical of humans)
//   Near-zero    → Inconclusive (feature value is equally likely in both)
//
// CLAMPING: LLRs are clamped to [−2.5, +2.5] per signal.
// Without clamping, a value in the extreme tail of one Gaussian produces
// a near-zero PDF (≈ 0), causing log(pAI/pHuman) → ±∞ and one signal
// dominating the entire composite score. Clamping keeps the system fair.
//
// The epsilon (1e-10) prevents log(0) when a PDF evaluates to exactly zero.
// ══════════════════════════════════════════════════════════════════════════════

function gaussianPDF(x, mean, sd) {
  return Math.exp(-0.5 * Math.pow((x - mean) / sd, 2)) / (sd * Math.sqrt(2 * Math.PI));
}

function logLR(value, aiMean, aiSd, humanMean, humanSd) {
  const pAI    = gaussianPDF(value, aiMean,    aiSd)    + 1e-10;
  const pHuman = gaussianPDF(value, humanMean, humanSd) + 1e-10;
  const raw    = Math.log(pAI / pHuman);
  return Math.max(-2.5, Math.min(2.5, raw));
}


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — SIGNAL GROUPS A–E
//
// Each group function:
//   • Computes multiple candidate signals (related measures of the same
//     underlying property)
//   • Returns { llr, msg } for the single strongest candidate
//   • Returns null if the group cannot fire (e.g. text too short)
//
// Returning only the strongest prevents correlated signals from stacking
// their evidence — e.g. sentence CV and punctuation CV are both measures
// of rhythm; if both fire, only the stronger contributes.
//
// msg format: human-readable description shown in the signal table.
// ══════════════════════════════════════════════════════════════════════════════


// ── GROUP A · Rhythm ──────────────────────────────────────────────────────────
// Measures the regularity of sentence lengths and punctuation intervals.
//
// The key insight: AI generators produce metronomically even text because they
// sample token-by-token from a smooth probability distribution. Human writers
// vary their rhythm naturally — a long complex sentence followed by a short one.
//
// Two candidate signals:
//   A1 · Sentence length CV  — coefficient of variation of sentence word-counts
//   A2 · Punctuation CV      — CV of character-intervals between , ; : — –
//        (medium/long only — too few punctuation marks in short texts)
//
// Calibration — Sentence length CV:
//   short:  AI μ=0.21 σ=0.08   Human μ=0.67 σ=0.14
//   medium: AI μ=0.39 σ=0.10   Human μ=0.58 σ=0.12
//   long:   AI μ=0.55 σ=0.10   Human μ=0.68 σ=0.10
//   (Gap narrows at long: AI essays vary more across sections)
//
// Calibration — Punctuation interval CV:
//   medium: AI μ=0.98 σ=0.16   Human μ=0.82 σ=0.14
//   long:   AI μ=1.10 σ=0.18   Human μ=0.82 σ=0.14

function groupA_rhythm(text, sentences, stratum) {
  const signals = [];

  // ── A1: Sentence length coefficient of variation ──────────────────────────
  if (sentences.length >= 5) {
    const lens = sentences.map(s => (s.match(/\b\w+\b/g) || []).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd   = Math.sqrt(lens.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / lens.length);
    const cv   = sd / (mean || 1);

    const cal = stratum === 'short'  ? [0.21, 0.08, 0.67, 0.14]
              : stratum === 'medium' ? [0.39, 0.10, 0.58, 0.12]
              :                        [0.55, 0.10, 0.68, 0.10];

    const llr = logLR(cv, ...cal);
    const dir = cv < cal[0] + cal[1]       ? 'very uniform'
              : cv < (cal[0] + cal[2]) / 2 ? 'somewhat uniform'
              :                               'natural variation ✓';

    signals.push({ llr, msg: `Sentence rhythm: ${dir} (CV=${cv.toFixed(2)})` });
  }

  // ── A2: Punctuation interval coefficient of variation ─────────────────────
  // Only active for medium/long texts — short texts have too few punctuation
  // marks for the CV to be meaningful.
  if (stratum !== 'short') {
    const pos = [];
    for (let i = 0; i < text.length; i++) {
      if (/[,;:—–]/.test(text[i])) pos.push(i);
    }
    if (pos.length >= 8) {
      const ivs   = pos.slice(1).map((p, i) => p - pos[i]);
      const pmean = ivs.reduce((a, b) => a + b, 0) / ivs.length;
      const psd   = Math.sqrt(ivs.reduce((a, b) => a + Math.pow(b - pmean, 2), 0) / ivs.length);
      const pcv   = psd / (pmean || 1);

      const pcal = stratum === 'long' ? [1.10, 0.18, 0.82, 0.14]
                                      : [0.98, 0.16, 0.82, 0.14];
      const pllr = logLR(pcv, ...pcal);
      const pdir = pcv < 0.72 ? 'metronomic'
                 : pcv < 0.90 ? 'somewhat regular'
                 :               'irregular ✓';

      signals.push({ llr: pllr, msg: `Punctuation rhythm: ${pdir} (CV=${pcv.toFixed(2)})` });
    }
  }

  if (!signals.length) return null;
  signals.sort((a, b) => Math.abs(b.llr) - Math.abs(a.llr));
  return signals[0];
}


// ── GROUP B · Vocabulary distribution ────────────────────────────────────────
// Measures the *shape* of vocabulary use, not just richness.
//
// Three candidate signals, each measuring "how smoothed is AI vocabulary
// generation" from a different angle:
//
// B1 · TTR curve SD (medium only)
//   Slides a 50-word window across text, computes type-token ratio per window,
//   then takes the SD of all ratios. Human writers use words in bursts —
//   a topic cluster, then a new vocabulary set (spiky curve, high SD). AI
//   distributes vocabulary evenly throughout (flat curve, low SD).
//   Not used at long: the TTR curve converges and loses discriminating power.
//   Calibration: AI μ=0.029 σ=0.012   Human μ=0.051 σ=0.015
//
// B2 · TF-IDF kurtosis (all strata — DIRECTION REVERSES at long)
//   Measures the tail-heaviness of the TF-IDF score distribution across the
//   text's vocabulary. Human writers have verbal tics — a few words appear
//   far more than expected (fat tails, high kurtosis). At medium length,
//   AI has a compressed distribution (low kurtosis). HOWEVER at long length,
//   AI's repeated filler phrases create artificial outlier terms, reversing
//   the direction. This reversal is a key calibration discovery.
//   Medium: AI μ=10.4 σ=2.5   Human μ=16.2 σ=3.0   (AI < Human)
//   Long:   AI μ=18.4 σ=3.5   Human μ=7.6  σ=2.5   (AI > Human — REVERSED)
//
// B3 · Word dispersion (long only)
//   For each content word appearing 3+ times, measures the standard deviation
//   of positional intervals between occurrences (normalised to 0–1 text length).
//   Models word positions as samples from a distribution: human writers cluster
//   words in topic bursts (high SD — positional distribution is non-uniform,
//   peaked), while AI distributes vocabulary evenly throughout (low SD —
//   positional distribution approaches uniform, near-Gaussian). A flat positional
//   profile is statistically indistinguishable from a uniform distribution,
//   meaning the word carries no topical signal. Not reliable at medium length.
//   Calibration: AI μ=0.071 σ=0.025   Human μ=0.163 σ=0.035

function groupB_vocabulary(words, stratum) {
  const signals = [];
  const cwords  = contentWords(words);

  // ── B1: TTR curve SD — medium only ───────────────────────────────────────
  if (stratum === 'medium' && words.length >= 150) {
    const W      = 50;  // window size in words
    const step   = Math.floor(W / 2);  // 50% overlap between windows
    const ratios = [];

    for (let i = 0; i <= words.length - W; i += step) {
      ratios.push(new Set(words.slice(i, i + W)).size / W);
    }

    const tmean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const tsd   = Math.sqrt(ratios.reduce((a, b) => a + Math.pow(b - tmean, 2), 0) / ratios.length);
    const tllr  = logLR(tsd, 0.029, 0.012, 0.051, 0.015);
    const tdir  = tsd < 0.038 ? 'flat/AI' : tsd < 0.045 ? 'somewhat flat' : 'spiky ✓';

    signals.push({ llr: tllr, msg: `TTR curve: ${tdir} (SD=${tsd.toFixed(3)})` });
  }

  // ── B2: TF-IDF kurtosis — all strata, direction-aware ────────────────────
  if (cwords.length >= 30) {
    // IDF approximated via a two-tier lookup — no external corpus needed.
    // Words in COMMON get lower IDF (more frequent in general language);
    // long words (>8 chars) get higher IDF (more specialised/distinctive).
    const COMMON = new Set([
      'time','year','people','way','day','man','woman','world','life','hand',
      'place','case','week','work','number','night','point','home','water',
      'room','area','money','story','fact','month','right','study','book',
      'word','business','issue','side','kind','head','house','service',
      'change','system','government','country','state','percent','company','problem',
    ]);

    const tf = {};
    cwords.forEach(w => { tf[w] = (tf[w] || 0) + 1; });

    const tfidf = Object.keys(tf).map(w => {
      const termFreq = tf[w] / cwords.length;
      const idf      = COMMON.has(w) ? 1.2 : w.length > 8 ? 4.2 : 2.4;
      return termFreq * idf;
    });

    if (tfidf.length >= 10) {
      const kn    = tfidf.length;
      const kmean = tfidf.reduce((a, b) => a + b) / kn;
      const ksd   = Math.sqrt(tfidf.reduce((a, b) => a + Math.pow(b - kmean, 2), 0) / kn);
      const kurt  = ksd > 0
        ? tfidf.reduce((a, b) => a + Math.pow((b - kmean) / ksd, 4), 0) / kn - 3
        : 0;

      // Calibration constants differ per stratum — direction inverts at long
      const kcal = stratum === 'short'  ? [3.8,  1.5, 4.6,  1.5]
                 : stratum === 'medium' ? [10.4, 2.5, 16.2, 3.0]
                 :                        [18.4, 3.5, 7.6,  2.5];  // reversed at long

      const kllr = logLR(kurt, ...kcal);
      const kdir = stratum === 'long'
        ? (kurt > 16.0 ? 'high/AI phrase repetition' : kurt < 10.0 ? 'low ✓' : 'moderate')
        : (kurt < 8.0  ? 'compressed/AI'             : kurt > 14.0 ? 'fat-tailed ✓' : 'moderate');

      signals.push({ llr: kllr, msg: `TF-IDF kurtosis: ${kdir} (${kurt.toFixed(1)})` });
    }
  }

  // ── B3: Word dispersion — long only ──────────────────────────────────────
  // For medium texts, word dispersion direction is unreliable (AI and human
  // produce similar values at 200–800 words). Only active at long.
  if (stratum === 'long' && cwords.length >= 60) {
    const positions = {};
    cwords.forEach((w, i) => {
      if (!positions[w]) positions[w] = [];
      positions[w].push(i / cwords.length);  // normalised 0–1 position
    });

    const dispersions = [];
    Object.values(positions).forEach(pos => {
      if (pos.length < 3) return;  // need 3+ occurrences for meaningful SD
      const divs  = pos.slice(1).map((p, i) => p - pos[i]);
      const dmean = divs.reduce((a, b) => a + b, 0) / divs.length;
      dispersions.push(
        Math.sqrt(divs.reduce((a, b) => a + Math.pow(b - dmean, 2), 0) / divs.length)
      );
    });

    if (dispersions.length >= 5) {
      const meanDisp = dispersions.reduce((a, b) => a + b, 0) / dispersions.length;
      const dllr     = logLR(meanDisp, 0.071, 0.025, 0.163, 0.035);
      const ddir     = meanDisp < 0.10 ? 'even spread/AI'
                     : meanDisp < 0.13 ? 'moderate'
                     :                   'clustered ✓';

      signals.push({ llr: dllr, msg: `Word dispersion: ${ddir} (${meanDisp.toFixed(3)})` });
    }
  }

  if (!signals.length) return null;
  signals.sort((a, b) => Math.abs(b.llr) - Math.abs(a.llr));
  return signals[0];
}


// ── GROUP C · Register ────────────────────────────────────────────────────────
// Measures the formality and personal voice of the writing.
//
// AI models trained on instruction-following output almost never use
// contractions or first-person voice — they default to impersonal formal
// English. These are among the most stable and reliable signals because
// they depend on model training behaviour, not surface pattern evolution.
//
// Three candidate signals:
//   C1 · Contraction rate   — frequency of i'm, it's, don't, etc.
//   C2 · First-person rate  — frequency of I, my, myself, etc.
//   C3 · Informal markers   — slang, exclamations, elongation (sooo)
//        (These three are computed but the strongest one is returned)
//
// Calibration — Contraction rate (stable across all strata):
//   AI μ=0.000 σ=0.003   Human μ=0.035 σ=0.015
//
// Calibration — First-person rate (stable across all strata):
//   AI μ=0.000 σ=0.004   Human μ=0.060 σ=0.020

function groupC_register(text, words) {
  const signals = [];
  const n = words.length;
  if (n < 20) return null;

  // ── C1: Contraction rate ──────────────────────────────────────────────────
  const contractions = (text.match(/\b(i'm|it's|don't|won't|can't|isn't|wasn't|weren't|wouldn't|couldn't|shouldn't|i've|i'd|i'll|they're|we're|you're|he's|she's|that's|there's|here's|let's|who's|didn't|doesn't|haven't|hasn't|ain't)\b/gi) || []).length;

  const cRate = contractions / n;
  const cllr  = logLR(cRate, 0.000, 0.003, 0.035, 0.015);
  signals.push({
    llr: cllr,
    msg: cRate < 0.005 ? 'Almost no contractions'
       : cRate > 0.025 ? 'Natural contractions ✓'
       : `Low contraction rate (${(cRate * 100).toFixed(1)}%)`,
  });

  // ── C2: First-person rate ─────────────────────────────────────────────────
  const fp     = (text.match(/\b(i |i'm|i've|i'd|i'll|my |mine|myself)\b/gi) || []).length;
  const fpRate = fp / n;
  const fpllr  = logLR(fpRate, 0.000, 0.004, 0.060, 0.020);
  signals.push({
    llr: fpllr,
    msg: fpRate < 0.008 ? 'Impersonal — no first-person voice'
       : fpRate > 0.030 ? 'Strong personal voice ✓'
       : `Low personal voice (${(fpRate * 100).toFixed(1)}%)`,
  });

  // ── C3: Informal markers — slang, exclamations, elongated words ───────────
  // These are strong human signals computed directly rather than via Gaussian
  // because their distribution is highly skewed (mostly zero, occasional spikes).
  const slang = (text.match(/\b(lol|lmao|tbh|ngl|idk|omg|wtf|smh|imo|irl|gonna|wanna|gotta|kinda|sorta|yeah|yep|nope|okay|oops|wow|hmm|ugh)\b/gi) || []).length;
  const excl  = (text.match(/!/g) || []).length;
  const typo  = (text.match(/\b(\w)\1{2,}\b/g) || []).length;  // sooo, noooo

  if (slang > 0 || excl > 1 || typo > 0) {
    const hllr  = Math.max(-2.5, -(slang * 0.5 + Math.min(excl, 5) * 0.25 + typo * 0.4));
    const parts = [];
    if (slang > 0) parts.push(`slang (${slang})`);
    if (excl > 1)  parts.push(`exclamations (${excl})`);
    if (typo > 0)  parts.push('informal emphasis');
    signals.push({ llr: hllr, msg: `Human register markers ✓: ${parts.join(', ')}` });
  }

  signals.sort((a, b) => Math.abs(b.llr) - Math.abs(a.llr));
  return signals[0];
}


// ── GROUP D · Surface entropy ─────────────────────────────────────────────────
// Sub-word level signals independent of vocabulary choices.
// These measure the statistical texture of the text at the character and
// word-pair level — properties that AI generation constrains differently
// from human writing.
//
// Two candidate signals:
//   D1 · Character trigram entropy (short/medium only)
//   D2 · Bigram repetition rate    (short only)
//
// D1 · Character trigram entropy
//   Counts unique 3-character sequences / total 3-character sequences.
//   AI text has lower character-level entropy because token predictions are
//   more constrained — the model samples from a peaked distribution,
//   producing more repeated short sequences. Not used at long because
//   the gap between AI and human narrows to within noise.
//   Calibration short:  AI μ=0.686 σ=0.040   Human μ=0.679 σ=0.035 (very weak)
//   Calibration medium: AI μ=0.434 σ=0.040   Human μ=0.447 σ=0.038
//
// D2 · Bigram repetition rate (short only)
//   1 − (unique word-pairs / total word-pairs). At short length, AI repeats
//   word pairs more than humans. This direction REVERSES at medium/long —
//   human texts at longer length repeat more due to topic focus — so this
//   signal is only used for short texts.
//   Calibration: AI μ=0.023 σ=0.010   Human μ=0.000 σ=0.005

function groupD_entropy(text, words, stratum) {
  const signals = [];

  // ── D1: Character trigram entropy — short/medium only ─────────────────────
  if (stratum !== 'long' && text.length >= 150) {
    const cleaned = text.toLowerCase().replace(/\s+/g, ' ');
    const tri     = {};
    let   total   = 0;

    for (let i = 0; i < cleaned.length - 2; i++) {
      const t = cleaned.slice(i, i + 3);
      tri[t]  = (tri[t] || 0) + 1;
      total++;
    }

    const entropy = Object.keys(tri).length / total;
    const ecal    = stratum === 'short'
      ? [0.686, 0.040, 0.679, 0.035]   // weak signal at short
      : [0.434, 0.040, 0.447, 0.038];

    const ellr = logLR(entropy, ...ecal);
    signals.push({ llr: ellr, msg: `Char trigram entropy: ${entropy.toFixed(3)}` });
  }

  // ── D2: Bigram repetition rate — short only ───────────────────────────────
  if (stratum === 'short' && words.length >= 20) {
    const bigrams = words.slice(1).map((w, i) => words[i] + ' ' + w);
    const repeat  = 1 - (new Set(bigrams).size / (bigrams.length || 1));
    const bllr    = logLR(repeat, 0.023, 0.010, 0.000, 0.005);
    const bdir    = repeat > 0.018 ? 'high/AI' : repeat < 0.008 ? 'low ✓' : 'moderate';

    signals.push({ llr: bllr, msg: `Bigram repetition: ${bdir} (${repeat.toFixed(3)})` });
  }

  if (!signals.length) return null;
  signals.sort((a, b) => Math.abs(b.llr) - Math.abs(a.llr));
  return signals[0];
}


// ── GROUP E · Lexical choice ──────────────────────────────────────────────────
// Surface-level signals based on word and phrase selection patterns.
// More brittle than distributional signals (AI models evolve and phrase
// lists become stale) but still effective, especially combined with A–D.
//
// Three candidate signals:
//   E1 · Filler phrase density   — AI overuses transitional/hedging phrases
//   E2 · Sentence-opener entropy — AI has unnaturally even opener distribution
//   E3 · Synonym register ratio  — AI prefers formal synonyms (utilize vs use)
//
// E1 · Filler phrase density
//   Rate = phrases_found / sentence_count. At long, rate dilutes with document
//   length, so count-per-100-sentences is used instead.
//   Calibration (phrase/sentence rate):
//     short:  AI μ=3.14 σ=0.80   Human μ=0.00 σ=0.10
//     medium: AI μ=2.00 σ=0.60   Human μ=0.00 σ=0.10
//   Calibration (count per 100 sentences, long only):
//     long:   AI μ=5.0  σ=2.0    Human μ=0.0  σ=0.5
//
// E2 · Sentence-opener entropy
//   Shannon entropy of first-word categories per sentence:
//   (article | pronoun | preposition | conjunction | demonstrative | other)
//   AI produces a flat distribution (high entropy ≈ 1.8 bits).
//   Humans have a strong personal style skew (low entropy ≈ 0.3–1.5 bits).
//   Calibration:
//     short:  AI μ=1.84 σ=0.22   Human μ=1.53 σ=0.25
//     medium: AI μ=1.69 σ=0.22   Human μ=0.34 σ=0.25  (large gap at medium)
//     long:   AI μ=1.84 σ=0.20   Human μ=1.12 σ=0.25
//
// E3 · Synonym register ratio
//   For a fixed list of formal/informal synonym pairs, measures the fraction
//   of formal choices. AI models consistently choose the formal variant;
//   human writers mix registers naturally.
//   Calibration (formal_count / total_choices):
//     short:  AI μ=1.00 σ=0.10   Human μ=0.00 σ=0.10
//     medium: AI μ=0.57 σ=0.18   Human μ=0.00 σ=0.10
//     long:   AI μ=0.29 σ=0.15   Human μ=0.00 σ=0.10

// ── E1 phrase list ────────────────────────────────────────────────────────────
// Compiled from observed GPT-3.5/4 output patterns. Subject to model evolution.
// Update by adding phrases that appear frequently in AI text but rarely in
// human writing.

const AI_PHRASES = [
  "it's worth noting", "it is worth noting", "in conclusion", "to summarize", "in summary",
  "furthermore", "moreover", "additionally", "it is important to note", "it's important to note",
  "first and foremost", "last but not least", "without further ado", "having said that",
  "that being said", "needless to say", "as an ai", "as a language model",
  "delve into", "dive into", "nuanced", "multifaceted", "comprehensive", "straightforward",
  "crucial", "vital", "invaluable", "intricate", "robust", "commendable", "seamless",
  "cutting-edge", "game-changing", "ever-evolving", "innovative", "in the realm of",
  "in the world of", "at its core", "the bottom line", "rest assured", "a testament to",
  "landscape", "tapestry", "ecosystem", "plays a crucial role", "plays an important role",
  "a wide range of", "when it comes to", "by leveraging", "in today's", "in the context of",
  "it is essential to", "it's essential to", "one of the most", "let's explore",
  "let us explore", "empower", "synergy", "holistic", "paradigm", "it goes without saying",
  "allow me to", "leverage", "utilize", "facilitate", "endeavor",
];

// ── E3 synonym register pairs [formal, informal] ─────────────────────────────
// AI consistently chooses the left (formal) variant. Humans mix both.

const FORMAL_PAIRS = [
  ['utilize',   'use'],    ['facilitate', 'help'],   ['demonstrate', 'show'],
  ['commence',  'start'],  ['purchase',   'buy'],    ['require',     'need'],
  ['endeavor',  'try'],    ['obtain',     'get'],    ['implement',   'do'],
  ['leverage',  'use'],    ['ascertain',  'find'],   ['inquire',     'ask'],
  ['terminate', 'end'],    ['prioritize', 'focus'],  ['optimize',    'improve'],
  ['sufficient','enough'], ['numerous',   'many'],   ['therefore',   'so'],
  ['however',   'but'],
];

// ── E2 opener categories ──────────────────────────────────────────────────────
const OPENER_CATS = {
  article:       ['the', 'a', 'an'],
  pronoun:       ['i', 'we', 'you', 'he', 'she', 'they', 'it', 'my', 'our', 'your'],
  preposition:   ['in', 'on', 'at', 'by', 'for', 'with', 'about', 'through', 'after', 'before'],
  conjunction:   ['but', 'and', 'or', 'so', 'yet', 'although', 'however', 'therefore', 'while', 'when'],
  demonstrative: ['this', 'these', 'that', 'those'],
};

function groupE_lexical(text, words, sentences, stratum) {
  const signals   = [];
  const lowerText = text.toLowerCase();
  const found     = AI_PHRASES.filter(p => lowerText.includes(p));

  // ── E1: Filler phrase density ─────────────────────────────────────────────
  if (stratum === 'long') {
    // Use count-per-100-sentences for long texts to avoid rate dilution
    const countPer100 = (found.length / (sentences.length || 1)) * 100;
    const pllr  = logLR(countPer100, 5.0, 2.0, 0.0, 0.5);
    const tier  = found.length >= 8 ? 'heavy'
                : found.length >= 3 ? 'moderate'
                : found.length > 0  ? 'light'
                :                     'none';
    signals.push({
      llr: pllr,
      msg: found.length > 0
        ? `AI filler phrases — ${tier} (${found.length} found, ${countPer100.toFixed(1)}/100s: "${found.slice(0, 2).join('", "')}"…)`
        : 'No AI filler phrases ✓',
    });
  } else {
    // Use phrase/sentence rate for short and medium
    const rate  = found.length / (sentences.length || 1);
    const rcal  = stratum === 'short' ? [3.14, 0.80, 0.00, 0.10]
                                      : [2.00, 0.60, 0.00, 0.10];
    const rllr  = logLR(rate, ...rcal);
    const rtier = found.length >= 4 ? 'heavy'
                : found.length >= 2 ? 'moderate'
                : found.length > 0  ? 'light'
                :                     'none';
    signals.push({
      llr: rllr,
      msg: found.length > 0
        ? `AI filler phrases — ${rtier} (${found.length}: "${found.slice(0, 2).join('", "')}"…)`
        : 'No AI filler phrases ✓',
    });
  }

  // ── E2: Sentence-opener entropy ───────────────────────────────────────────
  if (sentences.length >= 6) {
    const counts = { article: 0, pronoun: 0, preposition: 0, conjunction: 0, demonstrative: 0, other: 0 };

    sentences.forEach(s => {
      const first  = (s.match(/\b[a-z]+\b/i) || [''])[0].toLowerCase();
      let   bucket = 'other';
      for (const [cat, words] of Object.entries(OPENER_CATS)) {
        if (words.includes(first)) { bucket = cat; break; }
      }
      counts[bucket]++;
    });

    const probs  = Object.values(counts).map(c => c / sentences.length).filter(p => p > 0);
    const entrop = -probs.reduce((a, p) => a + p * Math.log2(p), 0);

    const ecal = stratum === 'short'  ? [1.84, 0.22, 1.53, 0.25]
               : stratum === 'medium' ? [1.69, 0.22, 0.34, 0.25]
               :                        [1.84, 0.20, 1.12, 0.25];
    const ellr = logLR(entrop, ...ecal);
    const edir = entrop > 1.72 ? 'very even/AI'
               : entrop > 1.50 ? 'somewhat even'
               :                 'skewed ✓';

    signals.push({ llr: ellr, msg: `Sentence-opener entropy: ${edir} (${entrop.toFixed(2)})` });
  }

  // ── E3: Synonym register ratio ────────────────────────────────────────────
  if (words.length >= 30) {
    let formal = 0, informal = 0;
    FORMAL_PAIRS.forEach(([fml, inf]) => {
      formal   += (lowerText.match(new RegExp(`\\b${fml}\\b`, 'g')) || []).length;
      informal += (lowerText.match(new RegExp(`\\b${inf}\\b`, 'g')) || []).length;
    });

    const total = formal + informal;
    if (total >= 3) {
      const fRate = formal / total;
      const fcal  = stratum === 'short'  ? [1.00, 0.10, 0.00, 0.10]
                  : stratum === 'medium' ? [0.57, 0.18, 0.00, 0.10]
                  :                        [0.29, 0.15, 0.00, 0.10];
      const fllr  = logLR(fRate, ...fcal);
      const fdir  = fRate > 0.58 ? 'formal/AI' : fRate < 0.44 ? 'natural ✓' : 'mixed';

      signals.push({ llr: fllr, msg: `Synonym register: ${fdir} (${Math.round(fRate * 100)}% formal)` });
    }
  }

  if (!signals.length) return null;
  signals.sort((a, b) => Math.abs(b.llr) - Math.abs(a.llr));
  return signals[0];
}


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — GROUP F · GENRE CLASSIFIER
//
// Determines whether the text belongs to a specialist genre that shares
// surface properties with AI output for structural, not generative, reasons —
// making the engine less reliable for that text.
//
// WHY A SEPARATE ARCHITECTURE
// ---------------------------
// Groups A–E use binary (AI vs Human) Gaussian likelihood ratios.
// Genre classification is a three-way problem: Formal | Conversational | Neither.
// Two boolean detectors running independently would both fire on a mixed page
// (e.g. academic article + UI footer) and produce two conflicting F·Domain rows.
// Instead, formal and conversational evidence compete as weighted scores.
//
// HOW IT WORKS
// ------------
// Both formal and conversational markers are measured as RATE-NORMALISED SCORES
// (weighted sum of marker rates per 100 words). Rate normalisation is critical:
//   • A "Thanks" in a 14,000-word paper → signoff rate ≈ 0.007 → near-zero score
//   • The same "Thanks" in a 40-word message → rate ≈ 2.5 → dominates score
// This naturally handles mixed pages without special-case proportioning logic.
//
// FORMAL MARKERS (rate per 100 words × weight → formalScore)
//   Citations   [N], et al., Fig. N, Table N   weight 3.0 — strongest discriminator;
//                                                impossible in casual writing
//   Reporting   proposed/demonstrated/found…   weight 2.0 — academic voice verbs
//   Acronyms    2–6 char ALL-CAPS              weight 0.5 — present everywhere (AI, ML,
//                                                US, EU), deliberately weak alone
//
// CONVERSATIONAL MARKERS (rate per 100 words × weight → convoScore)
//   @mentions   direct addressing              weight 3.0 — impossible in formal writing
//   Sign-offs   thanks/cheers/regards          weight 2.5
//   Ellipsis    ... or …                       weight 2.5
//   Exclaims    !                              weight 1.5
//   LC starts   lowercase after punctuation    weight 1.0 — casual typing habit
//
// GENRE DECISION
//   Neither score ≥ GENRE_THRESHOLD (5.0) → no genre flag, engine runs normally
//   One score ≥ threshold AND ≥ GENRE_RATIO (1.5×) stronger → that genre wins
//   Both ≥ threshold but within 1.5× of each other → "Mixed" (genuinely ambiguous)
//
// SCORE CONTRIBUTION (LLR fed into log-odds accumulator)
//   Formal wins        →  +0.3  (small positive: formal text can be AI-like structurally)
//   Conversational wins → -0.8  (negative: chat messages lean human)
//   Mixed               →  0.0  (genuinely ambiguous, no contribution)
//
// CONFIDENCE CAP (applied after score calculation, independently)
//   Formal wins        → cap at 'medium'
//   Conversational wins → cap at 'low'
//   Mixed               → cap at 'low'
//
// TUNING
//   GENRE_THRESHOLD: raise to require stronger genre signals before flagging;
//                    lower to catch weaker genre markers (more false positives).
//   GENRE_RATIO:     raise to require more decisive wins (more "Mixed" results);
//                    lower to let weaker dominance win (fewer "Mixed" results).
// ══════════════════════════════════════════════════════════════════════════════

const GENRE_THRESHOLD = 5.0;  // minimum score for a genre to be considered active
const GENRE_RATIO     = 1.5;  // dominant genre must be this many times stronger to win

function groupF_genre(text, words) {
  const n      = words.length;
  if (n < 15) return null;
  const per100 = n / 100;

  // ── Formal marker rates ───────────────────────────────────────────────────
  const citCount = (text.match(/\[\d+[\d,\u2013\-]*\]|\bet al\b\.?|\bFig\.\s*\d|\bTable\s*\d/g) || []).length;
  const repCount = (text.match(/\b(proposed|demonstrated|showed|found|observed|reported|suggested|indicated|confirmed|evaluated|examined|introduced|achieves|outperforms|surpasses|validated)\b/gi) || []).length;
  const acrCount = (text.match(/\b[A-Z]{2,6}\b/g) || []).length;

  const citRate = citCount / per100;
  const repRate = repCount / per100;
  const acrRate = acrCount / per100;

  const formalScore = (citRate * 3.0) + (repRate * 2.0) + (acrRate * 0.5);

  // ── Conversational marker rates ───────────────────────────────────────────
  const menCount  = (text.match(/@\w+/g) || []).length;
  const sigCount  = (text.match(/\b(thanks|cheers|regards|best|noted|thx|rgds|appreciated)\b/gi) || []).length;
  const ellCount  = (text.match(/\.{2,}|…/g) || []).length;
  const exclCount = (text.match(/!/g) || []).length;
  const lcCount   = (text.match(/(?<=[.!?]\s)[a-z]/g) || []).length;

  const menRate  = menCount  / per100;
  const sigRate  = sigCount  / per100;
  const ellRate  = ellCount  / per100;
  const exclRate = exclCount / per100;
  const lcRate   = lcCount   / per100;

  const convoScore = (menRate * 3.0) + (sigRate * 2.5) + (ellRate * 2.5)
                   + (exclRate * 1.5) + (lcRate * 1.0);

  // ── Neither genre active → no flag ───────────────────────────────────────
  if (formalScore < GENRE_THRESHOLD && convoScore < GENRE_THRESHOLD) return null;

  // ── Determine winner via competing scores ─────────────────────────────────
  const formalWins = formalScore >= GENRE_THRESHOLD &&
    (convoScore < GENRE_THRESHOLD || formalScore / convoScore >= GENRE_RATIO);

  const convoWins = convoScore >= GENRE_THRESHOLD &&
    (formalScore < GENRE_THRESHOLD || convoScore / formalScore >= GENRE_RATIO);

  // If neither clearly dominates, both are active but within ratio → Mixed
  const mixed = !formalWins && !convoWins;

  // ── Build reason strings (only include markers above their contribution threshold)
  const fReasons = [];
  if (citRate  > 0.3) fReasons.push(`citations (${citRate.toFixed(1)}/100w)`);
  if (repRate  > 0.5) fReasons.push(`reporting verbs (${repRate.toFixed(1)}/100w)`);
  if (acrRate  > 1.5) fReasons.push(`acronyms (${acrRate.toFixed(1)}/100w)`);

  const cReasons = [];
  if (menRate  > 0.3) cReasons.push(`@mentions (${menRate.toFixed(1)}/100w)`);
  if (sigRate  > 0.3) cReasons.push(`sign-offs (${sigRate.toFixed(1)}/100w)`);
  if (ellRate  > 0.5) cReasons.push(`ellipsis (${ellRate.toFixed(1)}/100w)`);
  if (exclRate > 0.3) cReasons.push(`exclamations (${exclRate.toFixed(1)}/100w)`);
  if (lcRate   > 0.5) cReasons.push(`casual punctuation (${lcRate.toFixed(1)}/100w)`);

  // ── Assemble result ───────────────────────────────────────────────────────
  let genre, reasons, confidenceCap, llr;

  if (formalWins) {
    genre         = 'Formal/technical';
    reasons       = fReasons;
    confidenceCap = 'medium';
    llr           = 0.3;   // small positive: formal text can be AI-like structurally
  } else if (convoWins) {
    genre         = 'Conversational';
    reasons       = cReasons;
    confidenceCap = 'low';
    llr           = -0.8;  // negative: chat messages lean human
  } else {
    genre         = 'Mixed formal/conversational';
    reasons       = [...fReasons, ...cReasons];
    confidenceCap = 'low';
    llr           = 0.0;   // ambiguous — no score contribution
  }

  return {
    llr,
    genre,
    reasons,
    confidenceCap,
    formalScore,
    convoScore,
    msg: `${genre} text (${reasons.join(', ')}) — heuristics less reliable for this genre`,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — COMPOSITE SCORER
//
// Orchestrates all six signal groups, accumulates log-LRs, converts to
// probability via sigmoid, computes confidence, and applies genre cap.
//
// Flow:
//   1. Tokenise text → words, sentences, stratum
//   2. Run all six groups → collect { llr, msg } results
//   3. Sum LLRs → log-odds
//   4. sigmoid(log-odds) → probability → score 0–100
//   5. Compute confidence from |log-odds| and active group count
//   6. Apply Group F confidence cap if genre detected
//   7. Build signal strings for UI rendering
//   8. Count AI/Human group split for "mixed signals" summary line
// ══════════════════════════════════════════════════════════════════════════════

function analyzeText(text) {
  // ── Step 1: Tokenise ──────────────────────────────────────────────────────
  const words         = tokenizeWords(text);
  const sentences     = splitSentences(text);
  const wordCount     = words.length;
  const stratum       = getStratum(wordCount);

  // Return early for very short text — not enough signal for any group
  if (wordCount < 20) {
    return {
      score: 50, confidence: 'low', logOdds: 0, stratum,
      signals: ['Text too short for reliable analysis'],
      wordCount, sentenceCount: sentences.length,
      aiGroups: 0, humanGroups: 0,
    };
  }

  // ── Step 2: Run signal groups ─────────────────────────────────────────────
  const groups = [
    { label: 'A·Rhythm',     result: groupA_rhythm(text, sentences, stratum) },
    { label: 'B·Vocabulary', result: groupB_vocabulary(words, stratum) },
    { label: 'C·Register',   result: groupC_register(text, words) },
    { label: 'D·Surface',    result: groupD_entropy(text, words, stratum) },
    { label: 'E·Lexical',    result: groupE_lexical(text, words, sentences, stratum) },
    { label: 'F·Genre',      result: groupF_genre(text, words) },
  ];

  // ── Step 3: Accumulate log-odds ───────────────────────────────────────────
  let logOdds      = 0;
  let activeGroups = 0;
  const signals    = [];

  groups.forEach(g => {
    if (!g.result) return;
    logOdds += g.result.llr;
    activeGroups++;

    // F·Genre signal is rendered as [Domain] row — handled separately below
    if (g.label === 'F·Genre') return;

    const dir = g.result.llr > 0.20 ? '↑AI'
              : g.result.llr < -0.20 ? '↓Human'
              :                         '≈';
    signals.push(`[${g.label}] ${g.result.msg} (${dir}, ${g.result.llr.toFixed(2)})`);
  });

  // ── Step 4: sigmoid → probability → score ────────────────────────────────
  const prob  = 1 / (1 + Math.exp(-logOdds));
  const score = Math.round(prob * 100);

  // ── Step 5: Compute base confidence ──────────────────────────────────────
  // Confidence reflects both how many groups fired and how decisive the total is.
  // Fewer than 2 active groups = not enough evidence regardless of log-odds.
  let confidence = activeGroups < 2        ? 'low'
    : Math.abs(logOdds) > 3.5 ? 'high'
    : Math.abs(logOdds) > 1.5 ? 'medium'
    :                            'low';

  // ── Step 6: Apply Group F confidence cap and build Domain signal ──────────
  // The confidence cap is applied by advancing confidence toward 'low'
  // (never away from it — a genre flag can only reduce confidence, not raise it).
  const genreResult = groups[5].result;
  if (genreResult) {
    const capOrder = ['high', 'medium', 'low'];
    if (capOrder.indexOf(confidence) < capOrder.indexOf(genreResult.confidenceCap)) {
      confidence = genreResult.confidenceCap;
    }
    signals.push(`[Domain] ${genreResult.msg}`);
  }

  // ── Step 7: Count group directions for "mixed signals" summary ───────────
  // A group "points AI" if its LLR > 1.0 (meaningfully positive).
  // A group "points Human" if its LLR < -1.0 (meaningfully negative).
  // Used by the verdict renderer to show a split summary when appropriate.
  let aiGroupCount    = 0;
  let humanGroupCount = 0;
  groups.forEach(g => {
    if (!g.result) return;
    if (g.result.llr >  1.0) aiGroupCount++;
    if (g.result.llr < -1.0) humanGroupCount++;
  });

  return {
    score, confidence, logOdds, stratum, signals,
    wordCount, sentenceCount: sentences.length,
    aiGroups: aiGroupCount, humanGroups: humanGroupCount,
  };
}


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — SIGNAL RENDERER
//
// Converts internal signal strings into structured HTML table rows.
//
// SIGNAL STRING FORMAT (produced by analyzeText):
//   "[GroupLabel] message text (↑AI, 2.50)"
//   "[GroupLabel] message text (↓Human, -1.20)"
//   "[GroupLabel] message text (≈, 0.05)"
//   "[Domain] genre message text"     ← no direction/LLR tail
//
// OUTPUT — three-column grid row:
//   Left col   (sig-group)  — group label in amber
//   Centre col (sig-text)   — human-readable message
//   Right col  (sig-llr)    — direction indicator + absolute LLR value
//
// RIGHT COLUMN CONVENTIONS
//   ▲ AI    [red]    — strong AI evidence (|LLR| ≥ 1.5)
//   ▼ AI    [red]    — weak AI evidence   (|LLR| < 1.5)
//   ▲ Human [green]  — strong human evidence
//   ▼ Human [green]  — weak human evidence
//   = neutral [grey] — signal is inconclusive for this text
//
// F·Domain rows (no LLR tail) render "domain / unclear" in the right column.
// "domain unclear" means: this text's genre makes heuristic scoring less
// reliable than usual — not a measurement, a reliability flag.
//
// COLOUR CONVENTION
//   Red   = AI evidence always (regardless of arrow direction)
//   Green = Human evidence always
//   Arrow direction = signal strength (▲ strong, ▼ weak) based on |LLR|
//   Number = absolute value (direction already shown by colour + label)
//
// HTML SANITISATION
//   Body text is sanitised (&, <, >) before insertion to prevent XSS from
//   extracted page text appearing in signal messages.
// ══════════════════════════════════════════════════════════════════════════════

function renderSignals(sigs) {
  // Regex built with constructor to avoid backslash mangling in string literals
  const GROUP_RE = new RegExp('^\\[([^\\]]+)\\]\\s*');

  // Matches trailing direction+LLR: (↑AI, 2.50) / (↓Human, -1.20) / (≈, 0.05)
  // Uses unicode codepoints for arrows to avoid encoding issues:
  //   \u2191 = ↑   \u2193 = ↓   \u2248 = ≈
  const TAIL_RE = new RegExp(
    '\\(([\\u2191\\u2193][^,]+|\\u2248[^,]*),\\s*([-\\d.]+)\\)\\s*$'
  );

  return sigs.map(s => {
    const isDomain   = s.startsWith('[Domain]');
    const groupMatch = s.match(GROUP_RE);
    const group      = groupMatch ? groupMatch[1] : '';

    const tailMatch = s.match(TAIL_RE);
    const dir       = tailMatch ? tailMatch[1] : '';
    const llr       = tailMatch ? parseFloat(tailMatch[2]) : null;

    // Strip group tag and direction tail to isolate the body message
    let body = s.replace(GROUP_RE, '');
    if (tailMatch) {
      const idx = body.lastIndexOf(tailMatch[0]);
      if (idx > -1) body = body.slice(0, idx).trim();
    }

    // Sanitise body text — may contain content extracted from web pages
    body = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // ── F·Domain row — reliability flag, not a scored signal ────────────────
    if (isDomain) {
      return '<div class="signal-row">'
        + '<span class="sig-group">F\u00B7Domain</span>'   // F·Domain
        + '<span class="sig-text">' + body + '</span>'
        + '<span class="sig-llr flat">domain<br>unclear</span>'
        + '</div>';
    }

    // ── Neutral signal ────────────────────────────────────────────────────────
    const isAI    = dir.includes('\u2191');  // ↑
    const isHuman = dir.includes('\u2193');  // ↓
    const absVal  = llr !== null ? Math.abs(llr) : 0;

    if (!isAI && !isHuman) {
      return '<div class="signal-row">'
        + '<span class="sig-group">' + group + '</span>'
        + '<span class="sig-text">'  + body  + '</span>'
        + '<span class="sig-llr flat">= neutral</span>'
        + '</div>';
    }

    // ── Scored signal — colour by direction, arrow by magnitude ──────────────
    const cls   = isAI ? 'up' : 'down';                    // red for AI, green for Human
    const arrow = absVal >= 1.5 ? '\u25b2' : '\u25bc';     // ▲ strong ≥1.5, ▼ weak <1.5
    const lbl   = isAI ? 'AI' : 'Human';

    return '<div class="signal-row">'
      + '<span class="sig-group">' + group + '</span>'
      + '<span class="sig-text">'  + body  + '</span>'
      + '<span class="sig-llr ' + cls + '">'
      + arrow + '\u00a0' + lbl + '<br>' + absVal.toFixed(2)
      + '</span>'
      + '</div>';
  }).join('');
}


// ══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — VERDICT RENDERER
//
// Handles the Check button click: runs analyzeText, maps the score to a
// verdict band, builds the confidence badge, optionally builds the "mixed
// signals" summary, and assembles the final HTML.
//
// VERDICT BANDS (intentionally wide — avoids false certainty at boundaries):
//   ≥ 80  Very Likely AI     🤖 — strong multi-group AI evidence
//   62–79 Possibly AI        🤔 — moderate AI evidence
//   39–61 Inconclusive       🔍 — signals mixed or too weak to decide
//   21–38 Likely Human       🧑 — moderate human evidence
//   ≤ 20  Very Likely Human  ✅ — strong multi-group human evidence
//
// CONFIDENCE BADGE:
//   high   — |log-odds| > 3.5, ≥2 active groups, no genre cap
//   medium — |log-odds| > 1.5, ≥2 active groups (or capped from high by formal genre)
//   low    — weak signal, <2 active groups, or capped by conversational/mixed genre
//
// MIXED SIGNALS SUMMARY LINE:
//   Shown between verdict card and signal table when:
//     • ≥2 groups point AI (LLR > 1.0) AND
//     • ≥2 groups point Human (LLR < -1.0) AND
//     • Score is in the 30–70% range (engine itself is uncertain)
//   This combination means the text is genuinely contested — different
//   linguistic properties are pulling in opposite directions.
// ══════════════════════════════════════════════════════════════════════════════

checkBtn.addEventListener('click', function () {
  const text = textInput.value.trim();
  if (!text) {
    alert("Paste some text first — or click 'Grab Current Page / Paste'.");
    return;
  }

  // ── Run analysis ──────────────────────────────────────────────────────────
  const {
    score, logOdds, stratum, signals,
    wordCount, sentenceCount, confidence,
    aiGroups, humanGroups,
  } = analyzeText(text);

  // ── Map score to verdict band ─────────────────────────────────────────────
  let label, color, barColor, bgClass, icon;
  if      (score >= 80) { label = 'Very Likely AI';    color = '#ff6b6b'; barColor = '#ff6b6b'; bgClass = 'ai';    icon = '🤖'; }
  else if (score >= 62) { label = 'Possibly AI';       color = '#ffaa44'; barColor = '#ffaa44'; bgClass = 'ai';    icon = '🤔'; }
  else if (score <= 20) { label = 'Very Likely Human'; color = '#6bff8e'; barColor = '#6bff8e'; bgClass = 'human'; icon = '✅'; }
  else if (score <= 38) { label = 'Likely Human';      color = '#88dd88'; barColor = '#6bff8e'; bgClass = 'human'; icon = '🧑'; }
  else                  { label = 'Inconclusive';      color = '#aaaaaa'; barColor = '#888888'; bgClass = 'human'; icon = '🔍'; }

  // ── Confidence badge ──────────────────────────────────────────────────────
  const confBadge = confidence === 'high'
    ? '<span style="color:#6bff8e;font-size:10px">&#9679; high confidence</span>'
    : confidence === 'medium'
    ? '<span style="color:#ffaa44;font-size:10px">&#9679; medium confidence</span>'
    : '<span style="color:#666;font-size:10px">&#9679; low confidence — needs more text</span>';

  // ── Mixed signals summary line ────────────────────────────────────────────
  // Only shown when the engine genuinely disagrees with itself: multiple
  // groups pointing AI, multiple groups pointing Human, score in middle band.
  let summaryHtml = '';
  if (aiGroups >= 2 && humanGroups >= 2 && score >= 30 && score <= 70) {
    summaryHtml =
      '<div class="group-summary">'
      + '<span class="gs-ai">'    + aiGroups    + '\u00a0group' + (aiGroups    > 1 ? 's' : '') + '\u00a0\u2192\u00a0AI</span>'
      + '<span class="gs-sep">\u00b7</span>'
      + '<span class="gs-human">' + humanGroups + '\u00a0group' + (humanGroups > 1 ? 's' : '') + '\u00a0\u2192\u00a0Human</span>'
      + '<span class="gs-note">mixed signals</span>'
      + '</div>';
  }

  // ── Assemble and render ───────────────────────────────────────────────────
  resultEl.innerHTML =
    '<div class="verdict ' + bgClass + '">'
    + '<span class="icon">' + icon + '</span>'
    + '<div style="flex:1">'
    + '<div class="label" style="color:' + color + '">' + label + '</div>'
    + '<div class="bar-wrap"><div class="bar-fill" style="width:' + score + '%;background:' + barColor + '"></div></div>'
    + '<div class="sub">'
    + 'AI probability: ' + score + '%'
    + ' &nbsp;&middot;&nbsp; log-odds: ' + logOdds.toFixed(2)
    + ' &nbsp;&middot;&nbsp; ' + wordCount.toLocaleString() + ' tokens / ' + sentenceCount + 's / ' + stratum
    + ' &nbsp;&nbsp;' + confBadge
    + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="signals">' + summaryHtml + renderSignals(signals) + '</div>';
});
