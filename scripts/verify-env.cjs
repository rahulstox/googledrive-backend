const fs = require('fs');
const path = require('path');

// Define required variables based on .env.example or architecture
const REQUIRED_VARS = [
  'PORT',
  'MONGODB_URI',
  'JWT_SECRET',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'S3_BUCKET_NAME',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'DOMAIN_URL',
  'REDIS_URL'
];

// Load env vars (simulate loading if running in a context where they are not set, 
// but typically this script runs in an environment where they are already present)
// For this script, we'll assume process.env is populated or we load from .env for checking
require('dotenv').config();

console.log("Starting Environment Variable Audit...");

let missing = [];
let warnings = [];

REQUIRED_VARS.forEach(key => {
  if (!process.env[key]) {
    missing.push(key);
  } else {
    // Basic heuristics for "production-ready" values
    const val = process.env[key];
    if (key === 'NODE_ENV' && val !== 'production') {
      warnings.push(`NODE_ENV is set to '${val}', expected 'production'`);
    }
    if (key.includes('SECRET') || key.includes('KEY') || key.includes('PASS')) {
        if (val === 'change_me' || val === 'default' || val.length < 8) {
            warnings.push(`${key} appears to be weak or default.`);
        }
    }
  }
});

if (missing.length > 0) {
  console.error("❌ CRITICAL: Missing Environment Variables:");
  missing.forEach(m => console.error(`   - ${m}`));
  process.exit(1);
} else {
  console.log("✅ All required environment variables are present.");
}

if (warnings.length > 0) {
  console.warn("⚠️  WARNINGS:");
  warnings.forEach(w => console.warn(`   - ${w}`));
}

console.log("Environment Audit Completed.");
