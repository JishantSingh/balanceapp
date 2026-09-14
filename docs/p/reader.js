'use strict';
(() => {
  function render() {
    if (!window.BahiPassbook) {
      document.getElementById('pb-status').textContent = 'The passbook could not load. Please refresh this page.';
      return;
    }
    try { BahiPassbook.open(BahiPassbook.parseHash(location.hash)); }
    catch (err) { BahiPassbook.showError(err.message); }
  }
  window.addEventListener('hashchange', render);
  window.addEventListener('pagehide', () => window.BahiPassbook?.cancel());
  window.addEventListener('pageshow', event => { if (event.persisted) render(); });
  render();
})();
