const required = [
  'MONGODB_URI',
  'JWT_SECRET',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'S3_BUCKET_NAME',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
];

const optionalWithDefaults = {
  PORT: '5000',
  NODE_ENV: 'development',
  JWT_EXPIRES_IN: '7d',
  SMTP_PORT: '587',
  FRONTEND_URL: 'http://localhost:5173',
  EMAIL_FROM: null,
};

function validateEnv() {
  const missing = required.filter((key) => {
    const v = process.env[key];
    return v === undefined || v === '' || (typeof v === 'string' && v.trim() === '');
  });

  if (missing.length > 0) {
    console.error('[ENV] Missing required environment variables:', missing.join(', '));
    console.error('[ENV] Copy .env.example to .env and set all values.');
    process.exit(1);
  }

  const secret = process.env.JWT_SECRET;
  if (secret.length < 32) {
    console.error('[ENV] JWT_SECRET must be at least 32 characters for security.');
    process.exit(1);
  }

  const mongo = process.env.MONGODB_URI;
  if (!mongo.startsWith('mongodb://') && !mongo.startsWith('mongodb+srv://')) {
    console.error('[ENV] MONGODB_URI must start with mongodb:// or mongodb+srv://');
    process.exit(1);
  }

  const frontend = process.env.FRONTEND_URL || optionalWithDefaults.FRONTEND_URL;
  try {
    const u = new URL(frontend);
    if (!['http:', 'https:'].includes(u.protocol)) {
      console.error('[ENV] FRONTEND_URL must use http or https');
      process.exit(1);
    }
  } catch {
    console.error('[ENV] FRONTEND_URL must be a valid URL (e.g. http://localhost:5173)');
    process.exit(1);
  }

  const port = process.env.SMTP_PORT || optionalWithDefaults.SMTP_PORT;
  const portNum = parseInt(port, 10);
  if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
    console.error('[ENV] SMTP_PORT must be a number between 1 and 65535');
    process.exit(1);
  }

  console.log('[ENV] Required variables present and valid (MongoDB, JWT, AWS S3, SMTP, FRONTEND_URL).');
}

export { validateEnv };
