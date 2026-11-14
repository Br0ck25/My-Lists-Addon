// Standalone management page handler for Nuvio TV Launcher (/nuvio-tv-launcher)
// Renders the full web app shell so the TV Launcher management view has
// 100% parity with the rest of the website (design system tokens, navigation,
// dark mode, modals, and responsive layout), with dedicated TV launcher controls.

function buildNuvioTvNavScript() {
  return 'function buildTvNavTabsHtml(style) {\n' +
    '  var isDesk = style === "desktop";\n' +
    '  var tabs = [\n' +
    '    { id: "tv-home", label: "Home", icon: "<path d=\\"M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\\"></path><polyline points=\\"9 22 9 12 15 12 15 22\\"></polyline>" },\n' +
    '    { id: "tv-lists", label: "Lists", icon: "<path d=\\"M8 6h13\\"></path><path d=\\"M8 12h13\\"></path><path d=\\"M8 18h13\\"></path><path d=\\"M3 6h.01\\"></path><path d=\\"M3 12h.01\\"></path><path d=\\"M3 18h.01\\"></path>" },\n' +
    '    { id: "tv-channels", label: "Channels", icon: "<rect x=\\"2\\" y=\\"7\\" width=\\"20\\" height=\\"15\\" rx=\\"2\\" ry=\\"2\\"></rect><polyline points=\\"17 2 12 7 7 2\\"></polyline>" },\n' +
    '    { id: "tv-collections", label: "Collections", icon: "<path d=\\"M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z\\"></path>" },\n' +
    '    { id: "tv-library", label: "Library", icon: "<path d=\\"M4 19.5A2.5 2.5 0 0 1 6.5 17H20\\"></path><path d=\\"M6.5 2H20v20H6.5A2.5 2.5 0 0 1 6.5 2z\\"></path>" },\n' +
    '    { id: "discover", label: "Discover", icon: "<rect x=\\"3\\" y=\\"3\\" width=\\"7\\" height=\\"7\\"></rect><rect x=\\"14\\" y=\\"3\\" width=\\"7\\" height=\\"7\\"></rect><rect x=\\"14\\" y=\\"14\\" width=\\"7\\" height=\\"7\\"></rect><rect x=\\"3\\" y=\\"14\\" width=\\"7\\" height=\\"7\\"></rect>" },\n' +
    '    { id: "search", label: "Search", icon: "<circle cx=\\"11\\" cy=\\"11\\" r=\\"8\\"></circle><line x1=\\"21\\" y1=\\"21\\" x2=\\"16.65\\" y2=\\"16.65\\"></line>" }\n' +
    '  ];\n' +
    '  return tabs.map(function(t) {\n' +
    '    var active = t.id === tvLauncherActiveTab;\n' +
    '    var cls = (isDesk ? "tab-btn" : "bottom-nav-item") + (active ? " active" : "");\n' +
    '    var attrs = "class=\\"" + cls + "\\" data-tab=\\"" + t.id + "\\" data-act=\\"switchTvLauncherTab\\" data-act-args=\\"[&quot;" + t.id + "&quot;]\\"" +\n' +
    '      (active ? " aria-current=\\"page\\"" : "");\n' +
    '    if (isDesk) return "<a " + attrs + ">" + escapeHtml(t.label) + "</a>";\n' +
    '    return "<a " + attrs + "><svg viewBox=\\"0 0 24 24\\" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"2\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\" aria-hidden=\\"true\\">" + t.icon + "</svg>" + escapeHtml(t.label) + "</a>";\n' +
    '  }).join("");\n' +
    '}\n' +
    'function renderTvNavTabs() {\n' +
    '  var d = document.getElementById("appShellDesktopNav");\n' +
    '  if (d) d.innerHTML = "<nav aria-label=\\"Main navigation\\" class=\\"u-gap-8px u-ovx-auto\\" style=\\"display:flex; width:100%;\\">" + buildTvNavTabsHtml("desktop") + "</nav>";\n' +
    '  var m = document.getElementById("appShellMobileNav");\n' +
    '  if (m) m.innerHTML = buildTvNavTabsHtml("mobile");\n' +
    '}\n' +
    'function switchTvLauncherTab(tabId) {\n' +
    '  if (!tabId) return;\n' +
    '  if (tabId !== "list-details" && tabId !== "item-details") window._tvPreviousTab = tabId;\n' +
    '  tvLauncherActiveTab = tabId;\n' +
    '  var tabBtns = document.querySelectorAll(".tab-btn, .bottom-nav-item");\n' +
    '  for (var i = 0; i < tabBtns.length; i++) {\n' +
    '    var b = tabBtns[i];\n' +
    '    var on = b.getAttribute("data-tab") === tabId;\n' +
    '    b.classList.toggle("active", on);\n' +
    '    if (on) b.setAttribute("aria-current", "page");\n' +
    '    else b.removeAttribute("aria-current");\n' +
    '  }\n' +
    '  var titles = {\n' +
    '    "tv-home": { title: "Nuvio TV Launcher", sub: "Installed Shelves & Living Room Lineup" },\n' +
    '    "tv-lists": { title: "Lists", sub: "Custom, Connected & Liked Lists" },\n' +
    '    "tv-channels": { title: "Channels", sub: "24/7 Continuous TV Streaming" },\n' +
    '    "tv-collections": { title: "Collections", sub: "Nuvio Collections & Folders" },\n' +
    '    "tv-library": { title: "Library", sub: "Continue Watching, Watch History & Saved Library" },\n' +
    '    "discover": { title: "Discover", sub: "Explore Popular & Streaming" },\n' +
    '    "search": { title: "Search", sub: "Find Movies, Shows & Lists" }\n' +
    '  };\n' +
    '  var t = titles[tabId] || { title: "Nuvio TV Launcher", sub: "" };\n' +
    '  var tEl = document.getElementById("pageMainTitle");\n' +
    '  var sEl = document.getElementById("pageSubtitle");\n' +
    '  if (tEl) tEl.textContent = t.title;\n' +
    '  if (sEl) sEl.textContent = t.sub;\n' +
    '  var panelMap = {\n' +
    '    "tv-home": "content-tv-home",\n' +
    '    "tv-lists": "content-lists",\n' +
    '    "tv-channels": "content-channels",\n' +
    '    "tv-collections": "content-tv-collections",\n' +
    '    "tv-library": "content-tv-library",\n' +
    '    "discover": "content-discover",\n' +
    '    "search": "content-search"\n' +
    '  };\n' +
    '  var targetPanelId = panelMap[tabId];\n' +
    '  var panels = document.querySelectorAll(".tab-panel");\n' +
    '  for (var j = 0; j < panels.length; j++) {\n' +
    '    var p = panels[j];\n' +
    '    p.hidden = targetPanelId ? (p.id !== targetPanelId) : (p.getAttribute("data-tab-panel") !== tabId);\n' +
    '  }\n' +
    '  if (tabId === "tv-home") renderTvHomeShelves();\n' +
    '  else if (tabId === "tv-lists") renderTvListsTab();\n' +
    '  else if (tabId === "tv-channels") renderTvChannelsTab();\n' +
    '  else if (tabId === "tv-collections") renderTvCollectionsTab();\n' +
    '  else if (tabId === "tv-library") renderTvLibraryTab();\n' +
    '  else if (tabId === "discover") {\n' +
    '    if (typeof filterDiscoverShelves === "function") filterDiscoverShelves(localStorage.getItem("myListAddon:discoverSubmenu") || "movie");\n' +
    '  }\n' +
    '}\n';
}

function buildNuvioTvDomTemplates(origin) {
  return 'function buildTvBannerHtml() {\n' +
    '  var isMirror = tvLauncherIsMirror;\n' +
    '  var username = (typeof activeCreator !== "undefined" && activeCreator && (activeCreator.displayName || activeCreator.creatorName))\n' +
    '    || localStorage.getItem("myListAddon:creatorDisplayName")\n' +
    '    || localStorage.getItem("myListAddon:creatorName")\n' +
    '    || "Account";\n' +
    '  var manifestUrl = ORIGIN + "/" + (encodeURIComponent(username !== "Account" ? username : "nuvio-default")) + "/tv/manifest.json";\n' +
    '  return "<div class=\\"panel u-mb-16px\\" id=\\"nuvioTvBanner\\">" +\n' +
    '    "<div class=\\"u-ai-center u-jc-space_between u-gap-12px u-fw2-wrap\\" style=\\"display:flex;\\">" +\n' +
    '      "<div class=\\"u-ai-center u-gap-10px\\" style=\\"display:flex;\\">" +\n' +
    '        "<div>" +\n' +
    '          "<div class=\\"u-fw-700 u-fs-v_font_size_lg u-c-v_text\\">Nuvio TV Launcher Setup</div>" +\n' +
    '          "<div class=\\"u-fs-v_font_size_xs u-c-v_muted\\" id=\\"nuvioTvStatusText\\">" +\n' +
    '            (username !== "Account" ? "@" + escapeHtml(username) + " &bull; " : "") +\n' +
    '            (isMirror ? "Mirroring Main Setup" : "Custom Independent TV Shelves") +\n' +
    '            " &bull; app.my-list.tv" +\n' +
    '          "</div>" +\n' +
    '        "</div>" +\n' +
    '      "</div>" +\n' +
    '      "<div class=\\"u-ai-center u-gap-8px u-fw2-wrap\\" style=\\"display:flex;\\">" +\n' +
    '        "<a href=\\"/link\\" target=\\"_blank\\" rel=\\"noopener\\" class=\\"lc-btn secondary u-fs-v_font_size_xs\\">Pair TV Device</a>" +\n' +
    '        "<button type=\\"button\\" class=\\"lc-btn secondary u-fs-v_font_size_xs\\" data-act=\\"copyTvManifestUrl\\" data-act-args=\\"[&quot;" + escapeAttr(manifestUrl) + "&quot;]\\">Copy TV Manifest</button>" +\n' +
    '      "</div>" +\n' +
    '    "</div>" +\n' +
    '    "<div class=\\"u-bdt-1px_solid_v_border u-mt-12px u-pt-12px u-ai-center u-jc-space_between u-gap-12px\\" style=\\"display:flex;\\">" +\n' +
    '      "<div class=\\"u-flex-1 u-minw-0\\">" +\n' +
    '        "<span class=\\"u-fw-600 u-fs-v_font_size_sm u-c-v_text\\" style=\\"display:block;\\">Mirror Main Add-on Setup</span>" +\n' +
    '        "<span class=\\"u-fs-v_font_size_xs u-c-v_muted u-mt-2px\\" style=\\"display:block;\\">When ON, TV automatically mirrors all catalogs from your main account. Turn OFF to customize independent shelves for TV.</span>" +\n' +
    '      "</div>" +\n' +
    '      "<label class=\\"ui-toggle\\" aria-label=\\"Mirror Main Add-on Setup\\">" +\n' +
    '        "<input type=\\"checkbox\\" id=\\"tvMirrorSwitch\\" " + (isMirror ? "checked" : "") + " data-act=\\"onTvMirrorToggle\\" data-act-args=\\"[&quot;@checked&quot;]\\">" +\n' +
    '        "<span class=\\"ui-toggle-slider\\"></span>" +\n' +
    '      "</label>" +\n' +
    '    "</div>" +\n' +
    '  "</div>";\n' +
    '}\n' +
    'function buildTvHomePanelHtml() {\n' +
    '  return "<div class=\\"tab-panel\\" data-tab-panel=\\"tv-home\\" id=\\"content-tv-home\\" role=\\"tabpanel\\">" +\n' +
    '    buildTvBannerHtml() +\n' +
    '    "<div class=\\"panel\\">" +\n' +
    '      "<div class=\\"shelf-header u-mb-12px u-ai-center u-jc-space_between u-gap-12px\\" style=\\"display:flex; flex-wrap:wrap;\\">" +\n' +
    '        "<div>" +\n' +
    '          "<h2 class=\\"panel-title u-mb-0\\">TV Installed Shelves</h2>" +\n' +
    '          "<p class=\\"u-m-0 u-c-v_muted u-fs-v_font_size_sm\\">Active catalog rows displayed on your Nuvio TV Launcher home screen.</p>" +\n' +
    '        "</div>" +\n' +
    '        "<div class=\\"actions u-fd-row u-fw2-wrap u-ai-center u-gap-6px u-fsh-0\\" style=\\"display:flex;\\">" +\n' +
    '          "<button type=\\"button\\" class=\\"primary lc-btn\\" data-act=\\"openAddShelfModal\\">+ New Catalog</button>" +\n' +
    '          "<button type=\\"button\\" class=\\"secondary lc-btn\\" id=\\"tvCopyMainBtn\\" data-act=\\"copyTvMainSetup\\" style=\\"display:" + (tvLauncherIsMirror ? "none" : "inline-flex") + ";\\">Copy from Main Setup</button>" +\n' +
    '          "<button type=\\"button\\" class=\\"secondary lc-btn refresh-btn\\" data-act=\\"renderTvHomeShelves\\" title=\\"Refresh TV shelves\\">Refresh</button>" +\n' +
    '        "</div>" +\n' +
    '      "</div>" +\n' +
    '      "<div id=\\"tvHomeShelvesNotice\\"></div>" +\n' +
    '      "<div id=\\"tvHomeShelvesList\\"></div>" +\n' +
    '    "</div>" +\n' +
    '  "</div>";\n' +
    '}\n' +
    'function buildTvLibraryPanelHtml() {\n' +
    '  return "<div class=\\"tab-panel\\" data-tab-panel=\\"tv-library\\" id=\\"content-tv-library\\" role=\\"tabpanel\\" hidden>" +\n' +
    '    "<div class=\\"panel u-mb-14px\\">" +\n' +
    '      "<div class=\\"shelf-header u-mb-10px u-ai-center u-jc-space_between u-gap-12px\\" style=\\"display:flex; flex-wrap:wrap;\\">" +\n' +
    '        "<div>" +\n' +
    '          "<h2 class=\\"panel-title u-mb-0\\">Your Nuvio Library</h2>" +\n' +
    '          "<p class=\\"u-m-0 u-c-v_muted u-fs-v_font_size_sm\\">Continue Watching, Watch History, and Library items from your connected Nuvio account.</p>" +\n' +
    '        "</div>" +\n' +
    '        "<button type=\\"button\\" class=\\"secondary lc-btn refresh-btn\\" data-act=\\"renderTvLibraryTab\\" title=\\"Refresh library\\">Refresh</button>" +\n' +
    '      "</div>" +\n' +
    '    "</div>" +\n' +
    '    "<div id=\\"tvLibraryContent\\"></div>" +\n' +
    '  "</div>";\n' +
    '}\n' +
    'function buildTvCollectionsPanelHtml() {\n' +
    '  return "<div class=\\"tab-panel\\" data-tab-panel=\\"tv-collections\\" id=\\"content-tv-collections\\" role=\\"tabpanel\\" hidden>" +\n' +
    '    "<div id=\\"tvCollectionsResult\\"></div>" +\n' +
    '  "</div>";\n' +
    '}\n';
}

function buildNuvioTvConfigScript(origin) {
  return 'var ORIGIN = ' + JSON.stringify(origin || '') + ' || (typeof location !== "undefined" ? location.origin : "");\n' +
    'var tvLauncherConfig = null, tvLauncherMainLists = [], tvLauncherTvLists = [], tvLauncherIsMirror = true, tvLauncherActiveTab = "tv-home";\n' +
    'function isTvLauncherPage() { return typeof window !== "undefined" && window.location && window.location.pathname === "/nuvio-tv-launcher"; }\n' +
    'function isListAddedToTvConfig(url, type, slug) {\n' +
    '  if (!Array.isArray(tvLauncherTvLists)) return false;\n' +
    '  var cleanUrl = String(url || "").trim(), targetSlug = String(slug || "").trim();\n' +
    '  if (!targetSlug && cleanUrl) {\n' +
    '    if (cleanUrl.startsWith("autotrack:")) targetSlug = cleanUrl.split(":")[1] || "";\n' +
    '    else if (cleanUrl.startsWith("custom:") && !cleanUrl.startsWith("custom:curated:")) targetSlug = cleanUrl.slice("custom:".length);\n' +
    '    else if (cleanUrl.startsWith("customlist:v1:")) {\n' +
    '      var p = (typeof parseCustomListPayloadClient === "function") ? parseCustomListPayloadClient(cleanUrl) : null;\n' +
    '      if (p) targetSlug = p.localSlug || p.listSlug || p.creatorSlug || p.slug || "";\n' +
    '    }\n' +
    '  }\n' +
    '  return tvLauncherTvLists.some(function(item) {\n' +
    '    if (!item || !item.url) return false;\n' +
    '    var u = String(item.url).trim();\n' +
    '    if (cleanUrl && (u === cleanUrl || (cleanUrl.startsWith("autotrack:") && u.startsWith("autotrack:") && u.split(":")[1] === cleanUrl.split(":")[1]))) return true;\n' +
    '    if (targetSlug) {\n' +
    '      if (u === "custom:" + targetSlug || u === "autotrack:" + targetSlug) return true;\n' +
    '      if (u.startsWith("autotrack:" + targetSlug + ":") || u.startsWith("autotrack:" + targetSlug)) return true;\n' +
    '      if (u.startsWith("/lists/") && u.endsWith("/" + targetSlug)) return true;\n' +
    '      var payload = (typeof parseCustomListPayloadClient === "function") ? parseCustomListPayloadClient(u) : null;\n' +
    '      if (payload && (payload.localSlug === targetSlug || payload.listSlug === targetSlug || payload.creatorSlug === targetSlug || payload.slug === targetSlug)) return true;\n' +
    '      if (item.name && item.name.toLowerCase() === targetSlug.toLowerCase().replace(/-/g, " ")) return true;\n' +
    '    }\n' +
    '    return false;\n' +
    '  });\n' +
    '}\n' +
    'function removeTvCatalogRow(url, type, slug) {\n' +
    '  if (!Array.isArray(tvLauncherTvLists)) return;\n' +
    '  var cleanUrl = String(url || "").trim(), targetSlug = String(slug || "").trim();\n' +
    '  if (!targetSlug && cleanUrl) {\n' +
    '    if (cleanUrl.startsWith("autotrack:")) targetSlug = cleanUrl.split(":")[1] || "";\n' +
    '    else if (cleanUrl.startsWith("custom:") && !cleanUrl.startsWith("custom:curated:")) targetSlug = cleanUrl.slice("custom:".length);\n' +
    '    else if (cleanUrl.startsWith("customlist:v1:")) {\n' +
    '      var p = (typeof parseCustomListPayloadClient === "function") ? parseCustomListPayloadClient(cleanUrl) : null;\n' +
    '      if (p) targetSlug = p.localSlug || p.listSlug || p.creatorSlug || p.slug || "";\n' +
    '    }\n' +
    '  }\n' +
    '  var remName = "";\n' +
    '  tvLauncherTvLists = tvLauncherTvLists.filter(function(it) {\n' +
    '    if (!it || !it.url) return false;\n' +
    '    var u = String(it.url).trim();\n' +
    '    var match = false;\n' +
    '    if (cleanUrl && (u === cleanUrl || (cleanUrl.startsWith("autotrack:") && u.startsWith("autotrack:") && u.split(":")[1] === cleanUrl.split(":")[1]))) match = true;\n' +
    '    if (!match && targetSlug) {\n' +
    '      if (u === "custom:" + targetSlug || u === "autotrack:" + targetSlug) match = true;\n' +
    '      else if (u.startsWith("autotrack:" + targetSlug + ":") || u.startsWith("autotrack:" + targetSlug)) match = true;\n' +
    '      else if (u.startsWith("/lists/") && u.endsWith("/" + targetSlug)) match = true;\n' +
    '      else {\n' +
    '        var payload = (typeof parseCustomListPayloadClient === "function") ? parseCustomListPayloadClient(u) : null;\n' +
    '        if (payload && (payload.localSlug === targetSlug || payload.listSlug === targetSlug || payload.creatorSlug === targetSlug || payload.slug === targetSlug)) match = true;\n' +
    '        else if (it.name && it.name.toLowerCase() === targetSlug.toLowerCase().replace(/-/g, " ")) match = true;\n' +
    '      }\n' +
    '    }\n' +
    '    if (match) { remName = it.name || "Catalog"; return false; }\n' +
    '    return true;\n' +
    '  });\n' +
    '  saveTvLauncherConfig(false, tvLauncherTvLists); renderTvHomeShelves();\n' +
    '  if (typeof updateAllListAddButtons === "function") updateAllListAddButtons();\n' +
    '  if (typeof updateTvChannelAndStorylineButtons === "function") updateTvChannelAndStorylineButtons();\n' +
    '  if (remName) showToast("Removed \\"" + remName + "\\" from TV Launcher shelves.", "success");\n' +
    '}\n' +
    'async function loadTvLauncherConfig() {\n' +
    '  try {\n' +
    '    var creatorName = (typeof activeCreator !== "undefined" && activeCreator && activeCreator.creatorName) || localStorage.getItem("myListAddon:creatorName") || "";\n' +
    '    var url = ORIGIN + "/api/nuvio-tv/config" + (creatorName ? "?creatorName=" + encodeURIComponent(creatorName) : "");\n' +
    '    var res = (typeof creatorApiFetch === "function") ? await creatorApiFetch(url, { credentials: "same-origin" }) : await fetch(url, { credentials: "same-origin" });\n' +
    '    if (res && res.ok) {\n' +
    '      var data = await res.json();\n' +
    '      if (data && data.ok) {\n' +
    '        tvLauncherConfig = data;\n' +
    '        tvLauncherIsMirror = data.mirror !== false;\n' +
    '        tvLauncherMainLists = Array.isArray(data.mainLists) ? data.mainLists : [];\n' +
    '        tvLauncherTvLists = Array.isArray(data.tvLists) ? data.tvLists : [];\n' +
    '        var sw = document.getElementById("tvMirrorSwitch");\n' +
    '        if (sw) sw.checked = tvLauncherIsMirror;\n' +
    '        var copyBtn = document.getElementById("tvCopyMainBtn");\n' +
    '        if (copyBtn) copyBtn.style.display = tvLauncherIsMirror ? "none" : "inline-flex";\n' +
    '        renderTvHomeShelves();\n' +
    '        if (typeof updateAllListAddButtons === "function") updateAllListAddButtons();\n' +
    '        if (typeof updateTvChannelAndStorylineButtons === "function") updateTvChannelAndStorylineButtons();\n' +
    '      }\n' +
    '    }\n' +
    '  } catch (err) { console.error("loadTvLauncherConfig error:", err); }\n' +
    '}\n' +
    'async function saveTvLauncherConfig(mirrorVal, listsVal) {\n' +
    '  try {\n' +
    '    var creatorName = (typeof activeCreator !== "undefined" && activeCreator && activeCreator.creatorName) || localStorage.getItem("myListAddon:creatorName") || "";\n' +
    '    var creatorKey = localStorage.getItem("myListAddon:creatorKey") || "";\n' +
    '    var payload = { creatorName: creatorName, creatorKey: creatorKey, mirror: mirrorVal !== undefined ? mirrorVal : tvLauncherIsMirror, lists: listsVal !== undefined ? listsVal : (tvLauncherIsMirror ? tvLauncherMainLists : tvLauncherTvLists) };\n' +
    '    var res = (typeof creatorApiFetch === "function")\n' +
    '      ? await creatorApiFetch(ORIGIN + "/api/nuvio-tv/config", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(payload) })\n' +
    '      : await fetch(ORIGIN + "/api/nuvio-tv/config", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(payload) });\n' +
    '    if (res && res.ok) { showToast("Saved TV Launcher setup.", "success"); return true; }\n' +
    '    showToast("Could not save TV setup.", "error"); return false;\n' +
    '  } catch (err) { console.error("saveTvLauncherConfig error:", err); showToast("Network error while saving TV setup.", "error"); return false; }\n' +
    '}\n' +
    'function turnOffTvMirrorAndCustomize() {\n' +
    '  tvLauncherIsMirror = false;\n' +
    '  if (!tvLauncherTvLists.length) { var src = (tvLauncherMainLists && tvLauncherMainLists.length) ? tvLauncherMainLists : ((typeof collectEntries === "function") ? collectEntries() : ((typeof entries !== "undefined") ? entries : [])); tvLauncherTvLists = JSON.parse(JSON.stringify(src)); }\n' +
    '  var sw = document.getElementById("tvMirrorSwitch"); if (sw) sw.checked = false;\n' +
    '  saveTvLauncherConfig(false, tvLauncherTvLists); renderTvHomeShelves();\n' +
    '  if (typeof updateAllListAddButtons === "function") updateAllListAddButtons();\n' +
    '  if (typeof updateTvChannelAndStorylineButtons === "function") updateTvChannelAndStorylineButtons();\n' +
    '}\n' +
    'function copyTvMainSetup() {\n' +
    '  var src = (tvLauncherMainLists && tvLauncherMainLists.length) ? tvLauncherMainLists : ((typeof collectEntries === "function") ? collectEntries() : ((typeof entries !== "undefined") ? entries : []));\n' +
    '  tvLauncherTvLists = JSON.parse(JSON.stringify(src)); saveTvLauncherConfig(false, tvLauncherTvLists); renderTvHomeShelves(); showToast("Copied catalogs from main setup.", "success");\n' +
    '  if (typeof updateAllListAddButtons === "function") updateAllListAddButtons();\n' +
    '  if (typeof updateTvChannelAndStorylineButtons === "function") updateTvChannelAndStorylineButtons();\n' +
    '}\n' +
    'function onTvMirrorToggle(checked) {\n' +
    '  tvLauncherIsMirror = !!checked;\n' +
    '  if (!tvLauncherIsMirror && !tvLauncherTvLists.length) { var src = (tvLauncherMainLists && tvLauncherMainLists.length) ? tvLauncherMainLists : ((typeof collectEntries === "function") ? collectEntries() : ((typeof entries !== "undefined") ? entries : [])); tvLauncherTvLists = JSON.parse(JSON.stringify(src)); }\n' +
    '  saveTvLauncherConfig(tvLauncherIsMirror, tvLauncherIsMirror ? tvLauncherMainLists : tvLauncherTvLists); renderTvHomeShelves();\n' +
    '  if (typeof updateAllListAddButtons === "function") updateAllListAddButtons();\n' +
    '  if (typeof updateTvChannelAndStorylineButtons === "function") updateTvChannelAndStorylineButtons();\n' +
    '  if (tvLauncherActiveTab === "tv-channels" && typeof renderTvChannelsTab === "function") renderTvChannelsTab();\n' +
    '  if (tvLauncherActiveTab === "tv-lists" && typeof renderTvListsTab === "function") renderTvListsTab();\n' +
    '}\n' +
    'function copyTvManifestUrl(url) {\n' +
    '  if (!url) return;\n' +
    '  try { navigator.clipboard.writeText(url); showToast("Copied TV Manifest URL to clipboard.", "success"); }\n' +
    '  catch(e) { showToast("Manifest URL: " + url, "info"); }\n' +
    '}\n';
}

function buildNuvioTvNavInterceptorsScript() {
  return 'function initTvNavInterceptors() {\n' +
    '  var origPushState = history.pushState;\n' +
    '  var origReplaceState = history.replaceState;\n' +
    '  history.pushState = function(state, title, url) {\n' +
    '    if (isTvLauncherPage() || (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1")) {\n' +
    '      if (typeof url === "string") {\n' +
    '        if (url.startsWith("/#")) url = "/nuvio-tv-launcher" + url.slice(1);\n' +
    '        else if (url.startsWith("#")) url = "/nuvio-tv-launcher" + url;\n' +
    '        else if (url.startsWith("/") && !url.startsWith("/nuvio-tv-launcher")) url = "/nuvio-tv-launcher" + (url.indexOf("#") !== -1 ? url.slice(url.indexOf("#")) : "");\n' +
    '      }\n' +
    '    }\n' +
    '    return origPushState.apply(this, [state, title, url]);\n' +
    '  };\n' +
    '  history.replaceState = function(state, title, url) {\n' +
    '    if (isTvLauncherPage() || (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1")) {\n' +
    '      if (typeof url === "string") {\n' +
    '        if (url.startsWith("/#")) url = "/nuvio-tv-launcher" + url.slice(1);\n' +
    '        else if (url.startsWith("#")) url = "/nuvio-tv-launcher" + url;\n' +
    '        else if (url.startsWith("/") && !url.startsWith("/nuvio-tv-launcher")) url = "/nuvio-tv-launcher" + (url.indexOf("#") !== -1 ? url.slice(url.indexOf("#")) : "");\n' +
    '      }\n' +
    '    }\n' +
    '    return origReplaceState.apply(this, [state, title, url]);\n' +
    '  };\n' +
    '  var origAppShellHandleNav = window.appShellHandleNav;\n' +
    '  window.appShellHandleNav = function(kind, a, b, opts) {\n' +
    '    if (isTvLauncherPage() || (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1")) return false;\n' +
    '    return origAppShellHandleNav ? origAppShellHandleNav.apply(this, arguments) : false;\n' +
    '  };\n' +
    '  var origAppShellGo = window.appShellGo;\n' +
    '  window.appShellGo = function(path, options) {\n' +
    '    if (isTvLauncherPage() || (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1")) {\n' +
    '      var p = String(path || "");\n' +
    '      if (p.startsWith("/catalogs") || p === "/" || p.startsWith("/nuvio-tv-launcher")) switchTvLauncherTab("tv-home");\n' +
    '      else if (p.startsWith("/lists")) switchTvLauncherTab("tv-lists");\n' +
    '      else if (p.startsWith("/channels")) switchTvLauncherTab("tv-channels");\n' +
    '      else if (p.startsWith("/collections")) switchTvLauncherTab("tv-collections");\n' +
    '      else if (p.startsWith("/library")) switchTvLauncherTab("tv-library");\n' +
    '      else if (p.startsWith("/discover")) switchTvLauncherTab("discover");\n' +
    '      else if (p.startsWith("/search")) switchTvLauncherTab("search");\n' +
    '      return true;\n' +
    '    }\n' +
    '    return origAppShellGo ? origAppShellGo.apply(this, arguments) : false;\n' +
    '  };\n' +
    '  var origSwitchTab = window.switchTab;\n' +
    '  window.switchTab = function(tabId, opts) {\n' +
    '    if (isTvLauncherPage() || (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1")) {\n' +
    '      if (tabId === "catalogs") return switchTvLauncherTab("tv-home");\n' +
    '      if (tabId === "lists") return switchTvLauncherTab("tv-lists");\n' +
    '      if (tabId === "channels") return switchTvLauncherTab("tv-channels");\n' +
    '      if (tabId === "discover") return switchTvLauncherTab("discover");\n' +
    '      if (tabId === "search") return switchTvLauncherTab("search");\n' +
    '      if (tabId === "list-details" || tabId === "item-details") {\n' +
    '        if (tvLauncherActiveTab !== "list-details" && tvLauncherActiveTab !== "item-details") window._tvPreviousTab = tvLauncherActiveTab;\n' +
    '        return origSwitchTab ? origSwitchTab.apply(this, arguments) : undefined;\n' +
    '      }\n' +
    '    }\n' +
    '    return origSwitchTab ? origSwitchTab.apply(this, arguments) : undefined;\n' +
    '  };\n' +
    '  var origNavigateBackFromDetail = window.navigateBackFromDetail;\n' +
    '  window.navigateBackFromDetail = function() {\n' +
    '    if (isTvLauncherPage() || (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1")) {\n' +
    '      var cur = window._currentTab || (document.querySelector(".tab-panel:not([hidden])") ? document.querySelector(".tab-panel:not([hidden])").getAttribute("data-tab-panel") : "");\n' +
    '      if (cur === "item-details" && window._previousTab === "list-details") {\n' +
    '        if (typeof switchTab === "function") switchTab("list-details");\n' +
    '        var scrollPos = typeof window._listScrollY === "number" ? window._listScrollY : 0;\n' +
    '        if (typeof restoreListScroll === "function") restoreListScroll(scrollPos);\n' +
    '        return;\n' +
    '      }\n' +
    '      var prev = window._tvPreviousTab || "tv-home";\n' +
    '      switchTvLauncherTab(prev);\n' +
    '      return;\n' +
    '    }\n' +
    '    if (origNavigateBackFromDetail) return origNavigateBackFromDetail.apply(this, arguments);\n' +
    '  };\n' +
    '  window.addEventListener("popstate", function(e) {\n' +
    '    if (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1") {\n' +
    '      if (location.pathname !== "/nuvio-tv-launcher") history.replaceState(null, "", "/nuvio-tv-launcher");\n' +
    '      var cur = window._currentTab || (document.querySelector(".tab-panel:not([hidden])") ? document.querySelector(".tab-panel:not([hidden])").getAttribute("data-tab-panel") : "");\n' +
    '      if (cur === "item-details" && window._previousTab === "list-details") {\n' +
    '        if (typeof switchTab === "function") switchTab("list-details");\n' +
    '      } else if (cur === "item-details" || cur === "list-details") {\n' +
    '        switchTvLauncherTab(window._tvPreviousTab || "tv-home");\n' +
    '      }\n' +
    '    }\n' +
    '  });\n' +
    '  document.addEventListener("click", function(e) {\n' +
    '    if (document.documentElement.getAttribute("data-tv-launcher") !== "1") return;\n' +
    '    var a = e.target && e.target.closest ? e.target.closest("a") : null;\n' +
    '    if (!a) return;\n' +
    '    var href = a.getAttribute("href") || "";\n' +
    '    if (!href) return;\n' +
    '    var target = a.getAttribute("target");\n' +
    '    if (target === "_blank") return;\n' +
    '    if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:") || href.startsWith("javascript:")) return;\n' +
    '    e.preventDefault(); e.stopPropagation();\n' +
    '    if (href.startsWith("/catalogs") || href === "/" || href.startsWith("/nuvio-tv-launcher")) switchTvLauncherTab("tv-home");\n' +
    '    else if (href.startsWith("/lists")) switchTvLauncherTab("tv-lists");\n' +
    '    else if (href.startsWith("/channels")) switchTvLauncherTab("tv-channels");\n' +
    '    else if (href.startsWith("/collections")) switchTvLauncherTab("tv-collections");\n' +
    '    else if (href.startsWith("/library")) switchTvLauncherTab("tv-library");\n' +
    '    else if (href.startsWith("/discover")) switchTvLauncherTab("discover");\n' +
    '    else if (href.startsWith("/search")) switchTvLauncherTab("search");\n' +
    '    else if (href.startsWith("/link")) window.open("/link", "_blank", "noopener");\n' +
    '  }, true);\n' +
    '}\n';
}

function buildNuvioTvCatalogInterceptorsScript() {
  return 'function isChannelInTvConfig(channelId) {\n' +
    '  var wanted = String(channelId || "").trim();\n' +
    '  if (!wanted || !Array.isArray(tvLauncherTvLists)) return false;\n' +
    '  return tvLauncherTvLists.some(function(item) {\n' +
    '    if (!item || !item.url) return false;\n' +
    '    var u = String(item.url);\n' +
    '    if (u.includes(wanted)) return true;\n' +
    '    if (wanted.startsWith("channel-")) {\n' +
    '      var rawId = wanted.replace(/^channel-/, "");\n' +
    '      if (u.includes(rawId)) return true;\n' +
    '    }\n' +
    '    return false;\n' +
    '  });\n' +
    '}\n' +
    'function updateTvChannelAndStorylineButtons() {\n' +
    '  if (tvLauncherIsMirror) return;\n' +
    '  var cards = document.querySelectorAll("#storylinesContent .list-card[data-universe-id]");\n' +
    '  cards.forEach(function(card) {\n' +
    '    var uid = card.getAttribute("data-universe-id"); if (!uid) return;\n' +
    '    var chId = "channel-" + uid;\n' +
    '    var added = isChannelInTvConfig(chId);\n' +
    '    var btn = card.querySelector(".channelAddBtn");\n' +
    '    if (btn) {\n' +
    '      btn.classList.toggle("is-added", added);\n' +
    '      btn.classList.toggle("secondary", added);\n' +
    '      btn.classList.toggle("primary", !added);\n' +
    '      btn.textContent = added ? "Remove" : "+ Add";\n' +
    '      btn.style.color = added ? "var(--danger)" : "";\n' +
    '    }\n' +
    '  });\n' +
    '  var chCards = document.querySelectorAll("#myChannelsList .list-card");\n' +
    '  chCards.forEach(function(card) {\n' +
    '    var addBtn = card.querySelector(".channelAddBtn[data-act=\\"toggleChannelInCatalog\\"]");\n' +
    '    if (!addBtn) return;\n' +
    '    var args = addBtn.getAttribute("data-act-args"); var cid = "";\n' +
    '    try { cid = JSON.parse(args || "[]")[0]; } catch(e){}\n' +
    '    if (!cid) return;\n' +
    '    var added = isChannelInTvConfig(cid);\n' +
    '    addBtn.classList.toggle("is-added", added);\n' +
    '    addBtn.classList.toggle("secondary", added);\n' +
    '    addBtn.classList.toggle("primary", !added);\n' +
    '    addBtn.textContent = added ? "Remove" : "+ Add to Catalog";\n' +
    '    addBtn.style.color = added ? "var(--danger)" : "";\n' +
    '  });\n' +
    '}\n' +
    'function initTvCatalogInterceptors() {\n' +
    '  var origIsListAddedToConfig = window.isListAddedToConfig;\n' +
    '  window.isListAddedToConfig = function(url, type, slug) {\n' +
    '    if (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1") {\n' +
    '      if (!tvLauncherIsMirror) return isListAddedToTvConfig(url, type, slug);\n' +
    '    }\n' +
    '    return origIsListAddedToConfig ? origIsListAddedToConfig.apply(this, arguments) : false;\n' +
    '  };\n' +
    '  var origAddRow = window.addRow;\n' +
    '  window.addRow = function(name, url, type, enabled, group, channelId, noShuffle) {\n' +
    '    if (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1") {\n' +
    '      if (!tvLauncherIsMirror) {\n' +
    '        addTvCatalogRow(name, url, type);\n' +
    '        return null;\n' +
    '      }\n' +
    '      var res = origAddRow ? origAddRow.apply(this, arguments) : null;\n' +
    '      var cur = (typeof collectEntries === "function") ? collectEntries() : [];\n' +
    '      tvLauncherMainLists = JSON.parse(JSON.stringify(cur));\n' +
    '      renderTvHomeShelves();\n' +
    '      return res;\n' +
    '    }\n' +
    '    return origAddRow ? origAddRow.apply(this, arguments) : null;\n' +
    '  };\n' +
    '  var origRemoveListFromConfig = window.removeListFromConfig;\n' +
    '  window.removeListFromConfig = function(url, type, slug) {\n' +
    '    if (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1") {\n' +
    '      if (!tvLauncherIsMirror) {\n' +
    '        removeTvCatalogRow(url, type, slug);\n' +
    '        return;\n' +
    '      }\n' +
    '      if (origRemoveListFromConfig) origRemoveListFromConfig.apply(this, arguments);\n' +
    '      var cur = (typeof collectEntries === "function") ? collectEntries() : [];\n' +
    '      tvLauncherMainLists = JSON.parse(JSON.stringify(cur));\n' +
    '      renderTvHomeShelves();\n' +
    '      return;\n' +
    '    }\n' +
    '    if (origRemoveListFromConfig) return origRemoveListFromConfig.apply(this, arguments);\n' +
    '  };\n' +
    '  var origToggleChannelInCatalog = window.toggleChannelInCatalog;\n' +
    '  window.toggleChannelInCatalog = function(channelId) {\n' +
    '    if (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1") {\n' +
    '      if (!tvLauncherIsMirror) {\n' +
    '        var map = (typeof loadLocalChannels === "function") ? loadLocalChannels() : {};\n' +
    '        var ch = map[channelId];\n' +
    '        if (ch) {\n' +
    '          var chUrl = (typeof channelRowUrl === "function") ? channelRowUrl(ch) : ("channel:local:" + channelId);\n' +
    '          if (isChannelInTvConfig(channelId) || isListAddedToTvConfig(chUrl, "series", channelId)) removeTvCatalogRow(chUrl, "series", channelId);\n' +
    '          else addTvCatalogRow(ch.name || "Channel", chUrl, "series");\n' +
    '          if (typeof renderMyCreatedChannelsList === "function") renderMyCreatedChannelsList();\n' +
    '          updateTvChannelAndStorylineButtons();\n' +
    '        }\n' +
    '        return;\n' +
    '      }\n' +
    '      if (origToggleChannelInCatalog) origToggleChannelInCatalog.apply(this, arguments);\n' +
    '      var cur = (typeof collectEntries === "function") ? collectEntries() : [];\n' +
    '      tvLauncherMainLists = JSON.parse(JSON.stringify(cur));\n' +
    '      renderTvHomeShelves();\n' +
    '      return;\n' +
    '    }\n' +
    '    if (origToggleChannelInCatalog) return origToggleChannelInCatalog.apply(this, arguments);\n' +
    '  };\n' +
    '  var origCreateInstantStorylineChannel = window.createInstantStorylineChannel;\n' +
    '  window.createInstantStorylineChannel = function(eventId, btn) {\n' +
    '    if (typeof document !== "undefined" && document.documentElement.getAttribute("data-tv-launcher") === "1") {\n' +
    '      if (!tvLauncherIsMirror) {\n' +
    '        var ev = (typeof TV_CROSSOVER_EVENTS !== "undefined") ? TV_CROSSOVER_EVENTS.find(function(it){ return it.id === eventId; }) : null;\n' +
    '        if (ev) {\n' +
    '          var chId = "channel-" + ev.id;\n' +
    '          var chUrl = (typeof storylineChannelRowUrl === "function") ? storylineChannelRowUrl(ev) : ("channel:storyline:" + ev.id);\n' +
    '          if (isChannelInTvConfig(chId) || isListAddedToTvConfig(chUrl, "series", chId)) removeTvCatalogRow(chUrl, "series", chId);\n' +
    '          else addTvCatalogRow(ev.name, chUrl, "series");\n' +
    '          if (typeof renderStorylinesCategory === "function") renderStorylinesCategory(window._activeStorylinesCategory || "all");\n' +
    '          updateTvChannelAndStorylineButtons();\n' +
    '        }\n' +
    '        return;\n' +
    '      }\n' +
    '      if (origCreateInstantStorylineChannel) origCreateInstantStorylineChannel.apply(this, arguments);\n' +
    '      var cur = (typeof collectEntries === "function") ? collectEntries() : [];\n' +
    '      tvLauncherMainLists = JSON.parse(JSON.stringify(cur));\n' +
    '      renderTvHomeShelves();\n' +
    '      return;\n' +
    '    }\n' +
    '    if (origCreateInstantStorylineChannel) return origCreateInstantStorylineChannel.apply(this, arguments);\n' +
    '  };\n' +
    '}\n';
}

function buildNuvioTvShelvesAndLibraryScript() {
  return 'function renderTvHomeShelves() {\n' +
    '  var container = document.getElementById("tvHomeShelvesList");\n' +
    '  var noticeEl = document.getElementById("tvHomeShelvesNotice");\n' +
    '  if (!container) return;\n' +
    '  var isMirror = tvLauncherIsMirror;\n' +
    '  var sw = document.getElementById("tvMirrorSwitch");\n' +
    '  if (sw) sw.checked = isMirror;\n' +
    '  var copyBtn = document.getElementById("tvCopyMainBtn");\n' +
    '  if (copyBtn) copyBtn.style.display = isMirror ? "none" : "inline-flex";\n' +
    '  if (noticeEl) {\n' +
    '    noticeEl.innerHTML = isMirror\n' +
    '      ? "<div class=\\"u-p-12px_16px u-br-v_radius_md u-bg-v_surface u-bd-1px_solid_v_border u-mb-14px u-ai-center u-jc-space_between u-gap-12px\\" style=\\"display:flex; flex-wrap:wrap;\\"><div class=\\"u-flex-1 u-minw-0\\"><span class=\\"u-fw-600 u-fs-v_font_size_sm u-c-v_text\\" style=\\"display:block;\\">Mirroring Active</span><span class=\\"u-fs-v_font_size_xs u-c-v_muted u-mt-2px\\" style=\\"display:block;\\">Your TV displays the same shelves as your main account. Changes on the main dashboard reflect on your TV instantly.</span></div><button type=\\"button\\" class=\\"lc-btn secondary u-fs-v_font_size_xs\\" data-act=\\"turnOffTvMirrorAndCustomize\\">Customize Separate TV Shelves</button></div>"\n' +
    '      : "<div class=\\"u-p-12px_16px u-br-v_radius_md u-bg-v_surface u-bd-1px_solid_v_border u-mb-14px\\"><span class=\\"u-fw-600 u-fs-v_font_size_sm u-c-v_text\\" style=\\"display:block;\\">Custom TV Lineup Active</span><span class=\\"u-fs-v_font_size_xs u-c-v_muted u-mt-2px\\" style=\\"display:block;\\">This TV maintains its own independent catalogs and shelf order. Reorder with &uarr; and &darr; or remove items below.</span></div>";\n' +
    '  }\n' +
    '  var lists = isMirror ? ((tvLauncherMainLists && tvLauncherMainLists.length) ? tvLauncherMainLists : ((typeof entries !== "undefined" && entries.length) ? entries : [])) : tvLauncherTvLists;\n' +
    '  if (!lists.length) { container.innerHTML = "<p class=\\"u-ta-center u-mt-14px u-c-v_muted u-fs-v_font_size_sm\\">No shelves found. Use <strong>+ New Catalog</strong> or turn on <strong>Mirror Main Setup</strong> above.</p>"; return; }\n' +
    '  container.innerHTML = lists.map(function(item, idx) {\n' +
    '    var title = item.name || "Untitled Catalog";\n' +
    '    var type = item.type || "mixed";\n' +
    '    var isFirst = idx === 0, isLast = idx === lists.length - 1;\n' +
    '    var actionsHtml = isMirror\n' +
    '      ? "<span class=\\"u-fs-v_font_size_xs u-c-v_muted u-p-2px_8px u-br-v_radius_pill u-bd-1px_solid_v_border\\">Mirrored</span>"\n' +
    '      : "<div class=\\"u-ai-center u-gap-4px\\" style=\\"display:flex;\\"><button type=\\"button\\" class=\\"lc-btn ghost\\" data-act=\\"moveTvShelf\\" data-act-args=\\"[" + idx + ",-1]\\"" + (isFirst ? " disabled" : "") + " aria-label=\\"Up\\">&uarr;</button><button type=\\"button\\" class=\\"lc-btn ghost\\" data-act=\\"moveTvShelf\\" data-act-args=\\"[" + idx + ",1]\\"" + (isLast ? " disabled" : "") + " aria-label=\\"Down\\">&darr;</button><button type=\\"button\\" class=\\"lc-btn danger\\" data-act=\\"removeTvShelfItem\\" data-act-args=\\"[" + idx + "]\\" aria-label=\\"Remove\\" style=\\"color:var(--color-danger);\\">&#10005;</button></div>";\n' +
    '    return "<div class=\\"list-card u-mb-12px\\" data-url=\\"" + escapeAttr(item.url || "") + "\\" data-type=\\"" + escapeAttr(type) + "\\">" +\n' +
    '      "<div class=\\"list-card-header u-ai-center u-jc-space_between\\" style=\\"display:flex; flex-wrap:wrap; gap:8px;\\">" +\n' +
    '        "<div class=\\"list-card-body u-ai-center u-gap-8px u-minw-0\\" style=\\"display:flex; flex-wrap:wrap;\\">" +\n' +
    '          "<span class=\\"list-card-title u-fw-600 u-fs-v_font_size_sm u-c-v_text\\">" + escapeHtml(title) + "</span>" +\n' +
    '          "<span class=\\"u-fs-v_font_size_xs u-p-2px_6px u-br-v_radius_pill u-bg-v_surface u-c-v_muted u-bd-1px_solid_v_border\\">" + escapeHtml(type) + "</span>" +\n' +
    '        "</div>" +\n' +
    '        "<div class=\\"list-card-actions u-ai-center u-gap-6px\\" style=\\"display:flex;\\">" + actionsHtml + "</div>" +\n' +
    '      "</div>" +\n' +
    '      "<div class=\\"list-card-posters poster-preview-slot\\" data-name=\\"" + escapeAttr(title) + "\\" data-url=\\"" + escapeAttr(item.url || "") + "\\" data-type=\\"" + escapeAttr(type) + "\\"></div>" +\n' +
    '    "</div>";\n' +
    '  }).join("");\n' +
    '  if (typeof populateSearchResultPosters === "function") populateSearchResultPosters();\n' +
    '}\n' +
    'function moveTvShelf(idx, dir) {\n' +
    '  if (tvLauncherIsMirror) return;\n' +
    '  var target = idx + dir;\n' +
    '  if (target < 0 || target >= tvLauncherTvLists.length) return;\n' +
    '  var item = tvLauncherTvLists.splice(idx, 1)[0]; tvLauncherTvLists.splice(target, 0, item);\n' +
    '  saveTvLauncherConfig(false, tvLauncherTvLists); renderTvHomeShelves();\n' +
    '}\n' +
    'function removeTvShelfItem(idx) {\n' +
    '  if (tvLauncherIsMirror) return;\n' +
    '  if (idx < 0 || idx >= tvLauncherTvLists.length) return;\n' +
    '  var rem = tvLauncherTvLists.splice(idx, 1)[0]; saveTvLauncherConfig(false, tvLauncherTvLists); renderTvHomeShelves(); showToast("Removed \\"" + (rem.name || "Catalog") + "\\".", "success");\n' +
    '}\n' +
    'function renderTvLibraryTab() {\n' +
    '  var box = document.getElementById("tvLibraryContent"); if (!box) return;\n' +
    '  var isConnected = !!(typeof mediaAppListsLive !== "undefined" && mediaAppListsLive.nuvio);\n' +
    '  if (!isConnected) {\n' +
    '    box.innerHTML = "<div class=\\"panel u-ta-center u-p-24px\\"><div style=\\"font-size:32px; margin-bottom:8px;\\" aria-hidden=\\"true\\">&#128218;</div><h3 class=\\"u-fs-v_font_size_lg u-fw-700 u-c-v_text u-mb-6px\\">Connect Your Nuvio Account</h3><p class=\\"u-fs-v_font_size_sm u-c-v_muted u-maxw-420px u-m-0_auto_16px\\">Connect your Nuvio account to manage Continue Watching, Watch History, and Library items directly from this dashboard.</p><button type=\\"button\\" class=\\"lc-btn primary\\" data-act=\\"toggleListsMediaAppConnection\\" data-act-args=\\"[&quot;nuvio&quot;]\\">Connect Nuvio</button></div>";\n' +
    '    return;\n' +
    '  }\n' +
    '  var cards = [\n' +
    '    { title: "Continue Watching", sub: "Titles currently in progress.", slug: "continue-watching", slot: "tvLibraryCwSlot", add: false },\n' +
    '    { title: "Watch History", sub: "Titles you have watched.", slug: "watch-history", slot: "tvLibraryWhSlot", add: true },\n' +
    '    { title: "Nuvio Library", sub: "Movies and shows saved in your library.", slug: "library", slot: "tvLibraryLibSlot", add: true }\n' +
    '  ];\n' +
    '  box.innerHTML = "<div class=\\"u-fd-column u-gap-14px\\" style=\\"display:flex;\\">" +\n' +
    '    cards.map(function(c) {\n' +
    '      return "<div class=\\"panel\\"><div class=\\"shelf-header u-mb-10px u-ai-center u-jc-space_between\\" style=\\"display:flex;\\"><div><h3 class=\\"panel-title u-mb-0\\">" + c.title + "</h3><p class=\\"u-m-0 u-c-v_muted u-fs-v_font_size_xs\\">" + c.sub + "</p></div><div class=\\"u-gap-6px u-ai-center\\" style=\\"display:flex;\\">" + (c.add ? "<button type=\\"button\\" class=\\"lc-btn primary u-fs-v_font_size_xs\\" data-act=\\"openTvMediaAdd\\" data-act-args=\\"[&quot;" + c.slug + "&quot;]\\">+ Add title</button>" : "") + "<button type=\\"button\\" class=\\"lc-btn secondary u-fs-v_font_size_xs\\" data-act=\\"openTvMediaAll\\" data-act-args=\\"[&quot;" + c.slug + "&quot;]\\">Manage &rarr;</button></div></div><div id=\\"" + c.slot + "\\" class=\\"poster-preview-slot\\" data-url=\\"autotrack:nuvio-" + c.slug + ":mixed\\" data-type=\\"mixed\\"></div></div>";\n' +
    '    }).join("") + "</div>";\n' +
    '  if (typeof populateSearchResultPosters === "function") populateSearchResultPosters();\n' +
    '}\n' +
    'function openTvMediaAdd(target) {\n' +
    '  window._mediaHistoryAddProvider = "nuvio";\n' +
    '  window._mediaAppAddTarget = target;\n' +
    '  window._currentListDetailsParams = { listUrl: "autotrack:nuvio-" + target + ":mixed" };\n' +
    '  if (typeof openMediaHistoryAdd === "function") openMediaHistoryAdd();\n' +
    '}\n' +
    'function openTvMediaAll(slug) {\n' +
    '  if (typeof openMediaAppListDetails === "function") openMediaAppListDetails("nuvio", slug);\n' +
    '}\n';
}

function buildNuvioTvClientLogicScript(origin) {
  return 'function renderTvListsTab() {\n' +
    '  document.documentElement.removeAttribute("data-initial-lists-sub");\n' +
    '  var activeSub = localStorage.getItem("myListAddon:listsSubmenu") || "my-lists";\n' +
    '  if (activeSub === "collections") activeSub = "my-lists";\n' +
    '  var myListsSub = document.getElementById("listsSubMyLists");\n' +
    '  if (myListsSub && activeSub === "my-lists") myListsSub.style.display = "block";\n' +
    '  if (typeof switchListsSubmenu === "function") switchListsSubmenu(activeSub);\n' +
    '  if (typeof updateAllListAddButtons === "function") updateAllListAddButtons();\n' +
    '}\n' +
    'function renderTvChannelsTab() {\n' +
    '  var activeSub = localStorage.getItem("myListAddon:channelsSubmenu") || "my-channels";\n' +
    '  if (typeof switchChannelsSubmenu === "function") switchChannelsSubmenu(activeSub);\n' +
    '  if (typeof renderMyCreatedChannelsList === "function") renderMyCreatedChannelsList();\n' +
    '  if (typeof renderStorylinesCategory === "function") renderStorylinesCategory(window._activeStorylinesCategory || "all");\n' +
    '  if (typeof updateTvChannelAndStorylineButtons === "function") updateTvChannelAndStorylineButtons();\n' +
    '}\n' +
    'function renderTvCollectionsTab() {\n' +
    '  var container = document.getElementById("tvCollectionsResult"); if (!container) return;\n' +
    '  var subCol = document.getElementById("listsSubCollections");\n' +
    '  if (subCol) {\n' +
    '    document.documentElement.removeAttribute("data-initial-lists-sub");\n' +
    '    subCol.style.setProperty("display", "block", "important");\n' +
    '    if (subCol.parentNode !== container) container.appendChild(subCol);\n' +
    '  }\n' +
    '  if (typeof renderCollectionsView === "function") renderCollectionsView();\n' +
    '  else {\n' +
    '    if (typeof renderCustomCollections === "function") renderCustomCollections();\n' +
    '    if (typeof renderPremadeCollections === "function") renderPremadeCollections();\n' +
    '  }\n' +
    '  if (typeof refreshMediaAppConnections === "function") refreshMediaAppConnections();\n' +
    '}\n' +
    'function addTvCatalogRow(name, url, type) {\n' +
    '  if (!url) return;\n' +
    '  if (tvLauncherIsMirror) turnOffTvMirrorAndCustomize();\n' +
    '  var cleanUrl = String(url).trim(), cleanType = type || "mixed", cleanName = name || "New Catalog";\n' +
    '  var exists = tvLauncherTvLists.some(function(it) { return it.url === cleanUrl && it.type === cleanType; });\n' +
    '  if (exists) { showToast("\\"" + cleanName + "\\" is already on your TV shelves.", "info"); return; }\n' +
    '  tvLauncherTvLists.push({ name: cleanName, url: cleanUrl, type: cleanType, enabled: true });\n' +
    '  saveTvLauncherConfig(false, tvLauncherTvLists); renderTvHomeShelves();\n' +
    '  if (typeof updateAllListAddButtons === "function") updateAllListAddButtons();\n' +
    '  if (typeof updateTvChannelAndStorylineButtons === "function") updateTvChannelAndStorylineButtons();\n' +
    '  showToast("Added \\"" + cleanName + "\\" to TV Launcher shelves.", "success");\n' +
    '}\n' +
    'function initNuvioTvLauncherMode() {\n' +
    '  if (!isTvLauncherPage()) return;\n' +
    '  document.documentElement.setAttribute("data-tv-launcher", "1");\n' +
    '  if (typeof initTvNavInterceptors === "function") initTvNavInterceptors();\n' +
    '  if (typeof initTvCatalogInterceptors === "function") initTvCatalogInterceptors();\n' +
    '  renderTvNavTabs();\n' +
    '  var mainHost = document.querySelector(".page") || document.querySelector("main") || document.body;\n' +
    '  if (mainHost && !document.getElementById("content-tv-home")) {\n' +
    '    var tvPanelsWrap = document.createElement("div");\n' +
    '    tvPanelsWrap.id = "tvPanelsWrap";\n' +
    '    tvPanelsWrap.innerHTML = buildTvHomePanelHtml() + buildTvLibraryPanelHtml() + buildTvCollectionsPanelHtml();\n' +
    '    var catalogsPanel = document.getElementById("content-catalogs");\n' +
    '    if (catalogsPanel && catalogsPanel.parentNode) catalogsPanel.parentNode.insertBefore(tvPanelsWrap, catalogsPanel);\n' +
    '    else mainHost.insertBefore(tvPanelsWrap, mainHost.firstChild);\n' +
    '    var subCol = document.getElementById("listsSubCollections");\n' +
    '    var colBox = document.getElementById("tvCollectionsResult");\n' +
    '    if (subCol && colBox && subCol.parentNode !== colBox) {\n' +
    '      subCol.style.setProperty("display", "block", "important");\n' +
    '      colBox.appendChild(subCol);\n' +
    '    }\n' +
    '  }\n' +
    '  document.documentElement.removeAttribute("data-initial-lists-sub");\n' +
    '  var colPill = document.querySelector("#listsSubnavBar .subnav-pill[data-sub=\\"collections\\"]");\n' +
    '  if (colPill) colPill.style.display = "none";\n' +
    '  switchTvLauncherTab("tv-home");\n' +
    '  loadTvLauncherConfig();\n' +
    '}\n' +
    'if (typeof document !== "undefined") {\n' +
    '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initNuvioTvLauncherMode);\n' +
    '  else initNuvioTvLauncherMode();\n' +
    '}\n' +
    'window.isTvLauncherPage = isTvLauncherPage;\n' +
    'window.switchTvLauncherTab = switchTvLauncherTab;\n' +
    'window.renderTvHomeShelves = renderTvHomeShelves;\n' +
    'window.turnOffTvMirrorAndCustomize = turnOffTvMirrorAndCustomize;\n' +
    'window.copyTvMainSetup = copyTvMainSetup;\n' +
    'window.moveTvShelf = moveTvShelf;\n' +
    'window.removeTvShelfItem = removeTvShelfItem;\n' +
    'window.onTvMirrorToggle = onTvMirrorToggle;\n' +
    'window.copyTvManifestUrl = copyTvManifestUrl;\n' +
    'window.renderTvLibraryTab = renderTvLibraryTab;\n' +
    'window.openTvMediaAdd = openTvMediaAdd;\n' +
    'window.openTvMediaAll = openTvMediaAll;\n' +
    'window.renderTvCollectionsTab = renderTvCollectionsTab;\n' +
    'window.renderTvListsTab = renderTvListsTab;\n' +
    'window.renderTvChannelsTab = renderTvChannelsTab;\n' +
    'window.addTvCatalogRow = addTvCatalogRow;\n' +
    'window.removeTvCatalogRow = removeTvCatalogRow;\n' +
    'window.isListAddedToTvConfig = isListAddedToTvConfig;\n' +
    'window.isChannelInTvConfig = isChannelInTvConfig;\n' +
    'window.updateTvChannelAndStorylineButtons = updateTvChannelAndStorylineButtons;\n' +
    'window.initNuvioTvLauncherMode = initNuvioTvLauncherMode;\n';
}

function buildNuvioTvLauncherClientScript(origin) {
  return '<script nonce="' + CSP_NONCE_PLACEHOLDER + '">\n' +
    '(function() {\n' +
    buildNuvioTvConfigScript(origin) +
    buildNuvioTvShelvesAndLibraryScript() +
    buildNuvioTvNavInterceptorsScript() +
    buildNuvioTvCatalogInterceptorsScript() +
    buildNuvioTvClientLogicScript(origin) +
    buildNuvioTvNavScript() +
    buildNuvioTvDomTemplates(origin) +
    '})();\n' +
    '</script>\n';
}

async function handleNuvioTvLauncherPage(request, env, ctx, url, path) {
  ctx.waitUntil(bumpStat(env, "pageviews"));
  const origin = url ? url.origin : "";
  const baseHtml = renderPageCached(request, origin, {});
  const scriptTag = buildNuvioTvLauncherClientScript(origin);
  const fullHtml = baseHtml.indexOf("</body>") !== -1
    ? baseHtml.replace("</body>", scriptTag + "</body>")
    : baseHtml + scriptTag;
  return await htmlPageResponse(request, fullHtml);
}
