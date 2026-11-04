// The nine static pop-up forms carry no z-index of their own (so a dialog opened
// from one, such as "Could Not Save List", stacks above it by coming later in the
// page). The other way round -- a form opened while a dialog is already open --
// needs the form to come later, so it is moved to the end of <body> when it opens
// (they start inside the page's own container, which comes before any dialog).
const STATIC_MODAL_IDS = ['createListModal', 'createCollectionModal', 'importNuvioCollectionsModal', 'syncNuvioModal', 'addShelfModal', 'importListModal', 'importChannelModal', 'selectListModal', 'traktDeviceModal'];

function raiseStaticModal(form) {
  if (!form || (form.parentNode === document.body && !form.nextElementSibling)) return;
  // Moving a node drops focus from anything inside it.
  const focused = document.activeElement;
  document.body.appendChild(form);
  if (focused && form.contains(focused) && typeof focused.focus === 'function') focused.focus();
}

function watchStaticModals() {
  if (typeof MutationObserver !== 'function') return;
  STATIC_MODAL_IDS.forEach(function (id) {
    const form = document.getElementById(id);
    if (!form) return;
    new MutationObserver(function () {
      if (form.style.display === 'flex') raiseStaticModal(form);
    }).observe(form, { attributes: true, attributeFilter: ['style'] });
  });
}
// The page's script can run before the forms further down the page exist.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchStaticModals);
else watchStaticModals();
