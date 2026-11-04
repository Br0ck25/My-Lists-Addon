// --- Nuvio TV Launcher Pairing & Onboarding Controller -----------------------

async function claimNuvioTvDeviceCode(userCode) {
  if (!userCode) return false;
  try {
    const creatorName = (typeof activeCreator !== 'undefined' && activeCreator && activeCreator.creatorName)
      ? activeCreator.creatorName
      : (localStorage.getItem('myListAddon:creatorName') || '');
    const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
    const res = await fetch(ORIGIN + '/api/nuvio-tv/device/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userCode: userCode, creatorName: creatorName, creatorKey: creatorKey }),
    });
    const data = await res.json();
    if (data && data.ok) {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem('mylists_tv_code');
      }
      if (typeof showToast === 'function') {
        showToast('Linked to Nuvio TV Launcher!', 'success');
      }
      return true;
    }
  } catch (err) {
    console.error('Nuvio TV device claim failed:', err);
  }
  return false;
}

async function handleNuvioTvPostAuth() {
  try {
    const isNuvioTv = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('mylists_source') === 'nuvio_tv');
    if (!isNuvioTv) return;

    // 1. Ensure 24h shuffle checkbox is enabled on the client
    const shuffleEl = document.getElementById('shuffleItemsCheckbox');
    if (shuffleEl && !shuffleEl.checked) {
      shuffleEl.checked = true;
      if (typeof saveState === 'function') saveState();
    }

    // 2. Claim TV device code if one was provided in URL/sessionStorage
    const tvCode = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('mylists_tv_code') : null;
    if (tvCode) {
      await claimNuvioTvDeviceCode(tvCode);
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

    const signedIn = (typeof activeCreator !== 'undefined' && activeCreator && activeCreator.creatorName) ||
      Boolean(localStorage.getItem('myListAddon:creatorName'));

    if (!signedIn) {
      setTimeout(function() {
        if (typeof openCreateProfileModal === 'function') {
          openCreateProfileModal();
        }
      }, 150);
    } else {
      handleNuvioTvPostAuth();
    }
  } catch (e) {
    console.error('initNuvioTvOnboarding error:', e);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNuvioTvOnboarding);
  } else {
    initNuvioTvOnboarding();
  }
}

window.claimNuvioTvDeviceCode = claimNuvioTvDeviceCode;
window.handleNuvioTvPostAuth = handleNuvioTvPostAuth;
window.initNuvioTvOnboarding = initNuvioTvOnboarding;
