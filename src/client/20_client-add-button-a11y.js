// Names for the "+ Add" / "Remove" buttons on list cards (audit UI-05). The
// visible text is the same on every card, so a screen reader heard "+ Add,
// button" with no list name. The name is in data-name; the add/remove state is
// the "is-added" class the click handler already flips, so the label is read
// from those instead of being kept in step at each of the places that build the
// button.
const CHART_CARD_BUTTON_SELECTOR = '.discover-chart-btns button, a.discover-chart-seeall';
const ADD_BUTTON_SELECTOR = 'button.searchAddBtn[data-name], ' + CHART_CARD_BUTTON_SELECTOR;

// Quick Add chart cards: "+ Movies", "+ Shows" and "See All" repeat on every
// card; the card's own title says which list they belong to.
function chartCardButtonLabel(btn) {
  const card = btn.closest && btn.closest('.discover-chart-card');
  const titleEl = card && card.querySelector('.discover-chart-title');
  const title = titleEl && (titleEl.textContent || '').trim();
  if (!title) return '';
  const text = (btn.textContent || '').replace(/\\s+/g, ' ').trim();
  if (/^\\+\\s*Movies$/i.test(text)) return 'Add ' + title + ' movies';
  if (/^\\+\\s*Shows$/i.test(text)) return 'Add ' + title + ' shows';
  if (/^See All/i.test(text)) return 'See all of ' + title;
  return '';
}

function syncAddButtonA11y(btn) {
  if (btn.matches && btn.matches(CHART_CARD_BUTTON_SELECTOR)) {
    const label = chartCardButtonLabel(btn);
    if (label) btn.setAttribute('aria-label', label);
    return;
  }
  const name = btn.getAttribute('data-name');
  if (!name) return;
  const added = btn.classList.contains('is-added');
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
