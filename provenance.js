// Data provenance and API source mapping engine. Pure functions, no DOM.

const MAX_INDEX_ITEMS = 500;
const MAX_DEPTH = 8;

function normalizeText(str) {
  if (typeof str !== 'string') return '';
  return str.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Strip currency symbols, commas, percent, whitespace
const CURRENCY_OR_PUNCT = /[৳$€£¥₹\s,%\u00a0]/g;

function extractNumeric(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val !== 'string') return null;
  let s = val.replace(/[৳$€£¥₹\s\u00a0%]/g, '').trim();
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+,\d{1,2}$/.test(s)) {
    s = s.replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const num = parseFloat(s);
  return Number.isFinite(num) ? num : null;
}

function parseDateIso(str) {
  if (typeof str !== 'string' || str.length < 10) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(str)) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function matchBooleanText(boolVal, text) {
  const norm = normalizeText(text);
  if (boolVal === true) {
    return ['true', 'yes', 'available', 'in stock', 'active', 'enabled', 'on'].includes(norm);
  }
  if (boolVal === false) {
    return ['false', 'no', 'unavailable', 'out of stock', 'inactive', 'disabled', 'off'].includes(norm);
  }
  return false;
}

function matchDateText(dateObj, text) {
  const norm = normalizeText(text);
  if (!norm) return false;
  // ponytail: standard locale string representations. Upgrade path: Intl format scanner.
  const iso = dateObj.toISOString().slice(0, 10);
  if (norm.includes(iso)) return true;
  const parts = [
    dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
    dateObj.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    dateObj.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }),
  ].map(s => normalizeText(s));
  return parts.some(p => norm.includes(p) || p.includes(norm));
}

function indexResponseBody(entry) {
  if (!entry) return null;
  if (entry.__provenanceIndex) return entry.__provenanceIndex;

  const body = entry.responseBody != null ? entry.responseBody : (entry.kind === 'wsframe' ? entry.data : null);
  if (typeof body !== 'string' || !body.trim()) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    if (typeof tryParsePartialJson === 'function') {
      parsed = tryParsePartialJson(body);
    }
  }

  if (parsed === null || typeof parsed !== 'object') {
    const idx = { isJson: false, raw: body };
    entry.__provenanceIndex = idx;
    return idx;
  }

  const primitives = [];
  const objectGroups = new Map();
  const valueCounts = new Map();

  function walk(curr, path, depth) {
    if (depth > MAX_DEPTH || primitives.length >= MAX_INDEX_ITEMS) return;
    if (curr === null || typeof curr !== 'object') return;

    const isArr = Array.isArray(curr);
    const keys = Object.keys(curr);
    const siblings = [];

    for (const k of keys) {
      if (primitives.length >= MAX_INDEX_ITEMS) break;
      const val = curr[k];
      const childPath = path ? (isArr ? `${path}[${k}]` : `${path}.${k}`) : k;

      if (val !== null && typeof val === 'object') {
        walk(val, childPath, depth + 1);
      } else if (val !== undefined) {
        const item = {
          path: childPath,
          key: k,
          value: val,
          strVal: String(val),
          numVal: extractNumeric(val),
          dateVal: typeof val === 'string' ? parseDateIso(val) : null,
          parentPath: path || '',
        };
        primitives.push(item);
        siblings.push(item);
        const vKey = typeof val === 'number' ? `num:${val}` : `str:${String(val)}`;
        valueCounts.set(vKey, (valueCounts.get(vKey) || 0) + 1);
      }
    }

    if (siblings.length) {
      objectGroups.set(path || '', siblings);
    }
  }

  walk(parsed, '', 0);

  const index = { isJson: true, primitives, objectGroups, valueCounts, raw: body };
  entry.__provenanceIndex = index;
  return index;
}

function findContainerDataSources(context, entries, options = {}) {
  const requestMap = new Map();

  for (const subCtx of context.subElements) {
    const res = findDataSources(subCtx, entries, { maxCandidates: 3 });
    if (!res || !res.candidates || !res.candidates.length) continue;
    const top = res.candidates[0];

    const reqKey = top.requestId || top.url;
    let group = requestMap.get(reqKey);
    if (!group) {
      group = {
        entry: top.entry,
        requestId: top.requestId,
        url: top.url,
        method: top.method,
        status: top.status,
        contentType: top.contentType,
        startedAt: top.startedAt,
        sourceType: top.sourceType,
        matchedFields: [],
      };
      requestMap.set(reqKey, group);
    }

    if (!group.matchedFields.some(f => f.jsonPath === top.jsonPath && f.displayedValue === top.displayedValue)) {
      group.matchedFields.push({
        displayedValue: top.displayedValue,
        apiValue: top.apiValue,
        jsonPath: top.jsonPath,
        matchReason: top.matchReason,
        confidence: top.confidence,
        confidenceScore: top.confidenceScore,
      });
    }
  }

  const contributingRequests = Array.from(requestMap.values()).map(group => {
    const count = group.matchedFields.length;
    const hasHigh = group.matchedFields.some(f => f.confidence === 'High');
    const confidence = (count >= 2 || hasHigh) ? 'High' : (count === 1 ? group.matchedFields[0].confidence : 'Low');
    const avgScore = group.matchedFields.reduce((sum, f) => sum + f.confidenceScore, 0) / (count || 1);
    return {
      ...group,
      confidence,
      confidenceScore: Math.min(99, Math.round(avgScore + (count > 1 ? 15 : 0))),
      matchCount: count,
    };
  }).sort((a, b) => b.matchCount - a.matchCount || b.confidenceScore - a.confidenceScore);

  return {
    isContainer: true,
    contributingRequests,
    totalFieldsMatched: contributingRequests.reduce((sum, r) => sum + r.matchCount, 0),
    fallback: contributingRequests.length === 0
      ? (context.inInitialHtml
          ? 'Source: Server-rendered / initial document\nNo matching fields found in hydration state.'
          : 'No network requests or hydration data matched any fields inside this container element.')
      : null,
  };
}

function findDataSources(context, entries, options = {}) {
  const ssr = context && context.ssrPayloads;
  const allEntries = (!ssr || !ssr.length) ? (entries || []) : (entries || []).concat(
    ssr.filter(s => s && s.json).map((s, i) => ({
      id: s.id || `ssr-${i}`,
      kind: 'ssr',
      method: 'SSR',
      url: s.name || 'Server Hydration State',
      status: 200,
      contentType: 'application/json',
      startedAt: 0,
      responseBody: s.json,
    }))
  );

  if (!context || !allEntries.length) {
    return {
      candidates: [],
      fallback: context && context.inInitialHtml
        ? (ssr && ssr.length
            ? 'Source: Server-rendered / initial document\nNo matching field found in embedded hydration state.'
            : 'Source: Server-rendered / initial document')
        : 'No matching network source found.\nPossible source:\n- server-rendered HTML\n- localStorage / sessionStorage\n- hardcoded/static data\n- transformed/generated value',
    };
  }

  if (context.isContainer && Array.isArray(context.subElements) && context.subElements.length > 1) {
    return findContainerDataSources(context, allEntries, options);
  }

  const targetText = typeof context.text === 'string' ? context.text.trim() : '';
  const normTarget = normalizeText(targetText);
  const cleanTarget = normTarget.replace(/\.{3}$|…$/, '').trim();
  const firstLineTarget = normalizeText(targetText.split(/[\r\n]+/)[0] || '').replace(/\.{3}$|…$/, '').trim();
  const targetNum = extractNumeric(targetText);
  const targetAttributes = context.attributes || {};
  const nearbyText = normalizeText(context.nearbyText || '');
  const containerTexts = Array.isArray(context.containerTexts) ? context.containerTexts : [];
  const normContainer = containerTexts.map(t => normalizeText(t)).filter(Boolean);

  const candidates = [];
  const maxCandidates = options.maxCandidates || 20;

  for (const item of allEntries) {
    const entry = (item && item.data && typeof item.data === 'object' && !item.kind) ? item.data : item;
    if (!entry) continue;

    const index = indexResponseBody(entry);
    if (!index) continue;

    if (!index.isJson) {
      if (targetText && index.raw.includes(targetText)) {
        candidates.push({
          entry,
          requestId: entry.id,
          url: entry.url,
          method: entry.method || (entry.kind === 'wsframe' ? `WS ${entry.dir || 'frame'}` : 'GET'),
          status: entry.status,
          contentType: entry.contentType,
          startedAt: entry.startedAt,
          jsonPath: null,
          apiValue: targetText,
          displayedValue: targetText,
          confidence: 'Low',
          confidenceScore: 40,
          matchReason: 'exact-value',
          matchDetails: entry.kind === 'ssr'
            ? `Found in plain-text SSR content (${entry.url})`
            : 'Found inside plain-text / non-JSON response body',
          sourceType: entry.kind === 'ssr' ? 'ssr' : (entry.kind === 'wsframe' ? 'websocket' : 'network'),
        });
      }
      continue;
    }

    // 1. Primitive field checks
    for (const prim of index.primitives) {
      let score = 0;
      let reason = null;
      let details = '';

      // Exact match
      if (prim.strVal === targetText || (typeof prim.value === 'string' && prim.value === targetText)) {
        score = targetText.length > 2 ? 90 : 55;
        if (targetNum !== null && targetNum < 1000) {
          score = 65;
        }
        reason = 'exact-value';
        details = 'Exact value match';
      }
      // Numeric normalization match (with financial 2-decimal rounding tolerance)
      else if (targetNum !== null && prim.numVal !== null && (
        Math.abs(targetNum - prim.numVal) < 0.01 ||
        Math.abs(Math.round(targetNum * 100) - Math.round(prim.numVal * 100)) <= 1
      )) {
        score = 60;
        reason = 'numeric-match';
        details = `Numeric match (${prim.numVal} ↔ ${targetText})`;
      }
      // Normalized text match
      else if (normTarget && normalizeText(prim.strVal) === normTarget) {
        score = 75;
        reason = 'normalized-value';
        details = 'Normalized text match';
      }
      // Normalized text match (full or first line)
      else if (normTarget && (normalizeText(prim.strVal) === normTarget || (firstLineTarget && normalizeText(prim.strVal) === firstLineTarget))) {
        score = 80;
        reason = 'normalized-value';
        details = 'Normalized text match';
      }
      // Substring / prefix / truncated match for non-trivial strings (length >= 5)
      else if (typeof prim.value === 'string' && prim.value.trim().length >= 5 && (cleanTarget.length >= 5 || firstLineTarget.length >= 5)) {
        const pNorm = normalizeText(prim.strVal);
        const searchTarget = cleanTarget.length >= 5 ? cleanTarget : firstLineTarget;
        if (pNorm.includes(searchTarget) || searchTarget.includes(pNorm)) {
          score = 75;
          reason = 'normalized-value';
          details = `Substring match ("${searchTarget}" ↔ "${prim.strVal}")`;
        }
      }
      // Boolean match
      else if (typeof prim.value === 'boolean' && matchBooleanText(prim.value, targetText)) {
        score = 70;
        reason = 'normalized-value';
        details = `Boolean representation (${prim.value} ↔ "${targetText}")`;
      }
      // Date match
      else if (prim.dateVal && matchDateText(prim.dateVal, targetText)) {
        score = 75;
        reason = 'normalized-value';
        details = `Formatted date (${prim.strVal} ↔ "${targetText}")`;
      }
      // Attribute match (e.g. image src, link href, data-id)
      else if (typeof prim.value === 'string' && prim.value.length > 3) {
        for (const [attrKey, attrVal] of Object.entries(targetAttributes)) {
          if (typeof attrVal === 'string' && (attrVal === prim.value || attrVal.endsWith(prim.value) || prim.value.endsWith(attrVal))) {
            score = 85;
            reason = 'attribute-match';
            details = `Attribute [${attrKey}] matched API value`;
            break;
          }
        }
      }

      if (score > 0) {
        // Context & key match bonus: does the JSON key or path resemble nearby DOM text, class, or id?
        const normKey = normalizeText(prim.key);
        if (normKey && normKey.length > 2) {
          if (nearbyText.includes(normKey) || (context.id && normalizeText(context.id).includes(normKey))) {
            score += 10;
            details += ` · Key "${prim.key}" corroborated by DOM label/ID`;
          } else if (Array.isArray(context.classes) && context.classes.some(c => normalizeText(c).includes(normKey))) {
            score += 5;
            details += ` · Key "${prim.key}" corroborated by element class`;
          }
        }

        // Structural corroboration: do other fields of the same parent object appear in the DOM container?
        const siblings = index.objectGroups.get(prim.parentPath) || [];
        const corroborated = [];
        for (const sib of siblings) {
          if (sib.path === prim.path) continue;
          const sibNorm = normalizeText(sib.strVal);
          if (sibNorm.length > 2 && normContainer.some(c => c.includes(sibNorm))) {
            corroborated.push(sib.path);
          }
        }
        if (corroborated.length > 0) {
          score += 15;
          details += ` · Corroborated by sibling fields (${corroborated.slice(0, 2).join(', ')})`;
        }

        const occurrences = (index.valueCounts && index.valueCounts.get(typeof prim.value === 'number' ? `num:${prim.value}` : `str:${String(prim.value)}`)) || 1;
        if (occurrences > 1 && corroborated.length === 0) {
          score = Math.min(score, 55);
          details += ' · Appears in multiple response fields';
        }

        const confidence = score >= 80 ? 'High' : (score >= 60 ? 'Medium' : 'Low');
        candidates.push({
          entry,
          requestId: entry.id,
          url: entry.url,
          method: entry.method || (entry.kind === 'wsframe' ? `WS ${entry.dir || 'frame'}` : 'GET'),
          status: entry.status,
          contentType: entry.contentType,
          startedAt: entry.startedAt,
          jsonPath: prim.path,
          apiValue: prim.value,
          displayedValue: targetText,
          confidence,
          confidenceScore: score,
          matchReason: reason,
          matchDetails: entry.kind === 'ssr'
            ? `${details} · Hydration state (${entry.url})`
            : details,
          sourceType: entry.kind === 'ssr' ? 'ssr' : (entry.kind === 'wsframe' ? 'websocket' : 'network'),
        });
      }
    }

    // 2. Combined fields match (e.g. firstName + ' ' + lastName)
    if (normTarget && normTarget.includes(' ')) {
      for (const [parentPath, siblings] of index.objectGroups.entries()) {
        if (siblings.length < 2) continue;
        const stringSibs = siblings.filter(s => typeof s.value === 'string' && s.value.trim().length > 1);
        for (let i = 0; i < stringSibs.length; i++) {
          for (let j = 0; j < stringSibs.length; j++) {
            if (i === j) continue;
            const combined = normalizeText(`${stringSibs[i].value} ${stringSibs[j].value}`);
            if (combined === normTarget) {
              const combinedPath = `${stringSibs[i].path} + ' ' + ${stringSibs[j].path}`;
              candidates.push({
                entry,
                requestId: entry.id,
                url: entry.url,
                method: entry.method || 'GET',
                status: entry.status,
                contentType: entry.contentType,
                startedAt: entry.startedAt,
                jsonPath: combinedPath,
                apiValue: `${stringSibs[i].value} ${stringSibs[j].value}`,
                displayedValue: targetText,
                confidence: 'High',
                confidenceScore: 88,
                matchReason: 'combined-fields',
                matchDetails: entry.kind === 'ssr'
                  ? `Constructed from adjacent hydration fields (${entry.url})`
                  : `Combined fields from ${parentPath || 'root'}`,
                sourceType: entry.kind === 'ssr' ? 'ssr' : 'network',
              });
            }
          }
        }
      }
    }
  }

  // 3. Container entity fallback: if direct match found nothing, search for card entity in containerTexts
  if (candidates.length === 0 && (targetNum !== null || normTarget.length > 0)) {
    const candidateEntities = containerTexts
      .map(t => normalizeText(t).replace(/\.{3}$|…$/, '').trim())
      .filter(t => t.length >= 5 && !/^(price|view|quick view|view all|add to cart|details|book|select|more|hotels?|rooms?)$/i.test(t));

    for (const item of entries) {
      const entry = (item && item.data && typeof item.data === 'object' && !item.kind) ? item.data : item;
      if (!entry) continue;
      const index = indexResponseBody(entry);
      if (!index || !index.isJson) continue;

      for (const entityStr of candidateEntities) {
        const matchedPrim = index.primitives.find(p => {
          if (typeof p.value !== 'string' || p.value.length < 5) return false;
          const pNorm = normalizeText(p.strVal);
          return pNorm === entityStr || pNorm.includes(entityStr) || entityStr.includes(pNorm);
        });

        if (matchedPrim) {
          const commonPrefix = matchedPrim.parentPath;
          const relatedPrims = index.primitives.filter(p => {
            if (p.path === matchedPrim.path) return false;
            return commonPrefix && p.path.startsWith(commonPrefix);
          });

          const pricePrims = relatedPrims.filter(p => p.numVal !== null && /price|rate|amount|total|cost|fee|charge|customer|purchase|supplier|fmg/i.test(p.key));
          const bestPrim = pricePrims.length > 0 ? pricePrims[0] : relatedPrims.find(p => p.numVal !== null);

          if (bestPrim) {
            candidates.push({
              entry,
              requestId: entry.id,
              url: entry.url,
              method: entry.method || (entry.kind === 'wsframe' ? `WS ${entry.dir || 'frame'}` : 'GET'),
              status: entry.status,
              contentType: entry.contentType,
              startedAt: entry.startedAt,
              jsonPath: bestPrim.path,
              apiValue: bestPrim.value,
              displayedValue: targetText,
              confidence: 'Medium',
              confidenceScore: 65,
              matchReason: 'container-entity',
              matchDetails: entry.kind === 'ssr'
                ? `Matched via card entity "${matchedPrim.value}" in hydration state (${entry.url}). Displayed value is likely calculated or marked up from this field.`
                : `Matched via card entity "${matchedPrim.value}". Displayed value is likely calculated or marked up from this field.`,
              sourceType: entry.kind === 'ssr' ? 'ssr' : (entry.kind === 'wsframe' ? 'websocket' : 'network'),
            });
            break;
          }
        }
      }
    }
  }

  // Deduplicate candidates by entry id + jsonPath, keeping highest score
  const unique = new Map();
  for (const c of candidates) {
    const key = `${c.requestId || c.url}:${c.jsonPath}:${c.apiValue}`;
    const existing = unique.get(key);
    if (!existing || c.confidenceScore > existing.confidenceScore) {
      unique.set(key, c);
    }
  }

  const sorted = Array.from(unique.values()).sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
    return (b.startedAt || 0) - (a.startedAt || 0);
  }).slice(0, maxCandidates);

  return {
    candidates: sorted,
    fallback: sorted.length === 0
      ? (context.inInitialHtml
          ? (ssr && ssr.length
              ? 'Source: Server-rendered / initial document\nNo matching field found in embedded hydration state.'
              : 'Source: Server-rendered / initial document')
          : 'No matching network source found.\nPossible source:\n- server-rendered HTML\n- localStorage / sessionStorage\n- hardcoded/static data\n- transformed/generated value')
      : null,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    normalizeText,
    extractNumeric,
    parseDateIso,
    indexResponseBody,
    findDataSources,
  };
}
