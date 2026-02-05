import http from 'k6/http';
import { check, sleep } from 'k6';

// Performance Benchmark Configuration
// Target: 1000 Concurrent Users
// Latency (p95): < 500ms
export const options = {
  stages: [
    { duration: '30s', target: 200 },  // Ramp up
    { duration: '1m', target: 500 },   // Sustain
    { duration: '30s', target: 1000 }, // Ramp to Target
    { duration: '2m', target: 1000 },  // Sustain Peak
    { duration: '30s', target: 0 },    // Ramp down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<500'], // 95th percentile latency under 500ms
    'http_req_failed': ['rate<0.01'],   // Error rate <= 1%
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:5000/api';

export default function () {
  // Use a unique email to avoid conflict
  const email = `bench-${__VU}-${__ITER}-${Date.now()}@test.com`;
  const password = 'StrongPass123!';

  // 1. Registration (Write Heavy)
  const registerRes = http.post(`${BASE_URL}/auth/register`, JSON.stringify({
    email,
    password,
    firstName: 'Bench',
    lastName: 'Mark'
  }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { type: 'register' }
  });

  check(registerRes, {
    'register 201': (r) => r.status === 201,
  });

  // 2. Health Check / Public Route (Read Light)
  // Assuming a health endpoint exists or hitting root
  // If no explicit health check, we can hit a 404 to verify speed of router
  const healthRes = http.get(`${BASE_URL}/health`, {
     tags: { type: 'health' }
  });
  // If health endpoint doesn't exist, we might get 404, which is fine for measuring latency
  
  sleep(1);
}
