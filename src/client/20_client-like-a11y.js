// Names and pressed state for the heart buttons on list cards. They are icon-only
// (a ♡ or ♥ character), built in several places, and swapped between the two by
// their click handlers, so the state is read from the "liked" class they already
// carry instead of being kept in step in each place.
const LIKE_BUTTON_SELECTOR = 'button.searchLikeBtn, button.searchLikeExternalBtn';

function syncLikeButtonA11y(btn) {
  if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', 'Like this list');
  btn.setAttribute('aria-pressed', btn.classList.contains('liked') ? 'true' : 'false');
}

(function watchLikeButtons() {
  if (typeof MutationObserver !== 'function') return;
  function start() {
    document.querySelectorAll(LIKE_BUTTON_SELECTOR).forEach(syncLikeButtonA11y);
    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.type === 'attributes') {
          if (m.target.matches && m.target.matches(LIKE_BUTTON_SELECTOR)) syncLikeButtonA11y(m.target);
          return;
        }
        m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.matches(LIKE_BUTTON_SELECTOR)) syncLikeButtonA11y(n);
          n.querySelectorAll(LIKE_BUTTON_SELECTOR).forEach(syncLikeButtonA11y);
        });
      });
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
