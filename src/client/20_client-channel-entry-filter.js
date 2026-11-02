// A saved channel map keeps only object values. One null or non-object entry
// (for example one synced from another device) must not break the page.
function objectEntriesOnly(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  for (const k of Object.keys(map)) {
    const v = map[k];
    if (!v || typeof v !== 'object' || Array.isArray(v)) delete map[k];
  }
  return map;
}
