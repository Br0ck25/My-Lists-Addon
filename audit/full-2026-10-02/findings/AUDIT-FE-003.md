## [AUDIT-FE-003] [P3] executeUnifiedListSearch overwrites newer search results when fallback search resolves out-of-order

- **Area:** Frontend Async / Search Concurrency
- **Confidence:** HIGH (reproduced deterministically via automated probe)
- **Location:** `19_client-search-and-likes.js:840-865` (`executeUnifiedListSearch`)

### Actual Behavior
In `executeUnifiedListSearch(rawQuery, targetBox)`:
```javascript
  const thisSeq = ++currentListSearchSequence;
  ...
  const [mdblistAll, traktResult, myListsResult, tmdbResult, traktPopular] = await Promise.all(fetches);

  // If a newer search query was already submitted by the user while this one was running, discard this response!
  if (thisSeq !== currentListSearchSequence) {
    return;
  }
  ...
  if (mdblistMatches.length === 0 && traktMatches.length === 0 && tmdbMatches.length === 0 && myListsMatches.length === 0) {
    const altTerm = searchTerm
      .replace(/\bpickup\b/gi, 'pick up')
      .replace(/\bpick up\b/gi, 'pickup')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([a-zA-Z])(\d+)/g, '$1 $2');
    if (altTerm !== searchTerm) {
      try {
        const altRes = await fetch(ORIGIN + '/api/tmdb-search-lists?q=' + encodeURIComponent(altTerm) + ...);
        if (altRes.ok && (altRes.headers.get('content-type') || '').includes('application/json')) {
          const altData = await altRes.json();
          if (altData && altData.ok && Array.isArray(altData.lists) && altData.lists.length > 0) {
            tmdbMatches.push(...altData.lists);
          }
        }
      } catch (e) {}
    }
  }

  // Save to client cache
  window._unifiedSearchCache.set(cacheKey, { ... });
  renderListSearchResults(mdblistMatches, traktMatches, traktError, myListsMatches, tmdbMatches, box, intent);
```
While the primary search checks `if (thisSeq !== currentListSearchSequence) return;` at line 821, there is NO sequence freshness check after the second asynchronous `await fetch` at line 842. If the user continues typing and a newer query starts and finishes while the fallback search is in flight, the fallback search completes later, passes directly to lines 854-864, caches its results, and calls `renderListSearchResults(...)`.

This completely overwrites the user's active, newer search results with the stale fallback results of the superseded query.

In addition, lines 836-837 chain two reciprocal `.replace()` calls:
```javascript
.replace(/\bpickup\b/gi, 'pick up')
.replace(/\bpick up\b/gi, 'pickup')
```
Because they execute in sequence on the same string, `'pickup'` is replaced by `'pick up'` on line 836, and then immediately converted back to `'pickup'` on line 837, making the `'pickup'` fallback substitution completely ineffective.

### Expected Behavior (cite source)
All asynchronous return points in search workflows must verify that their sequence ID matches the current active search sequence before updating the DOM or caches (as correctly implemented in `runCatalogSearch` at `19_client-search-and-likes.js:5058`: `if (thisSeq !== currentTitleSearchSequence) return;`).

### Why This Is Wrong
When users type quickly into the search box, if an earlier query yields 0 primary results and triggers an alternate-term query, its slower network response clobbers the active search results of whatever the user typed next, causing search result flicker and wrong content presentation.

### Evidence
Demonstrated deterministically in probe `probes/p07_frontend_state_async.mjs`:
```
✔ AUDIT-FE-003: executeUnifiedListSearch overwrites newer query with out-of-order fallback results
```
When Query 1 triggers a fallback search and Query 2 renders before that fallback resolves, Query 1 overwrites Query 2's results in `targetBox` upon late resolution.

### Reproduction (probe path)
`audit/full-2026-10-02/probes/p07_frontend_state_async.mjs` test 3.

### Negative Control
`runCatalogSearch()` in `19_client-search-and-likes.js:5039-5074` guards all post-await steps with `if (thisSeq !== currentTitleSearchSequence) return;`, properly dropping late-arriving responses without DOM contamination (verified in probe test 5).

### Root Cause
Missing sequence counter check following the second asynchronous fetch in the fallback branch of `executeUnifiedListSearch`.

### Impact
Minor severity (P3). Transient UI inconsistency and stale search results displayed upon specific fallback search queries.

### Coverage Gap
Existing tests in `tests/client.test.mjs` and `tests/search-list-chips.client.test.mjs` tested search result rendering without interleaving concurrent out-of-order queries during the fallback branch.

### Fix Direction (nature only, do NOT implement)
Insert `if (thisSeq !== currentListSearchSequence) return;` immediately after the fallback `if (altTerm !== searchTerm) { ... }` block, and make reciprocal word substitutions mutually exclusive.

### Regression Test
Included in `audit/full-2026-10-02/probes/p07_frontend_state_async.mjs`.
