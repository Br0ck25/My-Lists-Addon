// The /admin screen for the lists on the bare /manifest.json (see
// 67_default-manifest-lists.js for the route behind it). Numbered 04 because the
// dashboard calls it while rendering, and render_check only sees files up to the
// worker's export default (26). Kept in its own file because 03_admin.js is over
// the size limit and may not grow; it is dropped into the dashboard from there.
//
// A picker, not a form: the admin searches the site's published lists
// (/api/search-published-lists) and clicks Add. Every click saves at once.

function defaultManifestAdminPanel() {
  return `
  <div class="admin-tab-panel" data-admin-panel="defaultmanifest">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">The <strong>default addon link</strong>: the lists people get from <code>/manifest.json</code> when they add the addon without making their own install link. Search the lists published on the site and add the ones you want. Every change is saved straight away, and apps show it the next time they refresh the addon.</p>
    <div class="panel u-m-0_0_18px u-p-14px_16px u-maxw-520px">
      <label class="u-fs-v_font_size_sm u-c-v_muted u-mb-6px" style="display:block;">Search the site's lists
        <input type="text" id="defaultManifestSearch" class="admin-select u-m-4px_0_0" maxlength="80" placeholder="Name or creator" data-act="searchDefaultManifest" data-act-on="keydown" data-act-keys="Enter" style="display:block; width:100%;">
      </label>
      <div class="u-gap-10px u-ai-center u-fw2-wrap u-mb-12px" style="display:flex;">
        <button type="button" class="primary lc-btn" data-act="searchDefaultManifest">Search</button>
        <span id="defaultManifestStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);"></span>
      </div>
      <div id="defaultManifestResults"></div>
    </div>
    <div class="panel u-m-0_0_18px u-p-14px_16px u-maxw-520px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">On the default link</div>
      <div id="defaultManifestCurrent"></div>
      <div class="u-mt-10px"><a class="secondary lc-btn" href="/manifest.json" target="_blank" rel="noopener">Open the link</a></div>
    </div>
  </div>
`;
}

// The page script. Plain strings inside: no template placeholders, no closing
// script tag. Names are built with textContent, never innerHTML, because a list's
// name is written by whoever published it.
function defaultManifestAdminScript() {
  return `
    var defaultManifestState = [];
    var defaultManifestFound = [];

    // What one search result becomes on the link: a Movies row, a Series row,
    // or both for a list that holds both.
    function defaultManifestRowsFor(found) {
      const types = found.type === 'movie' ? ['movie'] : (found.type === 'series' ? ['series'] : ['movie', 'series']);
      return types.map(function (t) { return { type: t, name: found.name, url: found.url }; });
    }

    // New rows go last; a row already there (same type, same link) is not added again.
    function defaultManifestMerge(current, rows) {
      const out = current.slice();
      rows.forEach(function (r) {
        if (!out.some(function (c) { return c.type === r.type && c.url === r.url; })) out.push(r);
      });
      return out;
    }

    function defaultManifestSay(text, color) {
      const status = document.getElementById('defaultManifestStatus');
      if (status) { status.textContent = text; status.style.color = color || '#8E8E93'; }
    }

    function defaultManifestEl(tag, text, cls) {
      const el = document.createElement(tag);
      if (text) el.textContent = text;
      if (cls) el.className = cls;
      return el;
    }

    function defaultManifestButton(label, onClick, disabled) {
      const b = defaultManifestEl('button', label, 'secondary lc-btn');
      b.type = 'button';
      b.disabled = !!disabled;
      b.addEventListener('click', onClick);
      return b;
    }

    function defaultManifestLine(titleText, detailText, buttons) {
      const row = defaultManifestEl('div', '', 'u-ai-center u-gap-8px u-mb-6px');
      row.style.display = 'flex';
      const text = defaultManifestEl('div', '', '');
      text.style.flex = '1';
      text.style.minWidth = '0';
      text.appendChild(defaultManifestEl('div', titleText, 'u-fw-600 u-fs-v_font_size_sm'));
      text.appendChild(defaultManifestEl('div', detailText, 'u-c-v_muted u-fs-v_font_size_xs'));
      row.appendChild(text);
      buttons.forEach(function (b) { row.appendChild(b); });
      return row;
    }

    function renderDefaultManifest() {
      const box = document.getElementById('defaultManifestCurrent');
      if (box) {
        box.textContent = '';
        if (!defaultManifestState.length) box.appendChild(defaultManifestEl('div', 'Nothing yet. People who add the addon without an install link get no lists.', 'u-c-v_muted u-fs-v_font_size_sm'));
        defaultManifestState.forEach(function (r, i) {
          const kind = r.type === 'series' ? 'Series' : 'Movies';
          box.appendChild(defaultManifestLine(r.name, kind, [
            defaultManifestButton('Up', function () { defaultManifestMove(i, -1); }, i === 0),
            defaultManifestButton('Down', function () { defaultManifestMove(i, 1); }, i === defaultManifestState.length - 1),
            defaultManifestButton('Remove', function () { defaultManifestRemove(i); }, false),
          ]));
        });
      }
      const results = document.getElementById('defaultManifestResults');
      if (results) {
        results.textContent = '';
        defaultManifestFound.forEach(function (f) {
          const rows = defaultManifestRowsFor(f);
          const added = defaultManifestMerge(defaultManifestState, rows).length === defaultManifestState.length;
          const detail = (f.creatorName ? 'by ' + f.creatorName + ' · ' : '') + (f.items || 0) + ' titles · ' + (f.type === 'movie' ? 'Movies' : (f.type === 'series' ? 'Series' : 'Movies and series'));
          results.appendChild(defaultManifestLine(f.name, detail, [
            defaultManifestButton(added ? 'Added' : 'Add', function () { defaultManifestSave(defaultManifestMerge(defaultManifestState, rows), '"' + f.name + '" added.'); }, added),
          ]));
        });
      }
    }

    function defaultManifestMove(i, by) {
      const next = defaultManifestState.slice();
      const j = i + by;
      if (j < 0 || j >= next.length) return;
      const hold = next[i]; next[i] = next[j]; next[j] = hold;
      defaultManifestSave(next, 'Moved.');
    }

    function defaultManifestRemove(i) {
      const gone = defaultManifestState[i];
      defaultManifestSave(defaultManifestState.filter(function (r, k) { return k !== i; }), '"' + gone.name + '" removed.');
    }

    async function defaultManifestSave(next, doneText) {
      defaultManifestSay('Saving…');
      try {
        const res = await fetch('/admin/api/default-manifest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lists: next }),
        });
        const data = await res.json();
        if (!data || !data.ok) { defaultManifestSay((data && data.error) || 'Could not save.', '#ff453a'); return; }
        defaultManifestState = (data.lists || []).map(function (l) { return { type: l.type, name: l.name, url: l.url }; });
        renderDefaultManifest();
        defaultManifestSay(doneText, '#30d158');
      } catch (e) {
        defaultManifestSay('Could not save.', '#ff453a');
      }
    }

    async function loadDefaultManifest() {
      try {
        const res = await fetch('/admin/api/default-manifest', { cache: 'no-store' });
        const data = await res.json();
        if (!data || !data.ok) { defaultManifestSay((data && data.error) || 'Could not load.', '#ff453a'); return; }
        defaultManifestState = (data.lists || []).map(function (l) { return { type: l.type, name: l.name, url: l.url }; });
        renderDefaultManifest();
      } catch (e) {
        defaultManifestSay('Could not load.', '#ff453a');
      }
    }

    async function searchDefaultManifest() {
      const q = (document.getElementById('defaultManifestSearch').value || '').trim();
      if (!q) { defaultManifestSay('Type a name to search.', '#ff453a'); return; }
      defaultManifestSay('Searching…');
      try {
        const res = await fetch('/api/search-published-lists?q=' + encodeURIComponent(q), { cache: 'no-store' });
        const data = await res.json();
        if (!data || !data.ok) { defaultManifestSay((data && data.error) || 'Could not search.', '#ff453a'); return; }
        defaultManifestFound = (data.lists || []).filter(function (l) { return l && l.name && l.url; }).slice(0, 30);
        renderDefaultManifest();
        defaultManifestSay(defaultManifestFound.length ? '' : 'No lists found.');
      } catch (e) {
        defaultManifestSay('Could not search.', '#ff453a');
      }
    }
`;
}
