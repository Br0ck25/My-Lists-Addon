// A pill row scrolls sideways on a phone. When a row comes into view (page load,
// opening a tab from a link or the bottom nav) the ticked pill is centred in it.
// Only the row itself scrolls: scrollIntoView could also move the page.
function centerActivePill(bar) {
  const pill = bar.querySelector('.subnav-pill.active');
  if (!pill) return;
  const barBox = bar.getBoundingClientRect();
  const pillBox = pill.getBoundingClientRect();
  const target = bar.scrollLeft + (pillBox.left - barBox.left) - (bar.clientWidth - pillBox.width) / 2;
  bar.scrollLeft = Math.max(0, target);
}

(function watchPillRows() {
  if (typeof IntersectionObserver !== 'function') return;
  function start() {
    const seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) centerActivePill(e.target); });
    });
    document.querySelectorAll('.subnav-pills-bar').forEach(function (bar) { seen.observe(bar); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
