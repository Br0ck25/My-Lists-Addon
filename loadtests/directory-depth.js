import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// Custom metrics to compare shallow vs deep pagination latency
const page1Duration = new Trend('directory_page1_duration', true);
const deepPageDuration = new Trend('directory_deep_duration', true);
const allPagesDuration = new Trend('directory_all_pages_duration', true);
const failureRate = new Rate('directory_failures');

export const options = {
  scenarios: {
    directory_depth_traversal: {
      executor: 'constant-vus',
      vus: 5,
      duration: '30s',
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.01'],
    'directory_failures': ['rate<0.01'],
    // Page 1 initial view target < 30 ms
    'directory_page1_duration': ['p(95)<30'],
    // Deep pages (10-20+) target < 50 ms (keyset index seek should be constant time)
    'directory_deep_duration': ['p(95)<50', 'p(99)<90'],
    'directory_all_pages_duration': ['p(95)<45'],
  },
};

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const MAX_DEPTH = parseInt(__ENV.MAX_DEPTH || '20', 10);
const PAGE_SIZE = 20;

export default function () {
  const ip = `172.16.${(__VU % 250) + 1}.${(__ITER % 250) + 1}`;
  const headers = {
    'CF-Connecting-IP': ip,
    'Accept': 'application/json',
    'User-Agent': 'k6-loadtest/1.0',
  };

  let cursor = null;
  let page = 1;

  while (page <= MAX_DEPTH) {
    let url = `${BASE_URL}/lists/public.json?sort=popular&limit=${PAGE_SIZE}`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    const res = http.get(url, { headers });
    const dur = res.timings.duration;

    allPagesDuration.add(dur);
    if (page === 1) {
      page1Duration.add(dur);
    } else if (page >= 10) {
      deepPageDuration.add(dur);
    }

    const ok = check(res, {
      'status is 200': (r) => r.status === 200,
      'has items array': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.items || body.lists);
        } catch {
          return false;
        }
      },
    });

    if (!ok) {
      failureRate.add(1);
      break;
    }

    try {
      const data = JSON.parse(res.body);
      cursor = data.cursor || data.nextCursor || null;
      // If end of list reached or no cursor, stop pagination for this iteration
      if (!cursor) break;
    } catch {
      break;
    }

    page++;
    sleep(0.05); // Short think time between scroll/page turns
  }

  sleep(1);
}
