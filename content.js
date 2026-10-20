// ── AI Bouncer — Content Script (mini Trafilatura) ───────────────────────────
// Injected into the active tab. Scores DOM blocks by content density,
// strips boilerplate, returns the main article text.

(function () {

  // ── 1. Boilerplate tag/role/class signatures to always skip ─────────────
  const SKIP_TAGS = new Set([
    'script','style','noscript','nav','footer','header','aside',
    'form','button','input','select','textarea','iframe','svg',
    'figure','figcaption','dialog','menu'
  ]);

  const SKIP_ROLES = new Set([
    'navigation','banner','contentinfo','complementary',
    'search','form','dialog','alert','menubar'
  ]);

  // Class/id fragments that strongly suggest boilerplate
  const SKIP_PATTERNS = [
    'nav','menu','sidebar','footer','header','cookie','banner',
    'advertisement','advert',' ad-','widget','popup','modal',
    'breadcrumb','pagination','comment','share','social','related',
    'newsletter','subscribe','signup','login','search','toolbar',
    'masthead','byline','tag','category','metadata','author-bio'
  ];

  function isBoilerplate(el) {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return true;
    if (SKIP_ROLES.has(el.getAttribute('role'))) return true;

    const cls  = (el.className || '').toLowerCase();
    const id   = (el.id || '').toLowerCase();
    const combined = cls + ' ' + id;
    return SKIP_PATTERNS.some(p => combined.includes(p));
  }

  // ── 2. Score a block by text density ────────────────────────────────────
  function scoreBlock(el) {
    const text      = el.innerText || '';
    const textLen   = text.trim().length;
    if (textLen < 80) return 0;                     // too short to matter

    const html      = el.innerHTML || '';
    const links     = el.querySelectorAll('a');
    const linkChars = Array.from(links).reduce((n, a) => n + (a.innerText||'').length, 0);

    // Link density: high = navigation, low = content
    const linkDensity = textLen > 0 ? linkChars / textLen : 1;
    if (linkDensity > 0.5) return 0;

    // Text-to-HTML ratio: content blocks have lots of text relative to markup
    const textRatio = textLen / (html.length || 1);

    // Paragraph density: real articles have <p> tags
    const pCount    = el.querySelectorAll('p').length;

    // Tag bonuses
    const tag = el.tagName.toLowerCase();
    const tagBonus = { article: 30, main: 25, section: 10, div: 0, p: 5 }[tag] ?? 0;

    // Class/id bonuses
    const cls = (el.className + ' ' + el.id).toLowerCase();
    const contentHints = ['article','content','post','story','body','text','entry','main'];
    const clsBonus = contentHints.some(h => cls.includes(h)) ? 15 : 0;

    return (textRatio * 40) + (pCount * 3) + tagBonus + clsBonus;
  }

  // ── 3. Walk the DOM, collect candidate blocks ────────────────────────────
  function extractMainText() {

    // First try semantic landmarks — fast path
    const landmarks = ['article', 'main', '[role="main"]', '[role="article"]'];
    for (const sel of landmarks) {
      const el = document.querySelector(sel);
      if (el && !isBoilerplate(el)) {
        const text = cleanText(el.innerText);
        if (text.length > 200) return { text, method: sel };
      }
    }

    // Fallback: score all block-level elements
    const candidates = [];
    const blocks = document.querySelectorAll(
      'div, section, article, main, p, td'
    );

    blocks.forEach(el => {
      if (isBoilerplate(el)) return;
      // Skip elements nested inside already-candidate parents to avoid duplication
      const score = scoreBlock(el);
      if (score > 10) candidates.push({ el, score });
    });

    if (candidates.length === 0) {
      // Last resort — just grab body text
      return { text: cleanText(document.body.innerText), method: 'body-fallback' };
    }

    // Sort by score, pick the top block
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // Also check if merging the top 3 gives more text without duplication
    const topTexts = candidates.slice(0, 3).map(c => cleanText(c.el.innerText));
    const merged   = mergeDedupe(topTexts);

    const bestText = cleanText(best.el.innerText);
    const result   = merged.length > bestText.length * 1.3 ? merged : bestText;

    return { text: result, method: 'density-scoring' };
  }

  // ── 4. Helpers ───────────────────────────────────────────────────────────

  function cleanText(raw) {
    return raw
      .replace(/\t/g, ' ')
      .replace(/ {2,}/g, ' ')          // collapse multiple spaces
      .replace(/\n{3,}/g, '\n\n')      // max 2 consecutive newlines
      .replace(/[ \t]+\n/g, '\n')      // trailing spaces on lines
      .trim();
  }

  function mergeDedupe(texts) {
    // Simple deduplication: split into sentences, keep unique ones in order
    const seen = new Set();
    const sentences = [];
    texts.forEach(t => {
      t.split(/(?<=[.!?])\s+/).forEach(s => {
        const key = s.trim().toLowerCase().slice(0, 60);
        if (key.length > 20 && !seen.has(key)) {
          seen.add(key);
          sentences.push(s.trim());
        }
      });
    });
    return sentences.join(' ');
  }

  // ── 5. Run and return result to popup ───────────────────────────────────
  try {
    const { text, method } = extractMainText();
    const wordCount = (text.match(/\b\w+\b/g) || []).length;
    return { success: true, text, method, wordCount };
  } catch (err) {
    return { success: false, error: err.message };
  }

})();
