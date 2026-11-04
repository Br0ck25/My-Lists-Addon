// --- Nuvio TV Launcher Pairing & Onboarding Controller -----------------------

async function claimNuvioTvDeviceCode(userCode) {
  if (!userCode) return { ok: false, error: 'Missing user code.' };
  try {
    const creatorName = (typeof activeCreator !== 'undefined' && activeCreator && activeCreator.creatorName)
      ? activeCreator.creatorName
      : (localStorage.getItem('myListAddon:creatorName') || '');
    const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
    const bodyPayload = { userCode: userCode, creatorName: creatorName };
    if (creatorKey) bodyPayload.creatorKey = creatorKey;

    let res;
    if (typeof creatorApiFetch === 'function') {
      res = await creatorApiFetch(ORIGIN + '/api/nuvio-tv/device/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(bodyPayload),
      });
    } else {
      res = await fetch(ORIGIN + '/api/nuvio-tv/device/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(bodyPayload),
      });
    }

    const data = await res.json();
    if (data && data.ok) {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem('mylists_tv_code');
      }
      try {
        if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      } catch (e) {}
      if (typeof showToast === 'function') {
        showToast('Linked to Nuvio TV Launcher!', 'success');
      }
      return { ok: true, data: data };
    }
    return { ok: false, error: (data && data.error) ? data.error : 'Failed to link TV.' };
  } catch (err) {
    console.error('Nuvio TV device claim failed:', err);
    return { ok: false, error: 'Network error connecting to server.' };
  }
}

function openNuvioTvPairingModal(tvCode) {
  if (!tvCode) return;
  const username = (typeof activeCreator !== 'undefined' && activeCreator && (activeCreator.displayName || activeCreator.creatorName))
    || localStorage.getItem('myListAddon:creatorDisplayName')
    || localStorage.getItem('myListAddon:creatorName')
    || 'Account';

  showModal(
    '<button type="button" class="modal-close-x" aria-label="Close" data-act="closeModal">\u2715</button>' +
    '<h2>Link Nuvio TV Launcher</h2>' +
    '<div class="u-mt-12px u-mb-12px u-p-14px" style="background:var(--color-bg-subtle);border:1px solid var(--color-border);border-radius:var(--radius-md);text-align:center;">' +
      '<div style="font-size:var(--font-size-xs);color:var(--color-text-muted);text-transform:uppercase;font-weight:600;letter-spacing:0.05em;">Pairing Code</div>' +
      '<div style="font-size:24px;font-weight:800;letter-spacing:0.12em;color:var(--color-brand);margin:4px 0;">' + escapeHtml(tvCode) + '</div>' +
      '<div style="font-size:var(--font-size-sm);color:var(--color-text-muted);margin-top:4px;">Signed in as <strong>' + escapeHtml(username) + '</strong></div>' +
    '</div>' +
    '<p class="modal-sub">Link this TV to sync your Catalogs, Collections, and Live TV Channels with Nuvio TV Launcher.</p>' +
    '<div id="nuvioTvPairingError"></div>' +
    '<div class="actions u-mt-14px">' +
      '<button type="button" class="primary" id="nuvioTvLinkBtn" data-act="submitNuvioTvLink">Link TV</button>' +
      '<button type="button" class="secondary" data-act="closeModal">Cancel</button>' +
    '</div>'
  );
}

async function submitNuvioTvLink() {
  const btn = document.getElementById('nuvioTvLinkBtn');
  const errBox = document.getElementById('nuvioTvPairingError');
  if (errBox) errBox.innerHTML = '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Linking TV\u2026';
  }

  const tvCode = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('mylists_tv_code') : null;
  if (!tvCode) {
    if (errBox) errBox.innerHTML = '<p class="testresult err">No pairing code found.</p>';
    if (btn) { btn.disabled = false; btn.textContent = 'Link TV'; }
    return;
  }

  const result = await claimNuvioTvDeviceCode(tvCode);
  if (result && result.ok) {
    showNuvioTvPairingSuccessModal(tvCode);
    handleNuvioTvPostAuth();
  } else {
    if (errBox) {
      errBox.innerHTML = '<p class="testresult err">' + escapeHtml((result && result.error) || 'Failed to link TV. Please verify the code on your TV.') + '</p>';
    }
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Link TV';
    }
  }
}

function showNuvioTvPairingSuccessModal(tvCode) {
  showModal(
    '<button type="button" class="modal-close-x" aria-label="Close" data-act="closeModal">\u2715</button>' +
    '<h2 style="color:var(--color-success);">&#x2713; TV Linked Successfully!</h2>' +
    '<div class="u-mt-12px u-mb-12px u-p-14px" style="background:var(--color-bg-subtle);border:1px solid var(--color-border);border-radius:var(--radius-md);text-align:center;">' +
      '<div style="font-size:var(--font-size-sm);color:var(--color-text);">Pairing Code <strong>' + escapeHtml(tvCode) + '</strong> is now active.</div>' +
      '<div style="font-size:var(--font-size-xs);color:var(--color-text-muted);margin-top:6px;">Your Catalogs, Collections, and Channels have synced to your TV screen.</div>' +
    '</div>' +
    '<p class="modal-sub">You can now return to your TV screen to start browsing.</p>' +
    '<div class="actions u-mt-14px">' +
      '<button type="button" class="primary" data-act="closeModal">Done</button>' +
    '</div>'
  );
}

function openNuvioTvAuthModal(tvCode) {
  showModal(
    '<button type="button" class="modal-close-x" aria-label="Close" data-act="closeModal">\u2715</button>' +
    '<h2>Link Nuvio TV Launcher</h2>' +
    '<div class="u-mt-12px u-mb-12px u-p-14px" style="background:var(--color-bg-subtle);border:1px solid var(--color-border);border-radius:var(--radius-md);text-align:center;">' +
      '<div style="font-size:var(--font-size-xs);color:var(--color-text-muted);text-transform:uppercase;font-weight:600;letter-spacing:0.05em;">Pairing Code</div>' +
      '<div style="font-size:22px;font-weight:800;letter-spacing:0.12em;color:var(--color-brand);margin:4px 0;">' + escapeHtml(tvCode) + '</div>' +
      '<div style="font-size:var(--font-size-xs);color:var(--color-text-muted);margin-top:2px;">Create an account or login below to finish linking your TV.</div>' +
    '</div>' +
    '<div class="row"><input type="text" id="createProfileNameInput" placeholder="Choose a Username" maxlength="25"></div>' +
    '<div class="row u-mt-8px"><input type="text" id="createProfileDisplayInput" placeholder="Display name (optional)" maxlength="40"></div>' +
    '<div class="row u-mt-8px"><input type="text" id="createProfileRecoveryInput" placeholder="Recovery Answer (optional, 8+ characters)" minlength="8"></div>' +
    '<p class="modal-sub u-fs-v_font_size_xs u-mt-4px">If you ever lose your key, this is the only way back in besides contacting us. 8+ characters.</p>' +
    '<div id="createProfileError"></div>' +
    '<div class="actions u-mt-14px">' +
      '<button type="button" class="primary" id="createProfileSubmitBtn" data-act="submitCreateProfile">Create Account &amp; Link TV</button>' +
      '<button type="button" class="secondary" data-act="closeModal" data-act-then="openRestoreModal">Already have one? Login</button>' +
    '</div>'
  );
}

async function handleNuvioTvPostAuth() {
  try {
    const isNuvioTv = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('mylists_source') === 'nuvio_tv');
    if (!isNuvioTv) return;

    // 1. Ensure 24h shuffle checkbox is enabled on the client
    const shuffleEl = document.getElementById('shuffleItemsCheckbox');
    if (shuffleEl && !shuffleEl.checked) {
      shuffleEl.checked = true;
      try {
        if (typeof saveState === 'function') saveState();
      } catch (err) {}
    }

    // 2. Claim TV device code if one was provided in URL/sessionStorage
    const tvCode = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('mylists_tv_code') : null;
    if (tvCode) {
      const claimRes = await claimNuvioTvDeviceCode(tvCode);
      if (claimRes && claimRes.ok) {
        showNuvioTvPairingSuccessModal(tvCode);
      }
    }

    // 3. Direct user to sign in with their Nuvio account if not already connected
    const isNuvioConnected = (typeof mediaAppListsLive !== 'undefined' && mediaAppListsLive.nuvio);
    if (!isNuvioConnected) {
      if (typeof goToExternalSettings === 'function') {
        goToExternalSettings();
      } else if (typeof switchTab === 'function') {
        switchTab('settings');
        if (typeof switchSettingsSubmenu === 'function') {
          const externalPill = document.querySelector('#settingsSubnavBar button[data-sub="external"]');
          switchSettingsSubmenu('external', externalPill);
        }
      }

      setTimeout(function() {
        const banner = document.getElementById('nuvioTvOnboardingBanner');
        if (banner) banner.style.display = 'block';
        const section = document.getElementById('nuvioSection');
        if (section) {
          if (typeof section.scrollIntoView === 'function') {
            section.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          section.style.borderColor = 'var(--color-brand)';
          section.style.boxShadow = '0 0 0 2px var(--color-brand)';
          setTimeout(function() {
            section.style.borderColor = '';
            section.style.boxShadow = '';
          }, 3500);
        }
      }, 250);
    }
  } catch (e) {
    console.error('handleNuvioTvPostAuth error:', e);
  }
}

function initNuvioTvOnboarding() {
  try {
    if (typeof window === 'undefined' || !window.location) return;
    const urlParams = new URLSearchParams(window.location.search);
    const sourceParam = urlParams.get('source');
    const tvCodeParam = urlParams.get('tv_code') || urlParams.get('code');

    if (sourceParam === 'nuvio_tv') {
      sessionStorage.setItem('mylists_source', 'nuvio_tv');
    }
    if (tvCodeParam) {
      sessionStorage.setItem('mylists_tv_code', tvCodeParam.trim().toUpperCase());
    }

    const isNuvioTv = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('mylists_source') === 'nuvio_tv');
    if (!isNuvioTv) return;

    const tvCode = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('mylists_tv_code') : null;
    const signedIn = (typeof activeCreator !== 'undefined' && activeCreator && activeCreator.creatorName) ||
      Boolean(localStorage.getItem('myListAddon:creatorName'));

    if (!signedIn) {
      setTimeout(function() {
        if (tvCode) {
          openNuvioTvAuthModal(tvCode);
        } else if (typeof openCreateProfileModal === 'function') {
          openCreateProfileModal();
        }
      }, 150);
    } else {
      setTimeout(function() {
        if (tvCode) {
          openNuvioTvPairingModal(tvCode);
        } else {
          handleNuvioTvPostAuth();
        }
      }, 150);
    }
  } catch (e) {
    console.error('initNuvioTvOnboarding error:', e);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(initNuvioTvOnboarding, 50);
    });
  } else {
    setTimeout(initNuvioTvOnboarding, 50);
  }
}

window.claimNuvioTvDeviceCode = claimNuvioTvDeviceCode;
window.handleNuvioTvPostAuth = handleNuvioTvPostAuth;
window.initNuvioTvOnboarding = initNuvioTvOnboarding;
window.openNuvioTvPairingModal = openNuvioTvPairingModal;
window.openNuvioTvAuthModal = openNuvioTvAuthModal;
window.submitNuvioTvLink = submitNuvioTvLink;
window.showNuvioTvPairingSuccessModal = showNuvioTvPairingSuccessModal;
