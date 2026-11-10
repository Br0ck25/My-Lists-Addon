// POST /api/preview with validateOnly: true answers only whether the pasted
// link(s) are a supported list source, the same check the preview itself makes,
// with no provider call and no rate-limit charge (audit PROD-02). The New
// Catalog dialog asks before it saves a row.
function previewSourceCheckResponse(testUrl) {
  const sourceUrls = previewSourceUrls(testUrl);
  if (!sourceUrls.length || !sourceUrls.every(isAllowedCatalogSourceUrl)) {
    return json({ ok: false, error: "That URL isn't a supported list source." }, 400, { "Cache-Control": "no-store" });
  }
  return json({ ok: true }, 200, { "Cache-Control": "no-store" });
}

// The first page of ONE public TMDB or Trakt chart, asked for with no keys of the
// caller's own and a real country code from PREVIEW_COUNTRY_CODES (or none): shared data that is cached, so a
// preview of it is not charged to the per-address budget (audit PERF-03). The cache is
// per region and per key, so anything else could make every call a miss on the shared
// provider key; a deep page is its own cache entry too. Those are charged as before.
// ISO 3166-1 alpha-2 country codes (plus XK): the only regions that count as real.
const PREVIEW_COUNTRY_CODES = new Set("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK".split(" "));

function isFreeChartPreview(testUrl, skip, { region = "", keys = [] } = {}) {
  if (skip !== 0) return false;
  if (region && !PREVIEW_COUNTRY_CODES.has(String(region).toUpperCase())) return false;
  if (keys.some(Boolean)) return false;
  const urls = previewSourceUrls(testUrl);
  return urls.length === 1 && /^(?:tmdb|trakt):chart:[a-z0-9_-]+$/i.test(urls[0]);
}

// Catalog rows past the first page: every distinct `skip` is its own cache
// entry and its own provider call, so one address asking for hundreds of them
// could spend the shared TMDB and Trakt keys (audit API-05). They share a
// budget of 120 a minute per address; the first page is never charged and
// normal scrolling never gets near it. null when allowed.
const CATALOG_SKIP_MAX_PER_MINUTE = 120;
async function catalogSkipLimitResponse(request, env, ctx, skip) {
  if (!(skip > 0)) return null;
  const ip = clientIpKey(request);
  if (!ip || !(await consumeRateLimit(env, ctx, "catalog-skip", ip, CATALOG_SKIP_MAX_PER_MINUTE, 60))) return null;
  return jsonPublic({ metas: [] }, 429, { "Cache-Control": "no-store", "Retry-After": "30" });
}
