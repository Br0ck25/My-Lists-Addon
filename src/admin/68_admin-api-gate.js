// One check for every /admin/api/ route (audit TEST-04). Each admin route also
// checks isAdminRequest itself, but a route added without that check, however it
// is matched, used to answer a stranger. handleFetch (25_) calls this before any
// route, so such a route answers 401 to anyone without an admin identity.
//
// It asks only who the caller is (resolveAdminIdentity), not isAdminRequest,
// which also writes the audit row: the route's own check still does that, once.
async function adminApiGate(request, env, path) {
  if (!String(path || "").startsWith("/admin/api/")) return null;
  if (await resolveAdminIdentity(request, env)) return null;
  return json({ ok: false, error: "Not authorized." }, 401, { "Cache-Control": "no-store" });
}
