// The header block every Trakt call sends (CQ-05). Authorization is added only
// when there is a token; apiKey is the site's Trakt app id unless the caller
// brings the person's own. Kept beside fetchTraktWithRetry
// (02_http-and-creator-utils.js), in its own file because that one is over the
// size baseline and may only shrink.
function traktHeaders(accessToken, apiKey = TRAKT_CLIENT_ID) {
  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": apiKey,
    "User-Agent": `my-list-addon/${ADDON_VERSION}`,
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}
