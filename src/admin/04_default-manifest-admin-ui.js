// The /admin screen for the lists on the bare /manifest.json (see
// 67_default-manifest-lists.js for the route behind it). Numbered 04 because the
// dashboard calls it while rendering, and render_check only sees files up to the
// worker's export default (26). Kept in its own file
// because 03_admin.js is over the size limit and may not grow; it is dropped into
// the dashboard from there. One list per line: type | name | source link.

function defaultManifestAdminPanel() {
  return `
  <div class="admin-tab-panel" data-admin-panel="defaultmanifest">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">The <strong>default addon link</strong>: the lists people get from <code>/manifest.json</code> when they add the addon without making their own install link. Apps pick up a change the next time they refresh the addon.</p>
    <div class="panel u-m-0_0_18px u-p-14px_16px u-maxw-520px">
      <label class="u-fs-v_font_size_sm u-c-v_muted u-mb-6px" style="display:block;">Lists, one per line
        <textarea id="defaultManifestLists" class="admin-select u-m-4px_0_0" rows="12" style="display:block; width:100%;" placeholder="movie | Popular Movies | tmdb:chart:popular"></textarea>
      </label>
      <div class="u-fs-v_font_size_xs u-c-v_muted u-mb-14px">Write each line as <strong>movie</strong> or <strong>series</strong>, then the name, then the source link, with a | between them. They show in this order. Delete a line to remove a list.</div>
      <div class="u-gap-10px u-ai-center u-fw2-wrap" style="display:flex;">
        <button type="button" class="primary lc-btn" data-act="saveDefaultManifest">Save</button>
        <a class="secondary lc-btn" href="/manifest.json" target="_blank" rel="noopener">Open the link</a>
        <span id="defaultManifestStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);"></span>
      </div>
    </div>
  </div>
`;
}

// The page script's two functions. Plain strings inside: no template
// placeholders, no closing script tag.
function defaultManifestAdminScript() {
  return `
    async function loadDefaultManifest() {
      const status = document.getElementById('defaultManifestStatus');
      try {
        const res = await fetch('/admin/api/default-manifest', { cache: 'no-store' });
        const data = await res.json();
        if (!data || !data.ok) { if (status) status.textContent = (data && data.error) || 'Could not load.'; return; }
        document.getElementById('defaultManifestLists').value = (data.lists || []).map(function (l) { return l.type + ' | ' + l.name + ' | ' + l.url; }).join('\\n');
      } catch (e) {
        if (status) status.textContent = 'Could not load.';
      }
    }

    async function saveDefaultManifest() {
      const status = document.getElementById('defaultManifestStatus');
      const say = (text, color) => { if (status) { status.textContent = text; status.style.color = color || '#8E8E93'; } };
      const lists = [];
      const lines = document.getElementById('defaultManifestLists').value.split('\\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const parts = lines[i].split('|');
        if (parts.length < 3) { say('Line ' + (i + 1) + ' needs three parts: type | name | source link.', '#ff453a'); return; }
        lists.push({ type: parts[0].trim().toLowerCase(), name: parts[1].trim(), url: parts.slice(2).join('|').trim() });
      }
      say('Saving...');
      try {
        const res = await fetch('/admin/api/default-manifest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lists: lists }),
        });
        const data = await res.json();
        if (!data || !data.ok) { say((data && data.error) || 'Could not save.', '#ff453a'); return; }
        say('Saved. Apps show it the next time they refresh the addon.', '#30d158');
      } catch (e) {
        say('Could not save.', '#ff453a');
      }
    }
`;
}
