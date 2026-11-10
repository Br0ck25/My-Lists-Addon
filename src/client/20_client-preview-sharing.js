// Calls for the same chart made while the first is still on the way share it
// (the home page shows some charts in two rows); a finished answer is cached by
// requestListPreview (19_), and a failed one is not kept (audit PERF-03).
const listPreviewInFlight = new Map();
async function fetchListPreviewOnce(listUrl, type, sample) {
  const liveLibrary = /^autotrack:(nuvio|stremio)-library:/.test(String(listUrl || ''));
  if (liveLibrary) return requestListPreview(listUrl, type, sample);
  const key = String(listUrl) + '|' + String(type) + '|' + String(sample || 12) + (isAdultContentFilterEnabled() ? '|safe' : '');
  if (listPreviewInFlight.has(key)) return listPreviewInFlight.get(key);
  const pending = requestListPreview(listUrl, type, sample).finally(() => { listPreviewInFlight.delete(key); });
  listPreviewInFlight.set(key, pending);
  return pending;
}
