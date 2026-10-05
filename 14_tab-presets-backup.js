<div class="tab-panel" data-tab-panel="settings" id="content-settings" role="tabpanel" aria-labelledby="tab-desktop-settings" hidden>
  <!-- Settings Top Submenu Pills -->
  <div class="subnav-pills-bar" id="settingsSubnavBar">
    <button type="button" class="subnav-pill active" data-sub="account" data-act="switchSettingsSubmenu" data-act-args="[&quot;account&quot;,&quot;@self&quot;]"><span class="check-icon">&#x2713;</span> Account &amp; Sync</button>
    <button type="button" class="subnav-pill" data-sub="external" data-act="switchSettingsSubmenu" data-act-args="[&quot;external&quot;,&quot;@self&quot;]">External Accounts &amp; API Keys</button>
    <button type="button" class="subnav-pill" data-sub="backup" data-act="switchSettingsSubmenu" data-act-args="[&quot;backup&quot;,&quot;@self&quot;]">Presets &amp; Backup</button>
    <button type="button" class="subnav-pill" data-sub="feedback" data-act="switchSettingsSubmenu" data-act-args="[&quot;feedback&quot;,&quot;@self&quot;]">Feedback and Support</button>
  </div>

  <!-- Submenu 2: Presets & Backup -->
  <div class="settings-subpanel" id="settingsSubBackup" style="display:none;">
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:10px;">
        <h2 class="shelf-title">My Presets <span class="badge" id="presetsCountBadge"></span></h2>
      </div>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Save your current setup as a named preset to reuse or download as a file.</p>
      <div class="row">
        <input type="text" id="presetNameInput" placeholder="Preset name (e.g. Home Cinema)">
        <button type="button" class="secondary lc-btn" data-act="saveCurrentAsPreset">Save preset</button>
      </div>
      <div class="actions" style="margin-top:8px;">
        <button type="button" class="secondary lc-btn" data-act="appActOpenFilePicker" data-act-args="[&quot;presetFileInput&quot;]">Upload preset file</button>
        <input type="file" id="presetFileInput" aria-label="Choose a preset file to upload" accept="application/json,.json" style="display:none;" data-act="uploadPresetFile" data-act-args="[&quot;@self&quot;]">
      </div>
      <div id="presetsList" style="margin-top:10px;"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Backup &amp; Restore</h2>
      <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem;">Export a complete backup snapshot of your catalogs, custom lists, watchlist, watch history, continue watching, channels, presets, and settings &mdash; or restore from a previous JSON backup.</p>
      <textarea id="configJsonBox" rows="5" style="width:100%;font-family:monospace;font-size:14px;" placeholder="Paste config JSON here to restore..."></textarea>
      <div class="backup-actions-grid" style="margin-top:8px;">
        <button type="button" class="secondary lc-btn" data-act="exportConfigJson">Export current</button>
        <button type="button" class="secondary lc-btn" data-act="importConfigJson">Import JSON</button>
        <button type="button" class="secondary lc-btn" data-act="downloadConfigJson">Download file</button>
        <button type="button" class="secondary lc-btn" data-act="appActOpenFilePicker" data-act-args="[&quot;configFileInput&quot;]">Upload file</button>
        <input type="file" id="configFileInput" aria-label="Choose a backup file to restore" accept="application/json,.json" style="display:none;" data-act="uploadConfigFile" data-act-args="[&quot;@self&quot;]">
      </div>

      <!-- Importing from an install link is not offered: an install id is an
           unrevocable bearer credential that returns connected accounts'
           tokens (SECURITY_AUDIT.md S-02), and a backup file does the same job
           safely. The classic page had it until it was retired (Release 21). -->
    </div>

    <!-- Export Lists & History (Universal CSV / Trakt / Letterboxd / MDBList / Simkl) -->
    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Export Lists &amp; History</h2>
      <p style="margin:0 0 14px; color:var(--muted); font-size:0.85rem;">Export your Watch History, Continue Watching, and Custom Lists in standard CSV or JSON format for easy import into Trakt, Letterboxd, MDBList, Simkl, or IMDb.</p>
      
      <div style="display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding:12px 14px; background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:10px;">
          <div>
            <div style="font-weight:700; font-size:0.92rem; color:var(--text);">Watch History</div>
            <div style="font-size:0.8rem; color:var(--muted);">All watched movies, shows, and episodes with timestamps</div>
          </div>
          <div class="export-actions-grid">
            <button type="button" class="secondary lc-btn" data-act="exportDataToCsv" data-act-args="[&quot;watch-history&quot;,&quot;trakt&quot;]">CSV (Trakt / Simkl)</button>
            <button type="button" class="secondary lc-btn" data-act="exportDataToCsv" data-act-args="[&quot;watch-history&quot;,&quot;letterboxd&quot;]">CSV (Letterboxd)</button>
            <button type="button" class="secondary lc-btn" data-act="exportDataToCsv" data-act-args="[&quot;watch-history&quot;,&quot;standard&quot;]">Universal CSV</button>
          </div>
        </div>

        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding:12px 14px; background:rgba(255,255,255,0.03); border:1px solid var(--border); border-radius:10px;">
          <div>
            <div style="font-weight:700; font-size:0.92rem; color:var(--text);">All Custom Lists &amp; Watchlist</div>
            <div style="font-size:0.8rem; color:var(--muted);">Export all created lists, watchlist, and continue watching items</div>
          </div>
          <div class="export-actions-grid">
            <button type="button" class="secondary lc-btn" data-act="exportDataToCsv" data-act-args="[&quot;all-custom-lists&quot;,&quot;standard&quot;]">Export All (CSV)</button>
            <button type="button" class="secondary lc-btn" data-act="exportDataToJson" data-act-args="[&quot;full-library&quot;]">Full Library (JSON)</button>
          </div>
        </div>
      </div>
    </div>
  </div>
