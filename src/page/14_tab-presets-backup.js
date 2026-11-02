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
      <div class="shelf-header u-mb-10px u-jc-space_between u-ai-center u-fw2-wrap u-gap-8px" style="display:flex;">
        <h2 class="shelf-title u-m-0">My Presets <span class="badge" id="presetsCountBadge"></span></h2>
        <div>
          <button type="button" class="secondary lc-btn u-ws-nowrap u-p-6px_14px u-fs-v_font_size_sm" data-act="appActOpenFilePicker" data-act-args="[&quot;presetFileInput&quot;]">Upload preset file</button>
          <input type="file" id="presetFileInput" aria-label="Choose a preset file to upload" accept="application/json,.json" style="display:none;" data-act="uploadPresetFile" data-act-args="[&quot;@self&quot;]">
        </div>
      </div>
      <p class="u-m-0_0_12px u-c-v_muted u-fs-v_font_size_sm">Save your current setup as a named preset to reuse or download as a file.</p>
      <div class="preset-create-group u-gap-8px u-ai-stretch u-mb-10px u-maxw-540px" style="display:flex;">
        <input type="text" id="presetNameInput" placeholder="Preset name (e.g. Home Cinema)" class="u-flex-1 u-minw-0 u-p-8px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-fs-v_font_size_base">
        <button type="button" class="primary lc-btn u-ws-nowrap u-p-0_18px" data-act="saveCurrentAsPreset">Save preset</button>
      </div>
      <div id="presetsList" class="u-mt-10px"></div>
    </div>

    <div class="panel u-mt-12px">
      <h2 class="panel-title">Backup &amp; Restore</h2>
      <p class="u-m-0_0_14px u-c-v_muted u-fs-v_font_size_sm">Export a complete backup snapshot of your catalogs, custom lists, watchlist, watch history, continue watching, channels, presets, and settings &mdash; or restore from a previous JSON backup.</p>
      
      <div class="backup-quick-grid">
        <div class="u-bd-1px_solid_v_border u-br-v_radius_md u-p-16px_18px u-bg-v_surface u-bsh-v_shadow_sm u-fd-column u-jc-space_between u-gap-12px" style="display:flex;">
          <div>
            <div class="u-fw-700 u-fs-v_font_size_base u-c-v_text">
              Download Backup
            </div>
            <p class="u-m-4px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Save a complete snapshot file (.json) with all your catalogs, lists, channels, history, and settings.</p>
          </div>
          <button type="button" class="secondary lc-btn u-as-flex_start u-p-8px_18px u-fw-600" data-act="downloadConfigJson">Download Backup File</button>
        </div>

        <div class="u-bd-1px_solid_v_border u-br-v_radius_md u-p-16px_18px u-bg-v_surface u-bsh-v_shadow_sm u-fd-column u-jc-space_between u-gap-12px" style="display:flex;">
          <div>
            <div class="u-fw-700 u-fs-v_font_size_base u-c-v_text">
              Restore from File
            </div>
            <p class="u-m-4px_0_0 u-c-v_muted u-fs-v_font_size_sm u-lh-1_35">Restore your previous setup from an exported backup .json file.</p>
          </div>
          <div class="u-ai-center u-gap-8px" style="display:flex;">
            <button type="button" class="secondary lc-btn u-p-8px_18px u-fw-600" data-act="appActOpenFilePicker" data-act-args="[&quot;configFileInput&quot;]">Upload &amp; Restore File</button>
            <input type="file" id="configFileInput" aria-label="Choose a backup file to restore" accept="application/json,.json" style="display:none;" data-act="uploadConfigFile" data-act-args="[&quot;@self&quot;]">
          </div>
        </div>
      </div>

      <details class="backup-advanced-disclosure">
        <summary class="backup-advanced-summary">
          <span>Advanced: Direct JSON Configuration Payload</span>
          <span class="backup-advanced-arrow">&#x25BE;</span>
        </summary>
        <div class="u-p-0_14px_14px u-fd-column u-gap-10px" style="display:flex;">
          <textarea id="configJsonBox" rows="5" class="u-ff-v_font_mono_monospace u-fs-13px u-br-v_radius_sm u-bd-1px_solid_v_border u-bg-v_bg u-c-v_text u-p-8px_10px u-bs-border_box" style="width:100%;" placeholder="Paste config JSON here to restore..."></textarea>
          <div class="backup-actions-grid u-gap-8px u-fw2-wrap" style="display:flex;">
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
      
      <div class="u-fd-column u-gap-12px" style="display:flex;">
        <div class="u-ai-center u-jc-space_between u-fw2-wrap u-gap-10px u-p-14px_18px u-bg-v_surface u-bd-1px_solid_v_border u-bsh-v_shadow_sm u-br-v_radius_md" style="display:flex;">
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

        <div class="u-ai-center u-jc-space_between u-fw2-wrap u-gap-10px u-p-14px_18px u-bg-v_surface u-bd-1px_solid_v_border u-bsh-v_shadow_sm u-br-v_radius_md" style="display:flex;">
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
