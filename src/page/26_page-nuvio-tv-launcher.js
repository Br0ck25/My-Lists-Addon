// Standalone management page for Nuvio TV Launcher (/nuvio-tv-launcher)

function handleNuvioTvLauncherPage(request, env, ctx, url, path) {
  ctx.waitUntil(bumpStat(env, "pageviews"));
  const origin = url ? url.origin : "";
  const html = buildNuvioTvLauncherPageHtml(origin);
  return pageResponseWithBody(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function buildNuvioTvLauncherLayoutCss() {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: var(--space-4) var(--space-3);
    }
    .launcher-container {
      width: 100%;
      max-width: 840px;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding-bottom: var(--space-2);
    }
    .back-btn {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--font-size-sm);
      color: var(--muted);
      text-decoration: none;
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--surface);
    }
    .back-btn:hover {
      color: var(--text);
      border-color: var(--border-strong);
    }
    .launcher-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
    }
    .card-title {
      font-size: var(--font-size-lg);
      font-weight: 600;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin-bottom: var(--space-2);
    }
    .card-desc {
      font-size: var(--font-size-sm);
      color: var(--muted);
      margin-bottom: var(--space-3);
      line-height: 1.5;
    }
  `;
}

function buildNuvioTvLauncherComponentCss() {
  return `
    .switch-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-3);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      margin-bottom: var(--space-3);
    }
    .switch-info { display: flex; flex-direction: column; gap: 2px; }
    .switch-label { font-size: var(--font-size-base); font-weight: 600; color: var(--text); }
    .switch-sub { font-size: var(--font-size-xs); color: var(--muted); }
    .toggle-control {
      position: relative;
      display: inline-block;
      width: 48px;
      height: 26px;
      flex-shrink: 0;
    }
    .toggle-control input { opacity: 0; width: 0; height: 0; }
    .toggle-slider {
      position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
      background-color: var(--border-strong);
      transition: .2s; border-radius: 26px;
    }
    .toggle-slider:before {
      position: absolute; content: ""; height: 20px; width: 20px; left: 3px; bottom: 3px;
      background-color: white; transition: .2s; border-radius: 50%;
    }
    .toggle-control input:checked + .toggle-slider { background-color: var(--accent); }
    .toggle-control input:checked + .toggle-slider:before { transform: translateX(22px); }
    .banner-info {
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: var(--space-3);
      font-size: var(--font-size-sm);
      color: var(--muted);
      margin-bottom: var(--space-3);
      line-height: 1.4;
    }
    .items-list { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-3); }
    .item-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: var(--space-2) var(--space-3); background: var(--bg);
      border: 1px solid var(--border); border-radius: var(--radius-sm); gap: var(--space-2);
    }
    .item-left { display: flex; align-items: center; gap: var(--space-2); overflow: hidden; }
    .item-title { font-size: var(--font-size-sm); font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item-pill {
      font-size: var(--font-size-xs); padding: 2px 8px; border-radius: var(--radius-pill);
      background: var(--surface); border: 1px solid var(--border); color: var(--muted); flex-shrink: 0;
    }
    .copy-box {
      display: flex; align-items: center; gap: var(--space-2); background: var(--bg);
      border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); margin-bottom: var(--space-3);
    }
    .copy-input { flex: 1; background: transparent; border: none; color: var(--text); font-family: monospace; font-size: var(--font-size-xs); outline: none; }
    .action-bar { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-3); }
    .toast-msg {
      position: fixed; bottom: var(--space-4); right: var(--space-4);
      background: var(--surface); color: var(--text); border: 1px solid var(--border-strong);
      padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); font-size: var(--font-size-sm); z-index: 1000; display: none;
    }
  `;
}

function buildNuvioTvLauncherPageCss() {
  return `${buildNuvioTvLauncherLayoutCss()}\n${buildNuvioTvLauncherComponentCss()}`;
}

function buildNuvioTvLauncherConfigJs() {
  return `
    var currentUsername = "";
    var currentTvConfig = null;
    var currentMainLists = [];
    var currentTvLists = [];

    function showToast(text) {
      var t = document.getElementById("toastMsg");
      if (!t) return;
      t.textContent = text;
      t.style.display = "block";
      setTimeout(function() { t.style.display = "none"; }, 3000);
    }

    async function loadAccount() {
      try {
        var res = await fetch("/api/me", { credentials: "same-origin" });
        if (res.ok) {
          var data = await res.json();
          if (data && data.username) {
            currentUsername = data.username;
            var pill = document.getElementById("userPill");
            if (pill) pill.textContent = "@" + currentUsername;
            var input = document.getElementById("manifestUrlInput");
            if (input) input.value = window.location.origin + "/" + currentUsername + "/tv/manifest.json";
            loadTvConfig();
            return;
          }
        }
      } catch (e) {}
      var localName = localStorage.getItem("creatorName") || "";
      if (localName) {
        currentUsername = localName;
        var pill = document.getElementById("userPill");
        if (pill) pill.textContent = "@" + currentUsername;
        var input = document.getElementById("manifestUrlInput");
        if (input) input.value = window.location.origin + "/" + currentUsername + "/tv/manifest.json";
        loadTvConfig();
      } else {
        var pill = document.getElementById("userPill");
        if (pill) pill.textContent = "Guest Mode (Sign in on main dashboard to sync)";
      }
    }

    async function loadTvConfig() {
      if (!currentUsername) return;
      try {
        var creatorKey = localStorage.getItem("creatorKey") || "";
        var url = "/api/nuvio-tv/config?creatorName=" + encodeURIComponent(currentUsername);
        if (creatorKey) url += "&creatorKey=" + encodeURIComponent(creatorKey);
        var res = await fetch(url, { credentials: "same-origin" });
        if (res.ok) {
          var data = await res.json();
          currentTvConfig = data;
          currentMainLists = data.mainLists || [];
          currentTvLists = data.tvLists || [];
          var toggle = document.getElementById("mirrorToggle");
          if (toggle) toggle.checked = data.mirror !== false;
          renderCatalogs();
        }
      } catch (e) {
        console.error("Failed to load TV config", e);
      }
    }
  `;
}

function buildNuvioTvLauncherDomJs() {
  return `
    function renderCatalogs() {
      var toggle = document.getElementById("mirrorToggle");
      var isMirror = toggle ? toggle.checked : true;
      var banner = document.getElementById("mirrorBanner");
      var customControls = document.getElementById("customControls");
      var saveBar = document.getElementById("saveBar");
      var listEl = document.getElementById("catalogsList");

      if (isMirror) {
        if (banner) {
          banner.innerHTML = "&#9432; <strong>Mirroring Active:</strong> Your TV displays the same catalogs as your main account. Changes on the main dashboard reflect on your TV instantly.";
        }
        if (customControls) customControls.style.display = "none";
        if (saveBar) saveBar.style.display = "none";

        var lists = currentMainLists.length ? currentMainLists : [{ name: "Trending", type: "movie" }, { name: "Trending", type: "series" }, { name: "Popular", type: "movie" }, { name: "Popular", type: "series" }];
        var html = "";
        for (var i = 0; i < lists.length; i++) {
          var it = lists[i];
          html += '<div class="item-row">' +
            '<div class="item-left">' +
              '<span class="item-title">' + (it.name || "Untitled") + '</span>' +
              '<span class="item-pill">' + (it.type || "catalog") + '</span>' +
            '</div>' +
            '<span class="item-pill">Mirrored</span>' +
          '</div>';
        }
        if (listEl) listEl.innerHTML = html;
      } else {
        if (banner) {
          banner.innerHTML = "&#9881; <strong>Custom TV Setup:</strong> This TV maintains its own independent catalogs and shelf order.";
        }
        if (customControls) customControls.style.display = "block";
        if (saveBar) saveBar.style.display = "flex";

        var lists = currentTvLists.length ? currentTvLists : currentMainLists;
        if (!currentTvLists.length) currentTvLists = JSON.parse(JSON.stringify(lists));

        var html = "";
        for (var i = 0; i < currentTvLists.length; i++) {
          var it = currentTvLists[i];
          html += '<div class="item-row">' +
            '<div class="item-left">' +
              '<span class="item-title">' + (it.name || "Untitled") + '</span>' +
              '<span class="item-pill">' + (it.type || "catalog") + '</span>' +
            '</div>' +
            '<button type="button" class="btn btn-ghost" data-remove-idx="' + i + '" style="color:var(--danger);">&#10005;</button>' +
          '</div>';
        }
        if (!currentTvLists.length) {
          html = '<div style="color:var(--muted); font-size:var(--font-size-sm);">No TV catalogs selected. Click &ldquo;Copy from Main Setup&rdquo; to begin.</div>';
        }
        if (listEl) listEl.innerHTML = html;

        var removeBtns = listEl ? listEl.querySelectorAll("[data-remove-idx]") : [];
        for (var b = 0; b < removeBtns.length; b++) {
          removeBtns[b].addEventListener("click", function(e) {
            var idx = parseInt(this.getAttribute("data-remove-idx"), 10);
            if (!isNaN(idx)) {
              currentTvLists.splice(idx, 1);
              renderCatalogs();
            }
          });
        }
      }
    }

    async function saveTvConfig() {
      if (!currentUsername) {
        showToast("Please sign in to save TV setup.");
        return;
      }
      var toggle = document.getElementById("mirrorToggle");
      var isMirror = toggle ? toggle.checked : true;
      var creatorKey = localStorage.getItem("creatorKey") || "";
      var payload = {
        creatorName: currentUsername,
        creatorKey: creatorKey,
        mirror: isMirror,
        lists: isMirror ? currentMainLists : currentTvLists
      };

      try {
        var res = await fetch("/api/nuvio-tv/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          showToast("TV Launcher setup saved!");
        } else {
          showToast("Failed to save TV setup.");
        }
      } catch (e) {
        showToast("Network error while saving.");
      }
    }

    document.addEventListener("DOMContentLoaded", function() {
      var copyBtn = document.getElementById("copyManifestBtn");
      if (copyBtn) {
        copyBtn.addEventListener("click", function() {
          var input = document.getElementById("manifestUrlInput");
          if (input) {
            input.select();
            navigator.clipboard.writeText(input.value);
            showToast("Copied add-on manifest URL!");
          }
        });
      }

      var toggle = document.getElementById("mirrorToggle");
      if (toggle) {
        toggle.addEventListener("change", function() {
          renderCatalogs();
          saveTvConfig();
        });
      }

      var copyMainBtn = document.getElementById("copyFromMainBtn");
      if (copyMainBtn) {
        copyMainBtn.addEventListener("click", function() {
          currentTvLists = JSON.parse(JSON.stringify(currentMainLists));
          renderCatalogs();
          showToast("Copied catalogs from main setup!");
        });
      }

      var saveBtn = document.getElementById("saveTvBtn");
      if (saveBtn) saveBtn.addEventListener("click", saveTvConfig);

      loadAccount();
    });
  `;
}

function buildNuvioTvLauncherPageJs() {
  return `${buildNuvioTvLauncherConfigJs()}\n${buildNuvioTvLauncherDomJs()}`;
}

function buildNuvioTvLauncherPageHtml(origin) {
  const css = buildNuvioTvLauncherPageCss();
  const js = buildNuvioTvLauncherPageJs();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nuvio TV Launcher Hub &bull; My Lists Addon</title>
  <script nonce="${CSP_NONCE_PLACEHOLDER}">try { if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark-theme'); } catch (e) {}<\/script>
  <style nonce="${CSP_NONCE_PLACEHOLDER}">
${DESIGN_TOKENS_CSS}
${css}
  </style>
</head>
<body>
  <div class="launcher-container">
    <div class="top-bar">
      <a href="/" class="back-btn">&#8592; Main Dashboard</a>
      <span class="item-pill" id="userPill">Checking account&hellip;</span>
    </div>

    <!-- Status & Addon Manifest -->
    <div class="launcher-card">
      <div class="card-title">&#128250; Nuvio TV Launcher Add-on</div>
      <div class="card-desc">
        This dedicated version (<strong>app.my-list.tv</strong>) serves your living room TV screen with full Live TV channels, 16:9 landscape backdrops, and big-screen catalogs.
      </div>

      <div class="copy-box">
        <input type="text" id="manifestUrlInput" class="copy-input" readonly value="${origin}/nuvio-default/tv/manifest.json">
        <button type="button" class="btn btn-secondary" id="copyManifestBtn">Copy URL</button>
      </div>

      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <a href="/link" class="btn btn-primary" id="pairTvBtn">Pair TV Device</a>
        <a href="/tv" class="btn btn-secondary">Enter 6-Digit Code</a>
      </div>
    </div>

    <!-- Mirroring & Catalogs -->
    <div class="launcher-card">
      <div class="card-title">&#128260; TV Catalogs &amp; Shelves</div>
      <div class="card-desc">Choose whether your TV mirrors your regular My Lists catalogs or maintains an independent living room lineup.</div>

      <div class="switch-row">
        <div class="switch-info">
          <div class="switch-label">Mirror Main My Lists Setup</div>
          <div class="switch-sub">When enabled, any lists added on your main dashboard automatically sync to your TV.</div>
        </div>
        <label class="toggle-control">
          <input type="checkbox" id="mirrorToggle" checked>
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="banner-info" id="mirrorBanner">
        &#9432; <strong>Mirroring Active:</strong> Your TV displays the same catalogs as your main account. Changes on the main dashboard reflect on your TV instantly.
      </div>

      <div id="customControls" style="display:none; margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <span class="switch-label">Independent TV Catalogs</span>
          <button type="button" class="btn btn-secondary" id="copyFromMainBtn">Copy from Main Setup</button>
        </div>
      </div>

      <div class="items-list" id="catalogsList">
        <div style="color:var(--muted); font-size:var(--font-size-sm);">Loading catalogs&hellip;</div>
      </div>

      <div class="action-bar" id="saveBar" style="display:none;">
        <button type="button" class="btn btn-primary" id="saveTvBtn">Save TV Setup</button>
      </div>
    </div>
  </div>

  <div class="toast-msg" id="toastMsg"></div>

  <script nonce="${CSP_NONCE_PLACEHOLDER}">${js}<\/script>
</body>
</html>`;
}
