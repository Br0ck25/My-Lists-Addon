# k6 Load Testing Suite (P8-5)

This directory contains automated k6 load tests for evaluating performance against the latency budgets in [`PERFORMANCE_AUDIT.md`](../PERFORMANCE_AUDIT.md) §5 and [`docs/PERFORMANCE.md`](../docs/PERFORMANCE.md).

---

## 1. Prerequisites

Install `k6` on your operating system:

- **Windows**: `winget install k6 --source winget` or `choco install k6`
- **macOS**: `brew install k6`
- **Linux**: `sudo apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D34EE24C && echo "deb https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list && sudo apt-get update && sudo apt-get install k6`
- **Docker**: `docker run -i --rm grafana/k6 run - <loadtests/catalog-hot-path.js`

---

## 2. Test Scenarios

### A. Catalog Hot Path (`catalog-hot-path.js`)
Simulates concurrent Stremio clients booting and loading their 20-row home screens:
- Requests `GET /{installId}/manifest.json`
- Requests individual catalog rows `GET /{installId}/catalog/{type}/{id}.json`
- Tests both cold fetches (KV snapshot retrieval) and warm cache hits (Cache API / isolate memo)
- **Thresholds**:
  - `catalog_cached_duration`: p95 < 15 ms (< 5 ms server budget + 10 ms network buffer)
  - `catalog_duration`: p95 < 40 ms (cold KV install + chart snapshot target)
  - `manifest_duration`: p95 < 25 ms

```bash
k6 run loadtests/catalog-hot-path.js -e BASE_URL=https://staging.mylistsaddon.com -e INSTALL_ID=your_test_install_id
```

### B. Scrobble Burst (`scrobble-burst.js`)
Simulates peak bursts of media playback webhooks (Plex, Emby, Jellyfin) using the scoped token `?st=`:
- Ramps up to 100 webhook requests/second
- Evaluates non-blocking queue ingestion and event tracking
- Validates that D1 does not encounter write lock contention, transaction exhaustion, or rate limit rejections (429)
- **Thresholds**:
  - `scrobble_errors`: 0% error rate
  - `scrobble_duration`: p95 < 100 ms

```bash
k6 run loadtests/scrobble-burst.js -e BASE_URL=https://staging.mylistsaddon.com -e SCROBBLE_TOKEN=your_scrobble_token
```

### C. Directory Depth (`directory-depth.js`)
Simulates deep catalog/channel browsing through pagination:
- Queries `/lists/public.json?sort=popular&limit=20`
- Sequentially traverses pages 1 through 20+ using keyset cursor pagination (`&cursor=...`)
- Compares page 1 latency against deep pages (pages 10–20+) to ensure constant-time $O(1)$ index traversal
- **Thresholds**:
  - `directory_page1_duration`: p95 < 30 ms
  - `directory_deep_duration`: p95 < 50 ms

```bash
k6 run loadtests/directory-depth.js -e BASE_URL=https://staging.mylistsaddon.com -e MAX_DEPTH=20
```

### D. Comprehensive Suite (`run-all.js`)
Executes all three scenarios concurrently to evaluate overall Worker behavior under blended traffic.

```bash
k6 run loadtests/run-all.js \
  -e BASE_URL=https://staging.mylistsaddon.com \
  -e INSTALL_ID=your_test_install_id \
  -e SCROBBLE_TOKEN=your_scrobble_token
```

---

## 3. Environment Variables

| Variable | Description | Default |
|---|---|---|
| `BASE_URL` | Target base URL (staging or production) | `http://localhost:8787` |
| `INSTALL_ID` | Valid install ID containing custom lists / charts | `demo` |
| `SCROBBLE_TOKEN` | Scoped scrobble token (`?st=`) for an active account | `sample_st_token_12345` |
| `MAX_DEPTH` | Maximum pages to traverse in directory depth test | `20` |
