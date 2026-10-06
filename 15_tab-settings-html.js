  <!-- Subpanel 1: Account & Security -->
  <div class="settings-subpanel" id="settingsSubAccount">
    <div class="panel">
      <h2 class="panel-title">Your Account</h2>
      <div id="accountKeySection"></div>
    </div>
  </div>

  <!-- Subpanel 2: Catalog & Display -->
  <div class="settings-subpanel" id="settingsSubDisplay" style="display:none;">
    <!-- Consolidated Catalog & Content Rules (P1 & P2) -->
    <div class="panel">
      <div class="shelf-header" style="margin-bottom:8px;">
        <h2 class="shelf-title">Catalog &amp; Content Rules</h2>
      </div>
      <p style="margin:0 0 14px; color:var(--muted); font-size:var(--font-size-sm);">Configure streaming availability, digital release filters, cross-list deduplication, and adult content safety.</p>

      <div class="settings-row-group">
        <!-- Region -->
        <div class="settings-row-item" style="padding-bottom:14px; border-bottom:1px solid var(--border);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap;">
            <div style="flex:1; min-width:240px;">
              <span style="font-weight:600; font-size:var(--font-size-base); color:var(--text);">Content Region</span>
              <p style="margin:3px 0 0; color:var(--muted); font-size:var(--font-size-sm); line-height:1.35;">Used for streaming-availability catalogs (Netflix, Disney+, etc.), Stream Releases, and content ratings.</p>
            </div>
            <div style="flex:none; width:100%; max-width:320px;">
              <select id="regionSelect" aria-label="Streaming region" data-act="appActStoreSettingValue" data-act-args="[&quot;myListAddon:region&quot;,&quot;@value&quot;]" style="width:100%; max-width:320px; padding:7px 12px; border-radius:var(--radius-pill); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:var(--font-size-sm); box-sizing:border-box;">
                ${buildRegionOptionsHtml(initialRegion)}
              </select>
            </div>
          </div>
        </div>

        <!-- Digital Release Filter -->
        <div class="settings-row-item" style="padding:14px 0; border-bottom:1px solid var(--border);">
          <div class="settings-toggle-row" style="padding:0; border:none;">
            <div style="flex:1; min-width:0; padding-right:12px;">
              <span style="font-weight:600; font-size:var(--font-size-base); color:var(--text);">Hide items with no digital release</span>
              <p style="margin:3px 0 0; color:var(--muted); font-size:var(--font-size-sm); line-height:1.35;">Removes still-in-theaters movies with no known digital or physical release from TMDB Trending and Popular catalogs.</p>
              <details style="margin-top:6px; font-size:var(--font-size-sm); color:var(--muted);">
                <summary style="cursor:pointer; color:var(--accent); font-weight:600;">More details</summary>
                <p style="margin:4px 0 0;">Useful for skipping in-theaters titles you cannot stream or buy yet. TV Shows are not affected. Requires Save/Update to take effect on an existing install link.</p>
              </details>
            </div>
            <label class="ui-toggle" aria-label="Hide items with no digital release">
              <input type="checkbox" id="hideNonDigitalReleasesCheckbox" ${initialHideNonDigitalReleases ? 'checked' : ''} data-act="appActStoreSettingChecked" data-act-args="[&quot;myListAddon:hideNonDigitalReleases&quot;,&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
        </div>

        <!-- Deduplication -->
        <div class="settings-row-item" id="legacyDedupePanel" style="padding:14px 0; border-bottom:1px solid var(--border);">
          <div class="settings-toggle-row" style="padding:0; border:none;">
            <div style="flex:1; min-width:0; padding-right:12px;">
              <span style="font-weight:600; font-size:var(--font-size-base); color:var(--text);">Remove duplicate items across lists</span>
              <p style="margin:3px 0 0; color:var(--muted); font-size:var(--font-size-sm); line-height:1.35;">Automatically removes titles from lower catalog rows if already shown in a row above.</p>
              <details style="margin-top:6px; font-size:var(--font-size-sm); color:var(--muted);">
                <summary style="cursor:pointer; color:var(--accent); font-weight:600;">How row deduplication works</summary>
                <p style="margin:4px 0 0;">Keeps your top catalog row intact; every list below it has items shown in earlier lists filtered out. Drag lists in Catalogs to change priority. Requires Save/Update to take effect on an existing install link.</p>
              </details>
            </div>
            <label class="ui-toggle" aria-label="Remove duplicate items across lists">
              <input type="checkbox" id="dedupeAcrossListsCheckbox" ${initialDedupeAcrossLists ? 'checked' : ''} data-act="appActStoreSettingChecked" data-act-args="[&quot;myListAddon:dedupeAcrossLists&quot;,&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
        </div>

        <!-- Adult Content -->
        <div class="settings-row-item" style="padding-top:14px;">
          <div class="settings-toggle-row" style="padding:0; border:none;">
            <div style="flex:1; min-width:0; padding-right:12px;">
              <span style="font-weight:600; font-size:var(--font-size-base); color:var(--text);">Adult Content Filter</span>
              <p style="margin:3px 0 0; color:var(--muted); font-size:var(--font-size-sm); line-height:1.35;">Filter NSFW posters and replace default unfiltered posters with safe, age-appropriate ones across your catalogs, search, continue watching, and Stremio/Nuvio.</p>
            </div>
            <label class="ui-toggle" aria-label="Adult Content Filter">
              <input type="checkbox" id="adultContentFilterCheckbox" ${initialAdultContentFilter ? 'checked' : ''} data-act="appActToggleAdultFilter" data-act-args="[&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- Better Posters Panel (P2 & P3) -->
    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Better Posters</h2>
      <p style="margin:0 0 12px; color:var(--muted); font-size:var(--font-size-sm);">Swap plain poster artwork for <a href="https://btttr.cc/" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">BetterPosters</a> &mdash; posters with the genre, rating and tags drawn directly into the artwork. No API key or account needed.</p>
      <div class="settings-toggle-row" style="padding:0 0 12px; border-bottom:none;">
        <div style="flex:1; min-width:0; padding-right:12px;">
          <span style="font-weight:600; font-size:var(--font-size-base); color:var(--text);">Use Better Posters artwork</span>
          <p style="margin:3px 0 0; color:var(--muted); font-size:var(--font-size-sm); line-height:1.35;">Enriches artwork across Live Preview, Search, Discover, and your streaming catalog rows.</p>
          <details style="margin-top:6px; font-size:var(--font-size-sm); color:var(--muted);">
            <summary style="cursor:pointer; color:var(--accent); font-weight:600;">Artwork compatibility details</summary>
            <p style="margin:4px 0 0;">Only titles with an IMDb ID are affected. Poster badges are drawn over this artwork rather than replacing it. Adult Content Filter still overrides it. TV Channel artwork and episode stills are preserved.</p>
          </details>
        </div>
        <label class="ui-toggle" aria-label="Use Better Posters artwork">
          <input type="checkbox" id="betterPostersCheckbox" ${initialBetterPosters ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPosters&quot;,&quot;@checked&quot;]">
          <span class="ui-toggle-slider"></span>
        </label>
      </div>
      <div id="betterPostersOptions" style="display:${initialBetterPosters ? 'flex' : 'none'}; flex-direction:column; gap:12px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
        <div style="font-size:var(--font-size-sm); font-weight:700; color:var(--text);">What to draw on the poster</div>
        <div class="settings-check-group two-col-grid">
          <label class="settings-check-item">
            <input type="checkbox" id="betterPostersGenreCheckbox" ${initialBetterPostersGenre ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersGenre&quot;,&quot;@checked&quot;]">
            <div style="flex:1; min-width:0;">
              <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Genre</span>
              <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Genre label along the bottom of the poster.</p>
            </div>
          </label>
          <label class="settings-check-item">
            <input type="checkbox" id="betterPostersRatingCheckbox" ${initialBetterPostersRating ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersRating&quot;,&quot;@checked&quot;]">
            <div style="flex:1; min-width:0;">
              <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Rating</span>
              <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Star rating along the bottom of the poster.</p>
            </div>
          </label>
          <label class="settings-check-item">
            <input type="checkbox" id="betterPostersTrendTagsCheckbox" ${initialBetterPostersTrendTags ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersTrendTags&quot;,&quot;@checked&quot;]">
            <div style="flex:1; min-width:0;">
              <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Trend tags</span>
              <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">A corner tag on titles that are currently trending or newly released.</p>
            </div>
          </label>
          <label class="settings-check-item">
            <input type="checkbox" id="betterPostersQualityCheckbox" ${initialBetterPostersQuality ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersQuality&quot;,&quot;@checked&quot;]">
            <div style="flex:1; min-width:0;">
              <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Quality tags</span>
              <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">4K, Dolby Vision and Atmos badges, where BetterPosters knows them.</p>
            </div>
          </label>
          <label class="settings-check-item">
            <input type="checkbox" id="betterPostersAgeCheckbox" ${initialBetterPostersAge ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersAge&quot;,&quot;@checked&quot;]">
            <div style="flex:1; min-width:0;">
              <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Age rating</span>
              <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Certification chip (PG-13, TV-MA, and so on).</p>
            </div>
          </label>
        </div>
        <div style="display:flex; gap:16px; flex-wrap:wrap; margin-top:6px;">
          <div style="flex:1; min-width:220px; max-width:320px;">
            <label for="betterPostersRatingSourceSelect" style="display:block; font-size:var(--font-size-sm); font-weight:600; color:var(--text); margin-bottom:4px;">Rating source</label>
            <select id="betterPostersRatingSourceSelect" data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersRatingSource&quot;,&quot;@value&quot;]" style="width:100%; padding:7px 12px; border-radius:var(--radius-pill); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:var(--font-size-sm); box-sizing:border-box;">
              ${betterPostersRatingSourceOptionsHtml}
            </select>
            <p style="margin:4px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Which score the rating is taken from.</p>
          </div>
          <div style="flex:1; min-width:220px; max-width:320px;">
            <label for="betterPostersLangSelect" style="display:block; font-size:var(--font-size-sm); font-weight:600; color:var(--text); margin-bottom:4px;">Poster language</label>
            <select id="betterPostersLangSelect" data-act="toggleBetterPostersSetting" data-act-args="[&quot;betterPostersLang&quot;,&quot;@value&quot;]" style="width:100%; padding:7px 12px; border-radius:var(--radius-pill); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:var(--font-size-sm); box-sizing:border-box;">
              ${betterPostersLangOptionsHtml}
            </select>
            <p style="margin:4px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Language BetterPosters draws text in.</p>
          </div>
        </div>
      </div>
    </div>

    <!-- RatingPosterDB Panel -->
    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">RatingPosterDB</h2>
      <p style="margin:0 0 12px; color:var(--muted); font-size:var(--font-size-sm);">Swap plain poster artwork for <a href="https://ratingposterdb.com/" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">RatingPosterDB</a> posters with ratings drawn on, styled the way you set them up at <a href="https://manager.ratingposterdb.com/" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">manager.ratingposterdb.com</a>. Needs your own paid RPDB API key.</p>
      <div class="settings-toggle-row" style="padding:0 0 12px; border-bottom:none;">
        <div style="flex:1; min-width:0; padding-right:12px;">
          <span style="font-weight:600; font-size:var(--font-size-base); color:var(--text);">Use RatingPosterDB artwork</span>
          <p style="margin:3px 0 0; color:var(--muted); font-size:var(--font-size-sm); line-height:1.35;">Replaces poster artwork in Stremio and Nuvio. Turns Better Posters and Pictorium off, because only one can draw a poster.</p>
          <details style="margin-top:6px; font-size:var(--font-size-sm); color:var(--muted);">
            <summary style="cursor:pointer; color:var(--accent); font-weight:600;">How your request limit is protected</summary>
            <p style="margin:4px 0 0;">Every poster RatingPosterDB sends counts against your key's monthly limit, so posters are not loaded from it directly. This add-on fetches each poster once, keeps it for three days, and shows it to every device from that copy. It asks RatingPosterDB for at most 20 new posters a minute, so a page of new titles fills in over a few minutes (the ordinary poster shows meanwhile), and it stops asking once 95% of your monthly limit is used. Only titles with an IMDb ID are affected. Airing Next and date badges are not drawn over these posters. The website keeps its normal posters.</p>
          </details>
        </div>
        <label class="ui-toggle" aria-label="Use RatingPosterDB artwork">
          <input type="checkbox" id="rpdbCheckbox" ${initialRpdb ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;rpdb&quot;,&quot;@checked&quot;]">
          <span class="ui-toggle-slider"></span>
        </label>
      </div>
      <div id="rpdbOptions" style="display:${initialRpdb ? 'flex' : 'none'}; flex-direction:column; gap:12px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
        <div>
          <label for="rpdbKeyInput" style="display:block; font-size:var(--font-size-sm); font-weight:600; color:var(--text); margin-bottom:4px;">API key</label>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <input type="password" id="rpdbKeyInput" value="${escapeHtmlServer(initialRpdbKey)}" placeholder="t1-..." autocomplete="off" spellcheck="false" data-act="toggleBetterPostersSetting" data-act-args="[&quot;rpdbKey&quot;,&quot;@value&quot;]" style="flex:1; min-width:200px; max-width:380px; padding:7px 12px; border-radius:var(--radius-pill); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:var(--font-size-sm); box-sizing:border-box;">
            <button type="button" class="secondary lc-btn" data-act="testRpdbKey" data-act-args="[&quot;@self&quot;]" style="border-radius:var(--radius-pill);">Test key</button>
          </div>
          <p id="rpdbKeyStatus" style="margin:4px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Your key starts with t1- to t4- and is in the email RatingPosterDB sent you, or at ratingposterdb.com after you log in with Patreon. Test key shows whether it works and how much of this month's limit is used.</p>
        </div>
      </div>
    </div>

    <!-- Pictorium Panel -->
    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Pictorium</h2>
      <p style="margin:0 0 12px; color:var(--muted); font-size:var(--font-size-sm);">Swap plain poster artwork for posters drawn by your own <a href="https://github.com/Eful97/Pictorium" target="_blank" rel="noopener noreferrer" style="color:var(--accent);">Pictorium</a> space &mdash; ratings, streaming quality, Netflix Top 10 ribbons, awards and more, styled the way you set them up there. Needs a Pictorium space with your own TMDB key.</p>
      <div class="settings-toggle-row" style="padding:0 0 12px; border-bottom:none;">
        <div style="flex:1; min-width:0; padding-right:12px;">
          <span style="font-weight:600; font-size:var(--font-size-base); color:var(--text);">Use Pictorium artwork</span>
          <p style="margin:3px 0 0; color:var(--muted); font-size:var(--font-size-sm); line-height:1.35;">Replaces poster artwork in Stremio and Nuvio and across the website. Turns Better Posters and RatingPosterDB off, because only one can draw a poster.</p>
          <details style="margin-top:6px; font-size:var(--font-size-sm); color:var(--muted);">
            <summary style="cursor:pointer; color:var(--accent); font-weight:600;">Artwork compatibility details</summary>
            <p style="margin:4px 0 0;">Only titles with an IMDb ID are affected. Pictorium draws its own badges, so the Airing Next and date badges are not drawn over its posters. Adult Content Filter still overrides it on the website. TV Channel artwork and episode stills are preserved.</p>
          </details>
        </div>
        <label class="ui-toggle" aria-label="Use Pictorium artwork">
          <input type="checkbox" id="pictoriumCheckbox" ${initialPictorium ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;pictorium&quot;,&quot;@checked&quot;]">
          <span class="ui-toggle-slider"></span>
        </label>
      </div>
      <div id="pictoriumOptions" style="display:${initialPictorium ? 'flex' : 'none'}; flex-direction:column; gap:12px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
        <div>
          <label for="pictoriumUrlInput" style="display:block; font-size:var(--font-size-sm); font-weight:600; color:var(--text); margin-bottom:4px;">Poster link</label>
          <input type="url" id="pictoriumUrlInput" value="${escapeHtmlServer(initialPictoriumUrl)}" placeholder="https://your-pictorium-host/api/poster/{type}/{tmdb_id|imdb_id}?u=..." autocomplete="off" spellcheck="false" data-act="toggleBetterPostersSetting" data-act-args="[&quot;pictoriumUrl&quot;,&quot;@value&quot;]" style="width:100%; padding:7px 12px; border-radius:var(--radius-pill); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:var(--font-size-sm); box-sizing:border-box;">
          <p id="pictoriumUrlHint" style="margin:4px 0 0; color:var(--muted); font-size:var(--font-size-xs);">In your Pictorium space, copy the <strong>AIOMetadata</strong> poster link and paste it here as it is. It has to start with https:// and contain <code>/api/poster/</code>, <code>{type}</code> and <code>{tmdb_id|imdb_id}</code>.</p>
        </div>
      </div>
    </div>

    <!-- Metadata Panel -->
    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Metadata</h2>
      <div class="settings-toggle-row" style="padding:0; border-bottom:none;">
        <div style="flex:1; min-width:0; padding-right:12px;">
          <span style="font-weight:600; font-size:var(--font-size-base); color:var(--text);">Use My Lists Addon metadata</span>
          <p style="margin:3px 0 0; color:var(--muted); font-size:var(--font-size-sm); line-height:1.35;">Lets this add-on supply a title's details page (synopsis, cast, trailers, episodes) in Stremio and Nuvio. Turn it off to use My Lists Addon for lists only and let another add-on supply the details. TV Channel titles keep their details page. Reinstall the add-on after changing this. Posters on the list tiles still come from this add-on (see Better Posters and Pictorium above), not from the other add-on.</p>
        </div>
        <label class="ui-toggle" aria-label="Use My Lists Addon metadata">
          <input type="checkbox" id="provideMetadataCheckbox" ${initialProvideMetadata ? 'checked' : ''} data-act="toggleBetterPostersSetting" data-act-args="[&quot;provideMetadata&quot;,&quot;@checked&quot;]">
          <span class="ui-toggle-slider"></span>
        </label>
      </div>
    </div>

    <!-- Poster Badges & Labels Panel (P3) -->
    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Poster Badges &amp; Labels</h2>
      <p style="margin:0 0 14px; color:var(--muted); font-size:var(--font-size-sm);">Customize which badges and indicators are displayed on posters across your website dashboard, catalogs, and Stremio/Nuvio.</p>
      <div style="display:flex; flex-direction:column; gap:16px;">
        <div style="border-bottom:1px solid var(--border); padding-bottom:14px; display:flex; flex-direction:column; gap:6px;">
          <div style="font-size:var(--font-size-sm); font-weight:700; color:var(--text); margin-bottom:4px;">Website &amp; Dashboard</div>
          <div class="settings-check-group two-col-grid">
            <label class="settings-check-item">
              <input type="checkbox" id="badgeAiringNextCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesAiringNext&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Airing Next (Dashboard)</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Airing Next shelf and provider lists on your dashboard</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeContinueWatchingCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesContinueWatching&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Continue Watching</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">In-progress series on your website dashboard</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeWatchlistCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesWatchlist&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Watchlist</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Shows in your Watchlist with upcoming episodes</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeTraktContinueWatchingCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesTraktContinueWatching&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Trakt Continue Watching</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Connected Trakt Continue Watching series</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeMdblistUpNextCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesMdblistUpNext&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">MDBList Up Next</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Connected MDBList Up Next series</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeCatalogsCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesCatalogs&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Catalogs &amp; Live Preview</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Catalog rows, Catalogs Live Preview &amp; Editor, and See All views</p>
              </div>
            </label>
          </div>
        </div>

        <div style="border-bottom:1px solid var(--border); padding-bottom:14px; display:flex; flex-direction:column; gap:6px;">
          <div style="font-size:var(--font-size-sm); font-weight:700; color:var(--text); margin-bottom:4px;">Stremio &amp; Nuvio (Artwork Overlays)</div>
          <div class="settings-check-group two-col-grid">
            <label class="settings-check-item">
              <input type="checkbox" id="badgeStremioAiringNextCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesStremioAiringNext&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Airing Next Catalogs in Stremio &amp; Nuvio</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Overlay premiere, finale, and air date chips in Stremio and Nuvio</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeStremioContinueWatchingCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesStremioContinueWatching&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Continue Watching Catalogs in Stremio &amp; Nuvio</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Overlay chips on Continue Watching artwork in Stremio and Nuvio</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeStremioWatchlistCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesStremioWatchlist&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Watchlist Catalogs in Stremio &amp; Nuvio</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Overlay chips on Watchlist artwork in Stremio and Nuvio</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeStremioCatalogsCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgesStremioCatalogs&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Other Custom &amp; Provider Catalogs</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Overlay badges on MDBList, Trakt, Simkl, and Custom list rows</p>
              </div>
            </label>
          </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:6px;">
          <div style="font-size:var(--font-size-sm); font-weight:700; color:var(--text); margin-bottom:4px;">Badge Types</div>
          <div class="settings-check-group two-col-grid">
            <label class="settings-check-item">
              <input type="checkbox" id="badgeAirDateCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgeAirDate&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Upcoming Air Date</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Air date countdown (e.g. <code>TODAY</code>, <code>TOMORROW</code>)</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeSeasonPremiereCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgeSeasonPremiere&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Season Premiere</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Green <code>Season Premiere</code> badge on un-aired Episode 1s</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeSeasonFinaleCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgeSeasonFinale&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Season Finale</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Orange <code>Season Finale</code> badge on season finales</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeSeasonFinaleDateCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgeSeasonFinaleDate&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Season Finale Date</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Date when the season finale will air on mid-season episodes</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeTmdbRatingCheckbox" checked data-act="toggleTmdbRatingSetting" data-act-args="[&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">TMDb Ratings</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Star rating (e.g. <span style="color:#f5c518; font-weight:700;">★ 7.9</span>) beside the year/subtitle</p>
              </div>
            </label>
            <label class="settings-check-item">
              <input type="checkbox" id="badgeWatchedCheckbox" checked data-act="toggleBadgeSetting" data-act-args="[&quot;showBadgeWatched&quot;,&quot;@checked&quot;]">
              <div style="flex:1; min-width:0;">
                <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Watched Status Badges</span>
                <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Checkmark badge on movies and shows you've already watched</p>
              </div>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- Hidden Lists Panel -->
    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Hidden Lists</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:var(--font-size-sm);">Hide specific lists from My Lists, Airing Next, and Simkl Airing Next. A hidden list is still tracked and updated normally underneath -- only its display is suppressed, and it can be shown again here at any time.</p>
      <div id="hiddenListsSettingsSection"></div>
    </div>
  </div>

  <!-- Subpanel 3: Tracking & Scrobble -->
  <div class="settings-subpanel" id="settingsSubScrobble" style="display:none;">
    <div class="panel">
      <h2 class="panel-title">Watchlist Preferences</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:var(--font-size-sm);">Customize how watched movies and TV shows are managed in your personal Watchlist.</p>
      <div id="watchlistPreferencesSection"></div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Watch History &amp; Continue Watching</h2>
      <div style="border-bottom:1px solid var(--border); padding-bottom:12px; margin-bottom:12px;">
        <div class="settings-toggle-row" style="padding-top:4px;">
          <div style="flex:1; min-width:0; padding-right:12px;">
            <span style="font-weight:600; font-size:var(--font-size-base); color:var(--text);">Storyline &amp; Companion Recommendations</span>
            <p style="margin:3px 0 0; color:var(--muted); font-size:var(--font-size-sm); line-height:1.35;">Automatically recommend canon bridge movies between seasons (e.g. <em>Demon Slayer: Mugen Train</em>) and sequel films or spin-off series when a show concludes (e.g. <em>Breaking Bad &rarr; El Camino &rarr; Better Call Saul</em>).</p>
          </div>
          <label class="ui-toggle" aria-label="Toggle Storyline and Companion Recommendations">
            <input type="checkbox" id="autoRecommendCompanionsCheckbox" checked data-act="toggleCompanionRecommendationSetting" data-act-args="[&quot;@checked&quot;]">
            <span class="ui-toggle-slider"></span>
          </label>
        </div>
      </div>
      <p style="margin:0 0 10px; color:var(--muted); font-size:var(--font-size-sm);">Reset or clear all recorded movies and episodes from your personal Watch History or in-progress Continue Watching.</p>
      <div id="watchHistorySettingsSection" style="display:flex; gap:10px; flex-wrap:wrap;">
        <button type="button" class="btn-danger btn-sm" data-act="clearWatchHistoryAll">Clear Watch History</button>
        <button type="button" class="btn-danger btn-sm" data-act="clearContinueWatchingAll">Clear Continue Watching</button>
      </div>
    </div>

    <div class="panel" style="margin-top:12px;">
      <h2 class="panel-title">Auto-Track &amp; Media Server Scrobbling</h2>
      <p style="margin:0 0 10px; color:var(--muted); font-size:var(--font-size-sm);">Automatically scrobble and track watched movies and TV episodes across your streaming apps (Stremio, Nuvio, Wako, etc.) and home media servers (Plex, Jellyfin, Emby) into your personal Watch History and Continue Watching.</p>
      <div id="trackPlaybackSection"></div>
    </div>
  </div>

  <!-- Submenu 2: External Accounts & API Keys -->
  <div class="settings-subpanel" id="settingsSubExternal" style="display:none;">
    <div class="panel">
      <h2 class="panel-title">External Accounts &amp; API Keys</h2>
      <p style="margin:0 0 12px; color:var(--muted); font-size:var(--font-size-sm);">Connect your external service accounts and API keys. When signed in to your Profile, your connected accounts stay synchronized across devices and logouts.</p>

      <!-- TMDB Section -->
      <div class="provider-card" id="tmdbSection">
        <div class="provider-card-header">
          <div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <span class="provider-card-title">The Movie Database (TMDB)</span>
              <span id="tmdbConnectStatus" class="provider-status-badge"><span style="color:var(--muted);">Not connected</span></span>
            </div>
            <p class="provider-card-desc">Connect your TMDB account to import personal lists, watchlist, and favorites, or use a custom API key / Token.</p>
          </div>
        </div>
        <div class="provider-card-actions">
          <button type="button" class="secondary lc-btn" id="tmdbConnectBtn" data-act="startTmdbConnect" style="font-weight:600;">Connect TMDB Account</button>
          <button type="button" class="secondary lc-btn btn-danger" id="tmdbDisconnectBtn" style="display:none;" data-act="disconnectTmdb">Disconnect</button>
        </div>
        <details class="provider-advanced-disclosure">
          <summary class="provider-advanced-summary">
            <span>Advanced: Custom TMDB API Key / Token</span>
            <span class="provider-advanced-arrow">&#x25BE;</span>
          </summary>
          <div style="margin-top:10px;">
            <input type="text" id="tmdbKeyInput" placeholder="Optional: TMDB API Key (v3) or Read Access Token (v4)" value="${escapeHtmlServer(initialTmdbKey)}" data-act-on="input" data-act="appActProviderKeyTyped" data-act-args="[&quot;tmdb&quot;,&quot;@value&quot;]" style="width:100%; padding:9px 12px; border-radius:var(--radius-sm); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); box-sizing:border-box;">
            <p style="margin:6px 0 0; font-size:var(--font-size-xs); color:var(--muted);">Get a free TMDB API key at <a href="https://www.themoviedb.org/settings/api" target="_blank" style="color:var(--accent-2);">themoviedb.org/settings/api</a>.</p>
          </div>
        </details>
      </div>

      <!-- Trakt Section -->
      <div class="provider-card" id="traktSection">
        <div class="provider-card-header">
          <div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <span class="provider-card-title">Trakt</span>
              <span id="traktConnectStatus" class="provider-status-badge"><span style="color:var(--muted);">Not connected</span></span>
            </div>
            <p class="provider-card-desc">Connect your Trakt account to import personal lists, watchlist, and collection, or use a custom Client ID.</p>
          </div>
        </div>
        <div class="provider-card-actions trakt-connect-actions">
          <button type="button" class="secondary lc-btn" id="traktConnectBtn" data-act="startTraktConnect" style="font-weight:600;">Connect Trakt Account</button>
          <button type="button" class="secondary lc-btn" id="traktDeviceBtn" data-act="startTraktDeviceLogin" title="Connect from a TV or secondary device via trakt.tv/activate">Connect with PIN / Code</button>
          <button type="button" class="secondary lc-btn btn-danger" id="traktDisconnectBtn" style="display:none;" data-act="disconnectTrakt">Disconnect</button>
        </div>
        <div id="traktSyncHistoryWrap" style="margin:10px 0; padding:12px 14px; background:var(--surface-2, rgba(255,255,255,0.04)); border-radius:var(--radius-sm); border:1px solid var(--border);">
          <div class="settings-toggle-row" style="padding:0 0 10px;">
            <div style="flex:1; min-width:0; padding-right:12px;">
              <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Sync Watch History to Trakt</span>
              <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Automatically sync items marked as watched or played to your Trakt account history.</p>
            </div>
            <label class="ui-toggle" aria-label="Sync Watch History to Trakt">
              <input type="checkbox" id="syncTraktHistoryCheckbox" data-act="toggleProviderHistorySync" data-act-args="[&quot;trakt&quot;,&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
          <div style="margin-top:8px;">
            <button type="button" class="secondary lc-btn" id="syncTraktHistoryNowBtn" data-act="syncWatchHistoryToProviderNow" data-act-args="[&quot;trakt&quot;,&quot;@self&quot;]" style="padding:4px 10px; font-size:var(--font-size-sm);">Sync Current Watch History Now</button>
          </div>
        </div>
        <details class="provider-advanced-disclosure">
          <summary class="provider-advanced-summary">
            <span>Advanced: Custom Trakt Client ID &amp; Username</span>
            <span class="provider-advanced-arrow">&#x25BE;</span>
          </summary>
          <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
            <input type="text" id="traktKeyInput" placeholder="Optional: Trakt Client ID" value="${escapeHtmlServer(initialTraktKey)}" data-act-on="input" data-act="appActProviderKeyTyped" data-act-args="[&quot;trakt&quot;,&quot;@value&quot;]" style="width:100%; padding:9px 12px; border-radius:var(--radius-sm); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); box-sizing:border-box;">
            <input type="text" id="traktUsernameInput" placeholder="Optional: Trakt username" value="${escapeHtmlServer(initialTraktUsername)}" data-act-on="input" data-act="appActProviderKeyTyped" data-act-args="[&quot;trakt&quot;,&quot;@value&quot;]" style="width:100%; padding:9px 12px; border-radius:var(--radius-sm); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); box-sizing:border-box;">
            <p style="margin:2px 0 0; font-size:var(--font-size-xs); color:var(--muted);">Create a free Trakt Client ID at <a href="https://trakt.tv/oauth/applications" target="_blank" style="color:var(--accent-2);">trakt.tv/oauth/applications</a>.</p>
          </div>
        </details>
      </div>

      <!-- MDBList Section -->
      <div class="provider-card" id="mdblistSection">
        <div class="provider-card-header">
          <div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <span class="provider-card-title">MDBList</span>
              <span id="mdblistConnectStatus" class="provider-status-badge"><span style="color:var(--muted);">Not connected</span></span>
            </div>
            <p class="provider-card-desc">Connect your MDBList account to import personal lists, watchlist, and watch history, or use a custom API key.</p>
          </div>
        </div>
        <div class="provider-card-actions">
          <button type="button" class="secondary lc-btn" id="mdblistConnectBtn" data-act="startMdblistConnect" style="font-weight:600;">Connect MDBList Account</button>
          <button type="button" class="secondary lc-btn btn-danger" id="mdblistDisconnectBtn" style="display:none;" data-act="disconnectMdblist">Disconnect</button>
        </div>
        <div id="mdblistSyncHistoryWrap" style="margin:10px 0; padding:12px 14px; background:var(--surface-2, rgba(255,255,255,0.04)); border-radius:var(--radius-sm); border:1px solid var(--border);">
          <div class="settings-toggle-row" style="padding:0 0 10px;">
            <div style="flex:1; min-width:0; padding-right:12px;">
              <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Sync Watch History to MDBList</span>
              <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Automatically sync items marked as watched or played to your MDBList account history.</p>
            </div>
            <label class="ui-toggle" aria-label="Sync Watch History to MDBList">
              <input type="checkbox" id="syncMdblistHistoryCheckbox" data-act="toggleProviderHistorySync" data-act-args="[&quot;mdblist&quot;,&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
          <div style="margin-top:8px;">
            <button type="button" class="secondary lc-btn" id="syncMdblistHistoryNowBtn" data-act="syncWatchHistoryToProviderNow" data-act-args="[&quot;mdblist&quot;,&quot;@self&quot;]" style="padding:4px 10px; font-size:var(--font-size-sm);">Sync Current Watch History Now</button>
          </div>
        </div>
        <details class="provider-advanced-disclosure">
          <summary class="provider-advanced-summary">
            <span>Advanced: Custom MDBList API Key</span>
            <span class="provider-advanced-arrow">&#x25BE;</span>
          </summary>
          <div style="margin-top:10px;">
            <input type="text" id="mdblistKeyInput" placeholder="Optional: MDBList API key" value="${escapeHtmlServer(initialMdblistKey)}" data-act-on="input" data-act="appActProviderKeyTyped" data-act-args="[&quot;mdblist&quot;,&quot;@value&quot;]" style="width:100%; padding:9px 12px; border-radius:var(--radius-sm); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); box-sizing:border-box;">
            <p style="margin:6px 0 0; font-size:var(--font-size-xs); color:var(--muted);">Get a free MDBList key at <a href="https://mdblist.com/preferences" target="_blank" style="color:var(--accent-2);">mdblist.com/preferences</a>.</p>
          </div>
        </details>
      </div>

      <!-- Simkl Section -->
      <div class="provider-card" id="simklSection">
        <div class="provider-card-header">
          <div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <span class="provider-card-title">Simkl</span>
              <span id="simklConnectStatus" class="provider-status-badge"><span style="color:var(--muted);">Not connected</span></span>
            </div>
            <p class="provider-card-desc">Connect your Simkl account to import personal lists, watchlist, and history, or use a custom Client ID.</p>
          </div>
        </div>
        <div class="provider-card-actions">
          <button type="button" class="secondary lc-btn" id="simklConnectBtn" data-act="startSimklConnect" style="font-weight:600;">Connect Simkl Account</button>
          <button type="button" class="secondary lc-btn btn-danger" id="simklDisconnectBtn" style="display:none;" data-act="disconnectSimkl">Disconnect</button>
        </div>
        <div id="simklSyncHistoryWrap" style="margin:10px 0; padding:12px 14px; background:var(--surface-2, rgba(255,255,255,0.04)); border-radius:var(--radius-sm); border:1px solid var(--border);">
          <div class="settings-toggle-row" style="padding:0 0 10px;">
            <div style="flex:1; min-width:0; padding-right:12px;">
              <span style="font-weight:600; font-size:var(--font-size-sm); color:var(--text);">Sync Watch History to Simkl</span>
              <p style="margin:2px 0 0; color:var(--muted); font-size:var(--font-size-xs);">Automatically sync items marked as watched or played to your Simkl account history.</p>
            </div>
            <label class="ui-toggle" aria-label="Sync Watch History to Simkl">
              <input type="checkbox" id="syncSimklHistoryCheckbox" data-act="toggleProviderHistorySync" data-act-args="[&quot;simkl&quot;,&quot;@checked&quot;]">
              <span class="ui-toggle-slider"></span>
            </label>
          </div>
          <div style="margin-top:8px;">
            <button type="button" class="secondary lc-btn" id="syncSimklHistoryNowBtn" data-act="syncWatchHistoryToProviderNow" data-act-args="[&quot;simkl&quot;,&quot;@self&quot;]" style="padding:4px 10px; font-size:var(--font-size-sm);">Sync Current Watch History Now</button>
          </div>
        </div>
        <details class="provider-advanced-disclosure">
          <summary class="provider-advanced-summary">
            <span>Advanced: Custom Simkl Client ID</span>
            <span class="provider-advanced-arrow">&#x25BE;</span>
          </summary>
          <div style="margin-top:10px;">
            <input type="text" id="simklKeyInput" placeholder="Optional: Simkl Client ID" value="${escapeHtmlServer(initialSimklKey)}" data-act-on="input" data-act="appActProviderKeyTyped" data-act-args="[&quot;simkl&quot;,&quot;@value&quot;]" style="width:100%; padding:9px 12px; border-radius:var(--radius-sm); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); box-sizing:border-box;">
            <p style="margin:6px 0 0; font-size:var(--font-size-xs); color:var(--muted);">Create a free Simkl Client ID at <a href="https://simkl.com/settings/developer/" target="_blank" style="color:var(--accent-2);">simkl.com/settings/developer/</a>.</p>
          </div>
        </details>
      </div>
    </div>

    <!-- Unified Import List Panel -->
    <div class="panel" style="margin-top:14px;">
      <h2 class="panel-title">Import List</h2>
      <p style="margin:0 0 14px; color:var(--muted); font-size:var(--font-size-sm);">Import files to automatically populate or create custom lists in your account. Supports CSV and JSON exports from IMDb, Letterboxd, MovieLens, Trakt, Simkl, and TMDB.</p>

      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:12px; margin-bottom:12px;">
        <div>
          <label for="importListSourceSelect" style="display:block; font-weight:600; font-size:var(--font-size-sm); margin-bottom:6px; color:var(--text);">Source (optional)</label>
          <select id="importListSourceSelect" style="width:100%; max-width:320px; padding:7px 12px; border-radius:var(--radius-pill); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:var(--font-size-sm); box-sizing:border-box;">
            <option value="auto">Auto-detect</option>
            <option value="imdb">IMDb</option>
            <option value="letterboxd">Letterboxd</option>
            <option value="movielens">MovieLens</option>
            <option value="trakt">Trakt</option>
            <option value="simkl">Simkl</option>
            <option value="tmdb">TMDB</option>
          </select>
        </div>

        <div>
          <label for="importTargetListSelect" style="display:block; font-weight:600; font-size:var(--font-size-sm); margin-bottom:6px; color:var(--text);">Import to which list?</label>
          <select id="importTargetListSelect" style="width:100%; max-width:320px; padding:7px 12px; border-radius:var(--radius-pill); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:var(--font-size-sm); box-sizing:border-box;" data-act="onImportTargetListChange">
            <!-- Populated dynamically -->
          </select>
        </div>
      </div>

      <div id="importNewListInputWrap" style="display:none; margin-bottom:12px;">
        <label for="importNewListNameInput" style="display:block; font-weight:600; font-size:var(--font-size-sm); margin-bottom:6px; color:var(--text);">New List Name</label>
        <input type="text" id="importNewListNameInput" placeholder="e.g. My Favorite Movies" style="width:100%; max-width:400px; padding:9px 12px; border-radius:var(--radius-sm); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:var(--font-size-base); box-sizing:border-box;">
      </div>

      <div style="margin-bottom:14px;">
        <div class="import-dropzone" id="importDropzone" data-act="appActOpenFilePicker" data-act-args="[&quot;unifiedImportFileInput&quot;]">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="color:var(--muted); opacity:0.8; margin-bottom:2px;" aria-hidden="true">
            <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path>
            <path d="M12 12v9"></path>
            <path d="m16 16-4-4-4 4"></path>
          </svg>
          <div style="text-align:center;">
            <div style="font-weight:600; font-size:var(--font-size-base); color:var(--text);">Choose files or drag &amp; drop here</div>
            <div style="margin-top:3px; color:var(--muted); font-size:var(--font-size-xs);">CSV, JSON, ZIP, or TXT exports (multi-file supported)</div>
          </div>
          <button type="button" class="secondary lc-btn" data-act="appActOpenFilePicker" data-act-args="[&quot;unifiedImportFileInput&quot;]" style="padding:6px 16px; font-size:var(--font-size-sm); margin-top:2px;">Select files&hellip;</button>
          <input type="file" id="unifiedImportFileInput" aria-label="Choose a file to import" multiple accept=".csv,.json,.zip,.txt" style="display:none;" data-act="onUnifiedImportFilesSelected" data-act-args="[&quot;@self&quot;]">
        </div>
        <div id="unifiedImportSelectedCount" style="margin-top:6px; font-size:var(--font-size-sm); color:var(--muted);">No files selected</div>
      </div>

      <div style="margin-bottom:14px;">
        <label class="settings-check-item" style="padding:10px 12px; margin:0;">
          <input type="checkbox" id="importAlsoMarkWatchedCheck">
          <div class="settings-check-label">
            <strong style="font-size:var(--font-size-sm); color:var(--text);">Also add watched items to Watch History</strong>
            <span class="settings-check-desc">Automatically marks imported watched items in your Watch History</span>
          </div>
        </label>
      </div>

      <div class="actions" style="margin-top:8px;">
        <button type="button" class="primary lc-btn" id="btnUnifiedImport" style="padding:10px 24px; font-size:var(--font-size-base); font-weight:600;" data-act="runUnifiedListImport">Start Import</button>
      </div>

      <div id="unifiedImportResult" style="margin-top:12px;"></div>
    </div>
  </div>

  <!-- Submenu 3: Feedback & Support -->
  <div class="settings-subpanel" id="settingsSubFeedback" style="display:none;">
    <div class="panel">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        <div>
          <h2 class="panel-title" style="margin:0;">Support &amp; Developer Chat</h2>
          <p style="margin:4px 0 0; color:var(--muted); font-size:var(--font-size-sm);">Have a question, found a bug, or have a suggestion? Chat directly with the developer.</p>
        </div>
        <button type="button" class="secondary lc-btn" id="btnNewFeedbackTicket" data-act="toggleNewFeedbackForm" data-act-args="[true]" style="padding:6px 14px; font-size:var(--font-size-sm);">+ New Message</button>
      </div>

      <!-- Active Threads Selector -->
      <div id="supportThreadsBar" class="support-threads-bar" style="display:none; margin-bottom:12px;"></div>

      <div class="feedback-container">
        <!-- Chat View -->
        <div id="supportChatView" style="display:none;">
          <div id="supportMessagesStream" class="support-messages-stream"></div>
          <div class="support-reply-composer" style="margin-top:10px;">
            <textarea id="supportReplyInput" placeholder="Type a reply to the developer..." data-act-on="keydown" data-act="appActFeedbackReplyOnEnter" data-act-args="[&quot;@event&quot;]"></textarea>
            <button type="button" class="primary lc-btn" id="supportReplySendBtn" data-act="sendUserFeedbackReply" style="min-height:44px; padding:0 20px;">Send</button>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
            <span id="supportChatStatus" style="font-size:var(--font-size-sm); color:var(--muted);"></span>
            <button type="button" class="secondary lc-btn" data-act="refreshUserFeedbackThreads" style="padding:2px 8px; font-size:var(--font-size-xs); border:none; background:none; color:var(--muted); cursor:pointer;">&#x21BB; Refresh</button>
          </div>
        </div>

        <!-- New Message / Initial Form -->
        <div id="newFeedbackFormWrap">
          <div class="row">
            <label style="display:block; font-size:var(--font-size-sm); font-weight:600; color:var(--text); margin-bottom:4px;">Category</label>
            <select id="feedbackCategorySelect" aria-label="Feedback category" style="max-width:320px; border-radius:var(--radius-pill); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); padding:7px 12px; font-size:var(--font-size-sm);">
              <option value="bug">Bug Report</option>
              <option value="improvement">Improvement / Feature Request</option>
              <option value="idea">Idea / Suggestion</option>
              <option value="other">General Question / Other</option>
            </select>
          </div>
          <div class="row" style="margin-top:10px;">
            <label style="display:block; font-size:var(--font-size-sm); font-weight:600; color:var(--text); margin-bottom:4px;">Message</label>
            <textarea id="feedbackMessageInput" rows="4" style="width:100%; max-width:680px; border-radius:var(--radius-sm); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); padding:10px 12px; font-size:var(--font-size-sm); box-sizing:border-box;" placeholder="What would you like help with or what did you find?"></textarea>
          </div>
          <div class="row" style="margin-top:10px;">
            <label style="display:block; font-size:var(--font-size-sm); font-weight:600; color:var(--text); margin-bottom:4px;">Contact Info (optional)</label>
            <input type="text" id="feedbackContactInput" placeholder="Email, Discord username, etc. (optional)" style="width:100%; max-width:440px; border-radius:var(--radius-sm); border:1.5px solid var(--border-strong); background:var(--surface); color:var(--text); padding:8px 12px; font-size:var(--font-size-sm); box-sizing:border-box;">
          </div>
          <div class="actions" style="margin-top:12px; gap:8px; justify-content:flex-start;">
            <button type="button" class="primary lc-btn" id="feedbackSubmitBtn" data-act="submitFeedback" style="padding:8px 20px; font-size:var(--font-size-sm); font-weight:600;">Send Message</button>
            <button type="button" class="secondary lc-btn" id="feedbackCancelNewBtn" style="display:none;" data-act="toggleNewFeedbackForm" data-act-args="[false]">Cancel</button>
          </div>
          <p id="feedbackStatus" style="margin-top:8px; font-size:var(--font-size-sm);"></p>
        </div>
      </div>
    </div>

    <!-- Resources & Documentation Section -->
    <div class="panel" style="margin-top:14px;">
      <h2 class="panel-title">Resources &amp; Support</h2>
      <p style="margin:0 0 14px; color:var(--muted); font-size:var(--font-size-sm);">Helpful guides, documentation, and ways to support continued hosting and development of My Lists Addon.</p>
      
      <div class="resource-cards-grid">
        <a href="/guide" class="resource-card">
          <div>
            <div class="resource-card-title">User Guide &amp; Docs</div>
            <div class="resource-card-desc">Step-by-step how-to guides covering catalogs, channels, storylines, and list importing.</div>
          </div>
          <span class="secondary lc-btn" style="align-self:flex-start; padding:6px 14px; font-size:var(--font-size-sm); pointer-events:none;">Open Guide &rarr;</span>
        </a>

        <a href="https://ko-fi.com/mylistsaddon" target="_blank" rel="noopener" class="resource-card">
          <div>
            <div class="resource-card-title">Support on Ko-fi</div>
            <div class="resource-card-desc">Support the continued development and hosting costs of the free public server.</div>
          </div>
          <span class="secondary lc-btn" style="align-self:flex-start; padding:6px 14px; font-size:var(--font-size-sm); pointer-events:none;">Support Project &rarr;</span>
        </a>

        <a href="https://torbox.app/subscription?referral=af23795c-7706-4b02-a979-d84b5613cfd1" target="_blank" rel="noopener" class="resource-card">
          <div>
            <div class="resource-card-title">TorBox Debrid</div>
            <div class="resource-card-desc">Fast, modern debrid provider with fast torrent caching and Usenet support.</div>
          </div>
          <span class="secondary lc-btn" style="align-self:flex-start; padding:6px 14px; font-size:var(--font-size-sm); pointer-events:none;">Try TorBox (Referral) &rarr;</span>
        </a>
      </div>
    </div>
  </div>
</div>
</div>


