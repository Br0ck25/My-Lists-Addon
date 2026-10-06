<div class="tab-panel" data-tab-panel="settings" id="content-settings" role="tabpanel" aria-labelledby="tab-desktop-settings" hidden>
  <!-- Settings Top Submenu Pills -->
  <div class="subnav-pills-bar" id="settingsSubnavBar">
    <button type="button" class="subnav-pill active" data-sub="account" data-act="switchSettingsSubmenu" data-act-args="[&quot;account&quot;,&quot;@self&quot;]"><span class="check-icon">&#x2713;</span> Account &amp; Security</button>
    <button type="button" class="subnav-pill" data-sub="display" data-act="switchSettingsSubmenu" data-act-args="[&quot;display&quot;,&quot;@self&quot;]">Catalog &amp; Display</button>
    <button type="button" class="subnav-pill" data-sub="scrobble" data-act="switchSettingsSubmenu" data-act-args="[&quot;scrobble&quot;,&quot;@self&quot;]">Tracking &amp; Scrobble</button>
    <button type="button" class="subnav-pill" data-sub="external" data-act="switchSettingsSubmenu" data-act-args="[&quot;external&quot;,&quot;@self&quot;]">Connected Services</button>
    <button type="button" class="subnav-pill" data-sub="backup" data-act="switchSettingsSubmenu" data-act-args="[&quot;backup&quot;,&quot;@self&quot;]">Presets &amp; Backup</button>
    <button type="button" class="subnav-pill" data-sub="feedback" data-act="switchSettingsSubmenu" data-act-args="[&quot;feedback&quot;,&quot;@self&quot;]">Feedback &amp; Support</button>
  </div>

  <!-- Submenu 2: Presets & Backup -->
  <div class="settings-subpanel" id="settingsSubBackup" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <h2 class="shelf-title u-m-0">My Presets <span class="badge" id="presetsCountBadge"></span></h2>
        <div>
          <button type="button" class="secondary lc-btn" data-act="appActOpenFilePicker" data-act-args="[&quot;presetFileInput&quot;]" style="white-space:nowrap; padding:6px 14px; font-size:var(--font-size-sm);">Upload preset file</button>
          <input type="file" id="presetFileInput" aria-label="Choose a preset file to upload" accept="application/json,.json" style="display:none;" data-act="uploadPresetFile" data-act-args="[&quot;@self&quot;]">
        </div>
      </div>
      <p class="u-m-0_0_12px u-c-v_muted u-fs-v_font_size_sm">Save your current setup as a named preset to reuse or download as a file.</p>
      <div class="preset-create-group" style="display:flex; gap:8px; align-items:stretch; margin-bottom:10px; max-width:540px;">
        <input type="text" id="presetNameInput" placeholder="Preset name (e.g. Home Cinema)" class="u-flex-1 u-minw-0 u-p-8px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-fs-v_font_size_base">
        <button type="button" class="primary lc-btn" data-act="saveCurrentAsPreset" style="white-space:nowrap; padding:0 18px;">Save preset</button>
      </div>
      <div id="presetsList" class="u-mt-10px"></div>
    </div>

    <div class="panel u-mt-12px">
      <h2 class="panel-title">Backup &amp; Restore</h2>
      <p class="u-m-0_0_14px u-c-v_muted u-fs-v_font_size_sm">Export a complete backup snapshot of your catalogs, custom lists, watchlist, watch history, continue watching, channels, presets, and settings &mdash; or restore from a previous JSON backup.</p>
      
      <div class="backup-quick-grid">
        <div style="border:1px solid var(--border); border-radius:var(--radius-md); padding:16px 18px; background:var(--surface); box-shadow:var(--shadow-sm); display:flex; flex-direction:column; justify-content:space-between; gap:12px;">
          <div>
            <div class="u-fw-700 u-fs-v_font_size_base u-c-v_text">
              Download Backup
            </div>
            <p class="u-m-4px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Save a complete snapshot file (.json) with all your catalogs, lists, channels, history, and settings.</p>
          </div>
          <button type="button" class="secondary lc-btn" data-act="downloadConfigJson" style="align-self:flex-start; padding:8px 18px; font-weight:600;">Download Backup File</button>
        </div>

        <div style="border:1px solid var(--border); border-radius:var(--radius-md); padding:16px 18px; background:var(--surface); box-shadow:var(--shadow-sm); display:flex; flex-direction:column; justify-content:space-between; gap:12px;">
          <div>
            <div class="u-fw-700 u-fs-v_font_size_base u-c-v_text">
              Restore from File
            </div>
            <p class="u-m-4px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Restore your previous setup from an exported backup .json file.</p>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button type="button" class="secondary lc-btn" data-act="appActOpenFilePicker" data-act-args="[&quot;configFileInput&quot;]" style="padding:8px 18px; font-weight:600;">Upload &amp; Restore File</button>
            <input type="file" id="configFileInput" aria-label="Choose a backup file to restore" accept="application/json,.json" style="display:none;" data-act="uploadConfigFile" data-act-args="[&quot;@self&quot;]">
          </div>
        </div>
      </div>

      <details class="backup-advanced-disclosure">
        <summary class="backup-advanced-summary">
          <span>Advanced: Direct JSON Configuration Payload</span>
          <span class="backup-advanced-arrow">&#x25BE;</span>
        </summary>
        <div style="padding:0 14px 14px; display:flex; flex-direction:column; gap:10px;">
          <textarea id="configJsonBox" rows="5" style="width:100%; font-family:var(--font-mono, monospace); font-size:13px; border-radius:var(--radius-sm); border:1px solid var(--border); background:var(--bg); color:var(--text); padding:8px 10px; box-sizing:border-box;" placeholder="Paste config JSON here to restore..."></textarea>
          <div class="backup-actions-grid" style="display:flex; gap:8px; flex-wrap:wrap;">
            <button type="button" class="secondary lc-btn" data-act="exportConfigJson">Export current to box</button>
            <button type="button" class="secondary lc-btn" data-act="importConfigJson">Import JSON from box</button>
          </div>
        </div>
      </details>

      <!-- Importing from an install link is not offered: an install id is an
           unrevocable bearer credential that returns connected accounts'
           tokens (SECURITY_AUDIT.md S-02), and a backup file does the same job
           safely. The classic page had it until it was retired (Release 21). -->
    </div>

    <!-- Export Lists & History (Universal CSV / Trakt / Letterboxd / MDBList / Simkl) -->
    <div class="panel u-mt-12px">
      <h2 class="panel-title">Export Lists &amp; History</h2>
      <p class="u-m-0_0_14px u-c-v_muted u-fs-v_font_size_sm">Export your Watch History, Continue Watching, and Custom Lists in standard CSV or JSON format for easy import into Trakt, Letterboxd, MDBList, Simkl, or IMDb.</p>
      
      <div style="display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding:14px 18px; background:var(--surface); border:1px solid var(--border); box-shadow:var(--shadow-sm); border-radius:var(--radius-md);">
          <div>
            <div class="u-fw-700 u-fs-v_font_size_base u-c-v_text">Watch History</div>
            <div class="u-fs-v_font_size_sm u-c-v_muted">All watched movies, shows, and episodes with timestamps</div>
          </div>
          <div class="export-actions-grid">
            <button type="button" class="secondary lc-btn" data-act="exportDataToCsv" data-act-args="[&quot;watch-history&quot;,&quot;trakt&quot;]">CSV (Trakt / Simkl)</button>
            <button type="button" class="secondary lc-btn" data-act="exportDataToCsv" data-act-args="[&quot;watch-history&quot;,&quot;letterboxd&quot;]">CSV (Letterboxd)</button>
            <button type="button" class="secondary lc-btn" data-act="exportDataToCsv" data-act-args="[&quot;watch-history&quot;,&quot;standard&quot;]">Universal CSV</button>
          </div>
        </div>

        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding:14px 18px; background:var(--surface); border:1px solid var(--border); box-shadow:var(--shadow-sm); border-radius:var(--radius-md);">
          <div>
            <div class="u-fw-700 u-fs-v_font_size_base u-c-v_text">All Custom Lists &amp; Watchlist</div>
            <div class="u-fs-v_font_size_sm u-c-v_muted">Export all created lists, watchlist, and continue watching items</div>
          </div>
          <div class="export-actions-grid">
            <button type="button" class="secondary lc-btn" data-act="exportDataToCsv" data-act-args="[&quot;all-custom-lists&quot;,&quot;standard&quot;]">Export All (CSV)</button>
            <button type="button" class="secondary lc-btn" data-act="exportDataToJson" data-act-args="[&quot;full-library&quot;]">Full Library (JSON)</button>
          </div>
        </div>
      </div>
    </div>
  </div>
