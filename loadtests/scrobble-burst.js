import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// Custom metrics for scrobble burst throughput and latency
const scrobbleDuration = new Trend('scrobble_duration', true);
const scrobbleErrors = new Rate('scrobble_errors');
const scrobbleSuccesses = new Counter('scrobble_successes');

export const options = {
  scenarios: {
    scrobble_burst: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 100,
      stages: [
        { duration: '5s', target: 50 },   // Spike rapidly to 50 requests/sec
        { duration: '15s', target: 100 }, // Peak burst: 100 requests/sec
        { duration: '10s', target: 20 },  // Cool down
      ],
    },
  },
  thresholds: {
    // 0% errors allowed during scrobble bursts
    'http_req_failed': ['rate<0.01'],
    'scrobble_errors': ['rate<0.01'],
    // Fast acknowledgement for webhooks/pings (non-blocking queue/event write)
    'scrobble_duration': ['p(95)<100', 'p(99)<200'],
  },
};

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const SCROBBLE_TOKEN = __ENV.SCROBBLE_TOKEN || 'sample_st_token_12345';

// Realistic sample media titles for Plex/Emby/Jellyfin webhooks
const SAMPLE_MEDIA = [
  { type: 'movie', title: 'Inception', imdb: 'tt1375666' },
  { type: 'movie', title: 'The Matrix', imdb: 'tt0133093' },
  { type: 'movie', title: 'Interstellar', imdb: 'tt0816692' },
  { type: 'series', title: 'Breaking Bad', imdb: 'tt0903747', season: 1, episode: 1 },
  { type: 'series', title: 'Stranger Things', imdb: 'tt4574334', season: 2, episode: 3 },
];

export default function () {
  const ip = `10.0.${(__VU % 250) + 1}.${(__ITER % 250) + 1}`;
  const media = SAMPLE_MEDIA[Math.floor(Math.random() * SAMPLE_MEDIA.length)];

  const payload = JSON.stringify({
    event: 'media.scrobble',
    Metadata: {
      type: media.type,
      title: media.title,
      grandparentTitle: media.type === 'series' ? media.title : undefined,
      parentIndex: media.season,
      index: media.episode,
      Guid: [{ id: `imdb://${media.imdb}` }],
    },
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
      'User-Agent': 'k6-loadtest/1.0 PlexMediaServer/1.29.0',
    },
    timeout: '5s',
  };

  const res = http.post(`${BASE_URL}/api/scrobble?st=${encodeURIComponent(SCROBBLE_TOKEN)}`, payload, params);
  scrobbleDuration.add(res.timings.duration);

  const ok = check(res, {
    'scrobble status 200 or 202': (r) => r.status === 200 || r.status === 202,
    'not rate limited (status != 429)': (r) => r.status !== 429,
    'no server error (status < 500)': (r) => r.status < 500,
  });

  if (ok) {
    scrobbleSuccesses.add(1);
  } else {
    scrobbleErrors.add(1);
  }

  sleep(0.1);
}
