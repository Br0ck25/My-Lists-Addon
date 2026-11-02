// Wraps a timer callback so a tick that arrives while the previous run is still
// waiting (a slow fetch) is skipped instead of starting a second request.
function skipWhileBusy(fn) {
  let busy = false;
  return async function () {
    if (busy) return;
    busy = true;
    try { return await fn.apply(this, arguments); } finally { busy = false; }
  };
}
