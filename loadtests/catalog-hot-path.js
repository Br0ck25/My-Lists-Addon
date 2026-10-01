import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// Custom metrics for PERFORMANCE_AUDIT §5 latency budget verification
const manifestDuration = new Trend('manifest_duration', true);
const catalogDuration = new Trend('catalog_duration', true);
const catalogCachedDuration = new Trend('catalog_cached_duration', true);
const failureRate = new Rate('failures');

export const options = {
  scenarios: {
    catalog_hot_path: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 10 },  // Ramp-up to 10 VUs
        { duration: '30s', target: 20 },  // Steady state: 20 concurrent clients
        { duration: '10s', target: 0 },   // Ramp-down
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    // Overall request failure rate under 1%
    'http_req_failed': ['rate<0.01'],
    'failures': ['rate<0.01'],
    // PERFORMANCE_AUDIT §5: Cache API / edge memory hit target < 5 ms (+ network allowance = < 15 ms)
    'catalog_cached_duration': ['p(95)<15', 'p(99)<25'],
    // PERFORMANCE_AUDIT §5: KV install + chart snapshot cold target < 40 ms
    'catalog_duration': ['p(95)<40', 'p(99)<80'],
    // Manifest load target < 25 ms
    'manifest_duration': ['p(95)<25'],
  },
};

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const INSTALL_ID = __ENV.INSTALL_ID || 'demo';

// Catalog rows to simulate home screen rows (up to 20 rows per install)
const SAMPLE_CATALOG_ROWS = [
  { type: 'movie', id: 'top' },
  { type: 'series', id: 'top' },
  { type: 'movie', id: 'trending' },
  { type: 'series', id: 'trending' },
  { type: 'movie', id: 'popular' },
  { type: 'series', id: 'popular' },
  { type: 'movie', id: 'netflix' },
  { type: 'series', id: 'netflix' },
  { type: 'movie', id: 'disney' },
  { type: 'series', id: 'disney' },
];

export default function () {
  const ip = `192.168.${(__VU % 250) + 1}.${(__ITER % 250) + 1}`;
  const headers = {
    'User-Agent': 'k6-loadtest/1.0 Stremio/4.4.168',
    'CF-Connecting-IP': ip,
    'Accept': 'application/json',
  };

  group('1. Stremio Manifest', function () {
    const res = http.get(`${BASE_URL}/${INSTALL_ID}/manifest.json`, { headers });
    manifestDuration.add(res.timings.duration);

    const ok = check(res, {
      'manifest status 200': (r) => r.status === 200,
      'manifest has id': (r) => {
        try { return JSON.parse(r.body).id !== undefined; } catch { return false; }
      },
    });
    if (!ok) failureRate.add(1);
  });

  group('2. Catalog Rows Fetch (Home Screen)', function () {
    const row = SAMPLE_CATALOG_ROWS[Math.floor(Math.random() * SAMPLE_CATALOG_ROWS.length)];
    const url = `${BASE_URL}/${INSTALL_ID}/catalog/${row.type}/${row.id}.json`;

    // 2a. Initial request (may hit KV snapshot or cold isolate)
    const resCold = http.get(url, { headers });
    catalogDuration.add(resCold.timings.duration);

    const okCold = check(resCold, {
      'catalog status 200': (r) => r.status === 200,
      'catalog has metas array': (r) => {
        try { return Array.isArray(JSON.parse(r.body).metas); } catch { return false; }
      },
    });
    if (!okCold) failureRate.add(1);

    // 2b. Immediate re-request (hits warm isolate memory / Cache API)
    const resWarm = http.get(url, { headers });
    catalogCachedDuration.add(resWarm.timings.duration);

    const okWarm = check(resWarm, {
      'cached catalog status 200': (r) => r.status === 200,
    });
    if (!okWarm) failureRate.add(1);
  });

  sleep(0.5);
}
