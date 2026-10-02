# Authentication & Authorization Matrix

This document provides the exhaustive authorization and session security matrix for the My Lists Addon backend (`worker_entry_combined.js`), detailing identity models, server-side ownership enforcement, unauthorized test scenarios, and observed status/results.

## Matrix Legend

- **Identity:** Credential or session construct presented (`Session Cookie`, `Bearer Token`, `Creator Key`, `Admin Cookie / CF Access Assertion`, `Voter Token`, `Public`).
- **Ownership:** Scope of data access (`Account-Scoped`, `Creator-Scoped`, `Admin-Scoped`, `Public-Scoped`, `Device/Voter-Scoped`).
- **Unauthorized test:** Negative control scenario tested.
- **Result:** Observed status code and enforcement behavior.

---

## 1. Creator & Account Management Routes

| Route | Identity | Ownership | Unauthorized test | Result |
|---|---|---|---|---|
| `POST /api/creator/create` | Anonymous | None (creation) | Reserved/invalid username, CGNAT burst limit | 400 (validation), 429 (burst limit) |
| `POST /api/creator/restore` | Creator Key in body | Creator-Scoped | Wrong Creator Key for existing user; missing IP | 401 (`Username or Key is incorrect.`), 429 on daily brute-force limit |
| `POST /api/creator/reset-key` | Recovery Answer | Creator-Scoped | Wrong recovery answer; non-existent account | 401 (`That username and recovery answer don't match...`), 429 on account failure budget |
| `POST /api/creator/forgot-username` | Creator Key + Recovery Answer | Creator-Scoped | Wrong key; wrong recovery answer | 401 (`No matching account found...`), 429 on IP failure budget |
| `POST /api/creator/recovery-answer` | Creator Key or Session | Creator-Scoped | Mismatched session; wrong creator key | 401 (`Username or Key is incorrect.`) |
| `POST /api/creator/scrobble-token` | Creator Key or Session | Creator-Scoped | Anonymous; mismatched session; wrong key | 401 (`Username or Key is incorrect.`) |
| `POST /api/creator/sync/load` | Session Cookie or Creator Key | Creator-Scoped | User A session requesting User B sync state | 401 (`Username or Key is incorrect.`); Owner User B succeeds (200) |
| `POST /api/creator/sync/save` | Session Cookie or Creator Key | Creator-Scoped | User A session saving configuration to User B | 401 (`Username or Key is incorrect.`); Owner User B succeeds (200) |
| `POST /api/creator/lists` | Session Cookie or Creator Key | Creator-Scoped | User A session attempting to enumerate User B's lists | 401 (`Username or Key is incorrect.`); Owner User B succeeds (200) |
| `POST /api/creator/lists/save` | Session Cookie or Creator Key | Creator-Scoped | User A session attempting to write list under User B | 401 (`Username or Key is incorrect.`); Owner User B succeeds (200) |
| `POST /api/creator/lists/delete` | Session Cookie or Creator Key | Creator-Scoped | User A session attempting to delete User B list | 401 (`Username or Key is incorrect.`); Owner User B succeeds (200) |
| `POST /api/creator/lists/reorder` | Session Cookie or Creator Key | Creator-Scoped | User A session attempting to reorder User B lists | 401 (`Username or Key is incorrect.`); Owner User B succeeds (200) |
| `POST /api/creator/delete-account` | Session Cookie or Creator Key | Creator-Scoped | Mismatched session/user; missing `confirm: "DELETE"` | 401 (auth failure), 400 (`Missing confirmation.`) |
| `POST /api/creator/account/reset` | Session Cookie or Creator Key | Creator-Scoped | Mismatched session/user; missing `confirm: "RESET"` | 401 (auth failure), 400 (`Missing confirmation.`) |
| `POST /api/creator/sessions` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request; revoking another account's session | 401 (`Authentication required.`); DB query scoped strictly by `WHERE account_id = ?` |

---

## 2. Modern Session & Account Identity Routes

| Route | Identity | Ownership | Unauthorized test | Result |
|---|---|---|---|---|
| `POST /api/session` | Username + Account Key | Account-Scoped | Incorrect password/key; malformed JSON | 401 (`Username or Key is incorrect.`), 400 (bad JSON) |
| `DELETE /api/session` | Session Cookie or Bearer Token | Account-Scoped | Expired or non-existent token | 200 with `Max-Age=0` Set-Cookie (idempotent logout) |
| `GET /api/me` | Session Cookie or Bearer Token | Account-Scoped | Anonymous request; expired session; revoked session | 401 (`Authentication required.`); Owner succeeds (200) |
| `GET /api/me/sessions` | Session Cookie or Bearer Token | Account-Scoped | Anonymous request; expired session | 401 (`Authentication required.`); Owner succeeds (200) |
| `POST /api/me/sessions/revoke` | Session Cookie or Bearer Token | Account-Scoped | Anonymous request; target session owned by other user | 401 (`Authentication required.`); query enforces `account_id = ?` |

---

## 3. Installs API (`27_installs.js`)

| Route | Identity | Ownership | Unauthorized test | Result |
|---|---|---|---|---|
| `GET /api/installs` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request; expired session | 401 (`Sign in to manage your installs.`); Owner succeeds (200) |
| `POST /api/installs` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request; embedding another user's `autotrack` | 401 (anonymous), 400 (`An install can only carry your own Watch History...`) |
| `GET /api/installs/:id` | Session Cookie (`request.account`) | Account-Scoped | User A session viewing User B's install link | 404 (`Not found.` - answers identically to nonexistent); Owner User B succeeds (200) |
| `PATCH /api/installs/:id` | Session Cookie (`request.account`) | Account-Scoped | User A session rotating User B's install token | 404 (`Not found.`); Owner User B succeeds (200) |
| `PUT /api/installs/:id` | Session Cookie (`request.account`) | Account-Scoped | User A session replacing User B's install config | 404 (`Not found.`); Owner User B succeeds (200) |
| `DELETE /api/installs/:id` | Session Cookie (`request.account`) | Account-Scoped | User A session deleting User B's install link | 404 (`Not found.`); Owner User B succeeds (200) |

---

## 4. Provider Connections API (`28_connections.js`)

| Route | Identity | Ownership | Unauthorized test | Result |
|---|---|---|---|---|
| `GET /api/connections` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request; expired session | 401 (`Sign in to manage your connected accounts.`); Owner succeeds (200) |
| `POST /api/connections` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request; invalid API key format | 401 (anonymous); Owner succeeds (200) |
| `DELETE /api/connections/:provider` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request; User A deleting User B's provider | 401 (anonymous); D1 delete scoped strictly by `WHERE account_id = ?` |

---

## 5. Lists v2 API (`31_lists-api.js`)

| Route | Identity | Ownership | Unauthorized test | Result |
|---|---|---|---|---|
| `GET /api/lists` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request | 401 (`Sign in to manage your lists.`); Owner succeeds (200) |
| `POST /api/lists` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request; missing name; bad mediaType | 401 (anonymous), 400 (validation); Owner succeeds (201) |
| `GET /api/lists/:publicId` | Optional Session | Public / Owner | Anonymous or User A reading User B's private list | 404 (`Not found.`); Owner User B succeeds (200 with ETag) |
| `PATCH /api/lists/:publicId` | Session Cookie (`request.account`) | Account-Scoped | User A updating User B's list; missing `If-Match` | 404 (private) / 403 (public), 428 (`Send If-Match...`) |
| `DELETE /api/lists/:publicId` | Session Cookie (`request.account`) | Account-Scoped | User A deleting User B's list; version conflict | 404 (private) / 403 (public), 412 (conflict) |
| `PUT /api/lists/:publicId/visibility` | Session Cookie (`request.account`) | Account-Scoped | User A changing User B list visibility | 404 (private) / 403 (public); Owner User B succeeds (200) |
| `POST /api/lists/:publicId/items` | Session Cookie (`request.account`) | Account-Scoped | User A adding item to User B list | 404 (private) / 403 (public); Owner User B succeeds (200) |
| `DELETE /api/lists/:publicId/items/:mediaId` | Session Cookie (`request.account`) | Account-Scoped | User A removing item from User B list | 404 (private) / 403 (public); Owner User B succeeds (200) |
| `POST /api/lists/:publicId/items/move` | Session Cookie (`request.account`) | Account-Scoped | User A reordering items in User B list | 404 (private) / 403 (public); Owner User B succeeds (200) |

---

## 6. Likes v2 API (`32_likes-api.js`)

| Route | Identity | Ownership | Unauthorized test | Result |
|---|---|---|---|---|
| `GET /api/likes` | Session Cookie or Voter Token | Voter-Scoped | Anonymous request with no voter token | 401 (auth required) |
| `POST /api/likes` | Session Cookie or Voter Token | Voter-Scoped | Liking non-existent list; liking own list; anonymous | 404 (non-existent), 400 (`Cannot like your own list`), 401 (anonymous) |
| `DELETE /api/likes/:listId` | Session Cookie or Voter Token | Voter-Scoped | Unliking list never liked; anonymous | 200 (idempotent removal), 401 (anonymous) |

---

## 7. Channels v2 API (`35_channels-v2.js`)

| Route | Identity | Ownership | Unauthorized test | Result |
|---|---|---|---|---|
| `GET /api/channels/v2` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request | 401 (`Sign in to manage your channels.`); Owner succeeds (200) |
| `POST /api/channels/v2` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request; missing name | 401 (anonymous), 400 (validation); Owner succeeds (201) |
| `GET /api/channels/v2/:channelId` | Optional Session | Public / Owner | Anonymous or User A accessing User B's private channel | 404 (`Not found.`); Owner User B succeeds (200) |
| `PUT /api/channels/v2/:channelId` | Session Cookie (`request.account`) | Account-Scoped | User A modifying User B's channel | 404 (`Not found.`); Owner User B succeeds (200) |
| `DELETE /api/channels/v2/:channelId` | Session Cookie (`request.account`) | Account-Scoped | User A deleting User B's channel | 404 (`Not found.`); Owner User B succeeds (200) |
| `POST /api/channels/v2/:channelId/like`| Session Cookie or Voter Token | Voter-Scoped | Liking own channel; liking non-existent channel | 400 (`Cannot like your own channel`), 404 (not found) |

---

## 8. Activity & Watch History API (`38_activity-scrobble.js`, `39_activity-history.js`)

| Route | Identity | Ownership | Unauthorized test | Result |
|---|---|---|---|---|
| `POST /api/scrobble` | Scrobble Token (`?st=...` or `Bearer`) | Creator-Scoped | Missing or revoked scrobble token | 401 (`Invalid or missing scrobble token.`) |
| `POST /api/scrobble/plex` | Scrobble Token in URL path | Creator-Scoped | Unknown scrobble token in path | 401 (`Invalid scrobble token.`) |
| `GET /api/activity/history` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request | 401 (`Sign in to view watch history.`); Owner succeeds (200) |
| `DELETE /api/activity/history` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request | 401 (`Sign in to clear watch history.`); Owner succeeds (200) |
| `GET /api/activity/show/:showId` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request | 401 (`Sign in to view show progress.`); Owner succeeds (200) |
| `PUT /api/activity/show/:showId/dismiss` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request | 401 (`Sign in to dismiss episode.`); Owner succeeds (200) |
| `DELETE /api/activity/show/:showId/dismiss` | Session Cookie (`request.account`) | Account-Scoped | Anonymous request | 401 (`Sign in to restore episode.`); Owner succeeds (200) |

---

## 9. OAuth Provider Integration Routes

| Route | Identity | Ownership | Unauthorized test | Result |
|---|---|---|---|---|
| `GET /api/trakt/device/code` | Anonymous | Public (PIN grant) | None (public device flow initiation) | 200 with device code & verification URL |
| `POST /api/trakt/device/token` | Device Code | Public (polling) | Invalid or expired device code | 404 (`Invalid device code`), 410 (`Code expired`) |
| `GET /api/mdblist/oauth/start` | Anonymous / Session | Flow-Scoped | Missing `MDBLIST_CLIENT_ID` configuration | 503 (service unavailable); Generates PKCE S256 + State cookie |
| `GET /api/mdblist/oauth/callback`| State Cookie + Query Code | Flow-Scoped | Tampered state parameter; missing state cookie | 302 redirect with `mdblist_error=state_mismatch`; clears cookie |
| `GET /api/simkl/oauth/start` | Anonymous / Session | Flow-Scoped | Missing `SIMKL_CLIENT_ID` configuration | 503 (service unavailable); Generates State cookie |
| `GET /api/simkl/oauth/callback` | State Cookie + Query Code | Flow-Scoped | State mismatch / CSRF attempt | 302 redirect with `simkl_error=state_mismatch`; clears cookie |
| `GET /api/tmdb/oauth/start` | Anonymous / Session | Flow-Scoped | Missing `TMDB_API_KEY` configuration | 503 (service unavailable); Generates request token cookie |
| `GET /api/tmdb/oauth/callback` | Token Cookie + Request Token | Flow-Scoped | Token mismatch / foreign request token | 302 redirect with `tmdb_error=state_mismatch`; clears cookie |

---

## 10. Admin Dashboard & Administrative APIs (`03_admin.js`)

| Route | Identity | Ownership | Unauthorized test | Result |
|---|---|---|---|---|
| `GET /admin` | Public / Admin Cookie | Admin-Scoped | Anonymous request | 200 (renders login HTML form, no data exposed) |
| `POST /admin/login` | Form Data (`key`) or CF Access | Admin-Scoped | Incorrect admin key; brute-force burst > 10/min | 401 (`Incorrect key.`), 429 (`Too many attempts...`) |
| `POST /admin/logout` | Admin Cookie | Admin-Scoped | Anonymous or expired admin cookie | 302 redirect to `/admin`, clears `mla_admin` cookie (`Max-Age=0`) |
| `GET /admin/api/admin-sessions` | Admin Session Cookie | Admin-Scoped | Anonymous; regular user session cookie; creator key | 401 (`Not authorized.`); Authenticated Admin succeeds (200) |
| `POST /admin/api/revoke-admin-session` | Admin Session Cookie | Admin-Scoped | Regular user session; invalid session ID | 401 (`Not authorized.`); Admin succeeds (200) |
| `POST /admin/api/revoke-all-admin-sessions` | Admin Session Cookie | Admin-Scoped | Regular user session | 401 (`Not authorized.`); Admin succeeds (200) |
| `GET /admin/api/audit-log` | Admin Session Cookie | Admin-Scoped | Regular user session; anonymous | 401 (`Not authorized.`); Admin succeeds (200) |
| `POST /admin/api/reset-creator-key` | Admin Session Cookie | Admin-Scoped | Regular user session; anonymous | 401 (`Not authorized.`); Admin succeeds (200 with new key) |
| `POST /admin/api/delete-creator-list` | Admin Session Cookie | Admin-Scoped | Regular user session; anonymous | 401 (`Not authorized.`); Admin succeeds (200) |
| `POST /admin/api/delete-published-list` | Admin Session Cookie | Admin-Scoped | Regular user session; anonymous | 401 (`Not authorized.`); Admin succeeds (200) |
| `POST /admin/api/channel-moderate` | Admin Session Cookie | Admin-Scoped | Regular user session; anonymous | 401 (`Not authorized.`); Admin succeeds (200) |
| `POST /admin/api/migrate-d1` | Admin Session Cookie | Admin-Scoped | Regular user session; anonymous | 401 (`Not authorized.`); Admin succeeds (200) |
| `POST /admin/api/migrate-accounts` | Admin Session Cookie | Admin-Scoped | Regular user session; anonymous | 401 (`Not authorized.`); Admin succeeds (200) |
| `POST /admin/api/lists-backfill/step` | Admin Session Cookie | Admin-Scoped | Regular user session; anonymous | 401 (`Not authorized.`); Admin succeeds (200) |
| `POST /admin/api/activity-backfill/step`| Admin Session Cookie | Admin-Scoped | Regular user session; anonymous | 401 (`Not authorized.`); Admin succeeds (200) |
