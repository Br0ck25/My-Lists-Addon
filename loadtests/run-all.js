import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// Combined metrics across scenarios
const catalogDuration = new Trend('catalog_duration', true);
const catalogCachedDuration = new Trend('catalog_cached_duration', true);
const scrobbleDuration = new Trend('scrobble_duration', true);
const directoryDuration = new Trend('directory_duration', true);
const failureRate = new Rate('failures');

export const options = {
  scenarios: {
    // 1. Sustained Catalog Traffic (Simulating active Stremio app streaming)
    catalog_traffic: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        { duration: '10s', target: 15 },
        { duration: '30s', target: 25 },
        { duration: '10s', target: 0 },
      ],
      exec: 'catalogScenario',
      tags: { scenario: 'catalog' },
    },
    // 2. Periodic Scrobble Webhook Bursts
    scrobble_bursts: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 50,
      stages: [
        { duration: '15s', target: 30 },
        { duration: '15s', target: 60 },
        { duration: '20s', target: 10 },
      ],
      exec: 'scrobbleScenario',
      tags: { scenario: 'scrobble' },
    },
    // 3. User Directory Paging
    directory_browsing: {
      executor: 'constant-vus',
      vus: 5,
      duration: '50s',
      exec: 'directoryScenario',
      tags: { scenario: 'directory' },
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.01'],
    'failures': ['rate<0.01'],
    // Catalog budgets
    'catalog_duration': ['p(95)<40'],
    'catalog_cached_duration': ['p(95)<15'],
    // Scrobble budget
    'scrobble_duration': ['p(95)<100'],
    // Directory budget
    'directory_duration': ['p(95)<50'],
  },
};

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const INSTALL_ID = __ENV.INSTALL_ID || 'demo';
const SCROBBLE_TOKEN = __ENV.SCROBBLE_TOKEN || 'sample_st_token_12345';

const SAMPLE_CATALOG_ROWS = [
  { type: 'movie', id: 'top' },
  { type: 'series', id: 'top' },
  { type: 'movie', id: 'trending' },
  { type: 'series', id: 'trending' },
  { type: 'movie', id: 'popular' },
  { type: 'series', id: 'popular' },
];

export function catalogScenario() {
  const ip = `192.168.${(__VU % 250) + 1}.${(__ITER % 250) + 1}`;
  const headers = { 'CF-Connecting-IP': ip, 'Accept': 'application/json' };

  const row = SAMPLE_CATALOG_ROWS[Math.floor(Math.random() * SAMPLE_CATALOG_ROWS.length)];
  const url = `${BASE_URL}/${INSTALL_ID}/catalog/${row.type}/${row.id}.json`;

  const res = http.get(url, { headers });
  catalogDuration.add(res.timings.duration);

  const ok = check(res, { 'catalog 200': (r) => r.status === 200 });
  if (!ok) failureRate.add(1);

  // Cached hit
  const resCached = http.get(url, { headers });
  catalogCachedDuration.add(resCached.timings.duration);

  sleep(0.5);
}

export function scrobbleScenario() {
  const ip = `10.0.${(__VU % 250) + 1}.${(__ITER % 250) + 1}`;
  const payload = JSON.stringify({
    event: 'media.scrobble',
    Metadata: {
      type: 'movie',
      title: 'Inception',
      Guid: [{ id: 'imdb://tt1375666' }],
    },
  });

  const res = http.post(
    `${BASE_URL}/api/scrobble?st=${encodeURIComponent(SCROBBLE_TOKEN)}`,
    payload,
    { headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip } }
  );

  scrobbleDuration.add(res.timings.duration);
  const ok = check(res, { 'scrobble 200': (r) => r.status === 200 || r.status === 202 });
  if (!ok) failureRate.add(1);

  sleep(0.2);
}

export function directoryScenario() {
  const ip = `172.16.${(__VU % 250) + 1}.${(__ITER % 250) + 1}`;
  const res = http.get(`${BASE_URL}/lists/public.json?sort=popular&limit=20`, {
    headers: { 'CF-Connecting-IP': ip, 'Accept': 'application/json' },
  });

  directoryDuration.add(res.timings.duration);
  const ok = check(res, { 'directory 200': (r) => r.status === 200 });
  if (!ok) failureRate.add(1);

  sleep(1);
}
