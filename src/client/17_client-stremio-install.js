// Stremio card: Add to Stremio (server: 61_stremio-install.js).

function mediaAppInstallRow(provider, info) {
  const row = document.getElementById(provider + 'InstallRow');
  if (row) row.style.display = info && info.pushAvailable ? '' : 'none';
}

async function installAddonInStremio(btn) {
  const link = getNuvioManifestUrl();
  if (new URL(link, ORIGIN).pathname === '/manifest.json') {
    showToast('Make an install link first, then try again.', 'error');
    return;
  }
  if (btn) btn.disabled = true;
  const r = await mediaAppUiCall('stremio', 'install-addon', 'POST', { manifestUrl: link });
  if (btn) btn.disabled = false;
  if (!r.ok) showToast(mediaAppUiMessage(r, 'Could not add the addon to Stremio. Please try again.'), 'error');
  else if (r.data.alreadyInstalled) showToast('Your My Lists addon is already in Stremio.', 'info');
  else showToast('Added your My Lists addon to Stremio.', 'success');
}
