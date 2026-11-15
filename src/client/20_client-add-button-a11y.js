// Names for the "+ Add" / "Remove" buttons on list cards (audit UI-05). The
// visible text is the same on every card, so a screen reader heard "+ Add,
// button" with no list name. The name is in data-name; the add/remove state is
// the "is-added" class the click handler already flips, so the label is read
// from those instead of being kept in step at each of the places that build the
// button.
const CHART_CARD_BUTTON_SELECTOR = '.discover-chart-btns button, a.discover-chart-seeall';
// Every other "+ Add" / "Remove" list button, the per-item remove crosses, the
// "Retry" buttons and the /catalogs shelf "See All": the repeated text is the
// same everywhere, so the name comes from the card or shelf the button sits in.
const LIST_ADD_SELECTOR = 'button.list-add-btn, button[data-act="removeDirectoryChannel"]';
const ITEM_REMOVE_SELECTOR = 'button.cw-remove-btn, button[data-act="removeSingleExternalItemDirect"], button[data-act="removeSingleCustomItemDirect"]';
const RETRY_SELECTOR = 'button[data-act="retryPosterSlot"], button[data-act="renderLivePreview"]';
const SHELF_SEEALL_SELECTOR = '.live-preview-shelf-title button.text-action-btn';
const ADD_BUTTON_SELECTOR = 'button.searchAddBtn[data-name], ' + CHART_CARD_BUTTON_SELECTOR + ', ' +
  [LIST_ADD_SELECTOR, ITEM_REMOVE_SELECTOR, RETRY_SELECTOR, SHELF_SEEALL_SELECTOR].join(', ');

function a11yText(el) {
  return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '';
}

// Text of titleSel inside the nearest ancestor matching cardSel.
function a11yCardText(btn, cardSel, titleSel) {
  const card = btn.closest && btn.closest(cardSel);
  return card ? a11yText(card.querySelector(titleSel)) : '';
}

// The list this button belongs to: its own data-name / data-title, else the
// title of the card around it (creator, channel and media-app cards carry only
// a slug or an id on the button).
function a11yListName(btn) {
  return btn.getAttribute('data-name') || btn.getAttribute('data-title') ||
    a11yCardText(btn, '.list-card', '.list-card-title');
}

// Quick Add chart cards: "+ Movies", "+ Shows" and "See All" repeat on every
// card; the card's own title says which list they belong to.
function chartCardButtonLabel(btn) {
  const card = btn.closest && btn.closest('.discover-chart-card');
  const titleEl = card && card.querySelector('.discover-chart-title');
  // The first data-act-args value is the list the button really adds. Two
  // cards can show the same title ("Netflix" under Streaming Top 10 and under
  // Streaming) while adding different lists ("Netflix Top 10"), so it wins.
  let title = titleEl && (titleEl.textContent || '').trim();
  try {
    const args = JSON.parse(btn.getAttribute('data-act-args') || '[]');
    if (args && typeof args[0] === 'string' && args[0].trim()) title = args[0].trim();
  } catch (e) { /* keep the card title */ }
  if (!title) return '';
  const text = (btn.textContent || '').replace(/\\s+/g, ' ').trim();
  if (/^\\+\\s*Movies$/i.test(text)) return 'Add ' + title + ' movies';
  if (/^\\+\\s*Shows$/i.test(text)) return 'Add ' + title + ' shows';
  if (/^See All/i.test(text)) return 'See all of ' + title;
  return '';
}

// Label for the buttons that are not list add buttons; '' when none applies.
function a11yOtherLabel(btn) {
  if (btn.matches(RETRY_SELECTOR)) {
    if (btn.matches('[data-act="renderLivePreview"]')) {
      const shelf = a11yCardText(btn, '.live-preview-shelf', '.shelf-title-text');
      return 'Retry loading ' + (shelf || 'this catalog');
    }
    const slot = btn.closest('[data-name]');
    const name = (slot && slot.getAttribute('data-name')) || a11yCardText(btn, '.list-card', '.list-card-title');
    return 'Retry loading previews' + (name ? ' for ' + name : '');
  }
  if (btn.matches('button.text-action-btn') && btn.closest('.live-preview-shelf-title')) {
    const t = a11yCardText(btn, '.live-preview-shelf-title', '.shelf-title-text');
    return t ? 'See all of ' + t : '';
  }
  if (btn.matches(ITEM_REMOVE_SELECTOR)) {
    const row = btn.closest('.select-list-row');
    if (row) return 'Remove from ' + a11yText(row.querySelector('label span'));
    if (!btn.getAttribute('data-a11y-base')) {
      btn.setAttribute('data-a11y-base', btn.getAttribute('aria-label') || btn.getAttribute('title') || 'Remove');
    }
    const card = btn.closest('.live-preview-poster-card');
    const item = card && (a11yText(card.querySelector('.live-preview-poster-name')) || card.getAttribute('data-title'));
    return item ? btn.getAttribute('data-a11y-base') + ': ' + item : '';
  }
  return '';
}

function syncAddButtonA11y(btn) {
  if (btn.matches && btn.matches(CHART_CARD_BUTTON_SELECTOR)) {
    const label = chartCardButtonLabel(btn);
    if (label) btn.setAttribute('aria-label', label);
    return;
  }
  if (btn.matches && !btn.getAttribute('data-name') && !btn.matches(LIST_ADD_SELECTOR)) {
    const other = a11yOtherLabel(btn);
    if (other) btn.setAttribute('aria-label', other);
    return;
  }
  const name = a11yListName(btn);
  if (!name) return;
  const added = btn.classList.contains('is-added') || /^Remove/i.test(a11yText(btn));
  btn.setAttribute('aria-label', (added ? 'Remove ' : 'Add ') + name + (added ? ' from my lists' : ' to my lists'));
}

(function watchAddButtons() {
  if (typeof MutationObserver !== 'function') return;
  function start() {
    document.querySelectorAll(ADD_BUTTON_SELECTOR).forEach(syncAddButtonA11y);
    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.type === 'attributes') {
          if (m.target.matches && m.target.matches(ADD_BUTTON_SELECTOR)) syncAddButtonA11y(m.target);
          return;
        }
        m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.matches(ADD_BUTTON_SELECTOR)) syncAddButtonA11y(n);
          n.querySelectorAll(ADD_BUTTON_SELECTOR).forEach(syncAddButtonA11y);
        });
      });
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
