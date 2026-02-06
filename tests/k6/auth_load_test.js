import http from 'k6/http';
import { check, sleep } from 'k6';

// Performance Service Level Objectives
export const options = {
  stages: [
    { duration: '30s', target: 50 },  // Ramp up to 50 users
    { duration: '1m', target: 50 },   // Sustain
    { duration: '30s', target: 100 }, // Spike to 100 users
    { duration: '1m', target: 100 },  // Sustain
    { duration: '30s', target: 0 },   // Ramp down
  ],
  thresholds: {
    // API endpoints must respond within 3s for sign-up (P99)
    'http_req_duration{type:register}': ['p(95)<2000', 'p(99)<3000'],
    // API endpoints must respond within 2s for sign-in (P99)
    'http_req_duration{type:login}': ['p(95)<1500', 'p(99)<2000'],
    // Error rates below 0.1%
    'http_req_failed': ['rate<0.001'],
  },
};

const BASE_URL = 'http://localhost:5000/api/auth';

export default function () {
  // 1. Sign-Up Flow
  const email = `loadtest-${__VU}-${__ITER}-${Date.now()}@example.com`;
  const password = 'Password123!';
  
  const registerPayload = JSON.stringify({
    email,
    password,
    username: 'loadtestuser',
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
    tags: { type: 'register' },
  };

  const registerRes = http.post(`${BASE_URL}/register`, registerPayload, params);
  
  check(registerRes, {
    'register status is 201': (r) => r.status === 201,
  });

  // Note: Since activation is required for login, and we can't easily activate via email link in load test
  // (without a backdoor or reading DB), we will skip the login flow for *this specific user*.
  // Instead, we can simulate login failures or use a known active user if configured.
  // For this script, we focus on Register throughput and Database write performance.
  
  // To test Login Read Performance (Caching), we can try to login with a known bad user (401)
  // or a known good user if you set one up.
  // Here we attempt login with the just-created (inactive) user to test the "User.findOne" query speed.
  
  const loginPayload = JSON.stringify({
    email,
    password,
  });
  
  const loginParams = {
    headers: { 'Content-Type': 'application/json' },
    tags: { type: 'login' },
  };

  const loginRes = http.post(`${BASE_URL}/login`, loginPayload, loginParams);
  
  // We expect 401 because user is not active, but the DB query "findOne" still executes.
  check(loginRes, {
    'login handled (401 or 200)': (r) => r.status === 401 || r.status === 200,
  });

  sleep(1);
}
