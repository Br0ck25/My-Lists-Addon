// Focus return for the fixed-markup dialogs listed in STATIC_MODALS (audit
// UI-06). They open and close by many routes (each has its own close function,
// plus Escape and backdrop clicks), so instead of patching each one, watch the
// shared fact: whether any of them is visible. When one appears, remember the
// control that had focus just before; when the last one disappears, give focus
// back to it.
let _staticModalOpener = null;
let _lastFocusOutsideStaticModal = null;

function noteFocusOutsideStaticModals(e) {
  const t = e && e.target;
  if (!t || t === document.body) return;
  for (let i = 0; i < STATIC_MODALS.length; i++) {
    const m = document.getElementById(STATIC_MODALS[i].id);
    if (m && typeof m.contains === 'function' && m.contains(t)) return;
  }
  _lastFocusOutsideStaticModal = t;
}

function syncStaticModalFocus() {
  if (visibleStaticModal()) {
    if (!_staticModalOpener) _staticModalOpener = _lastFocusOutsideStaticModal;
    return;
  }
  const opener = _staticModalOpener;
  _staticModalOpener = null;
  if (opener && typeof opener.focus === 'function') {
    try { opener.focus(); } catch (e) {}
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('focusin', noteFocusOutsideStaticModals, true);
  if (typeof MutationObserver === 'function') {
    const staticModalObserver = new MutationObserver(syncStaticModalFocus);
    STATIC_MODALS.forEach((m) => {
      const el = document.getElementById(m.id);
      if (el && typeof el.nodeType === 'number') staticModalObserver.observe(el, { attributes: true, attributeFilter: ['style'] });
    });
  }
}
