# Drive Backend

Node.js backend for the Drive (Google Drive–style) application: auth, file/folder metadata in MongoDB Atlas, and file storage in AWS S3.

## Features

- **Auth**: Register, two-step activation (email link), login (activated users only), forgot password, reset password.
- **Users**: Email (unique), first name, last name, encrypted password.
- **Files**: Create folder, upload file (multipart), list by parent, download (presigned URL), delete. Metadata in MongoDB; binaries in private S3 bucket.

## Tech

- Node.js (ES modules), Express
- MongoDB Atlas (Mongoose)
- AWS S3 (SDK v3, presigned URLs)
- JWT, bcrypt, express-validator, helmet, rate-limit, nodemailer

## Environment verification

On startup the server validates (without logging secrets):

- **Required**: `MONGODB_URI`, `JWT_SECRET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET_NAME`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`
- **JWT_SECRET**: must be at least 32 characters
- **MONGODB_URI**: must start with `mongodb://` or `mongodb+srv://`
- **FRONTEND_URL**: must be a valid http/https URL
- **SMTP_PORT**: must be 1–65535

Optional with defaults: `PORT`, `NODE_ENV`, `JWT_EXPIRES_IN`, `SMTP_PORT`, `FRONTEND_URL`, `EMAIL_FROM`.

**Health checks:**

- `GET /health` — always returns `{ status: 'ok' }` if the process is up
- `GET /ready` — returns `{ ok, mongodb, s3 }`; `ok` is true only when MongoDB is connected and S3 bucket is reachable (validates full setup)

## Setup

1. Copy `.env.example` to `.env` and set:
   - `MONGODB_URI`
   - `JWT_SECRET`
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET_NAME`
   - `SMTP_*` for activation and password-reset emails
   - `FRONTEND_URL` for CORS and email links
   - `SMTP_SECURE` (optional): Set to "true" for port 465, or leave empty/false for port 587.
   - `REDIS_URL` (optional): Connection string for Redis caching (e.g., `redis://localhost:6379`).
2. `npm install`
3.4. `npm run dev` (or `npm start`)

## Performance & Testing

### Load Testing
Run the K6 load test script to verify performance SLOs:
```bash
k6 run tests/k6/auth_load_test.js
```

### Unit Tests
Run the comprehensive test suite (including registration workflow, timeouts, and rate limits):

```bash
npm test src/tests/registration.test.js
```

Verify SMTP configuration:

```bash
node scripts/verify-smtp.js
```

## Account Deletion Workflow

The `DELETE /api/auth/me` endpoint allows users to permanently delete their account and all associated data.

**Workflow:**

1.  **Authentication**: User must provide a valid Bearer token.
    - _Note_: Unlike other protected routes, this endpoint **allows inactive/unverified users** to delete their account (e.g., if they registered by mistake).
2.  **Validation**:
    - Requires `password` in the request body to confirm ownership.
    - Password is verified against the stored hash.
3.  **Data Removal**:
    - **S3 Files**: All files owned by the user are permanently deleted from the S3 bucket.
    - **Database**: User record, file metadata, and password reset tokens are removed.
    - Operations are performed in a transaction (where supported) to ensure consistency.
4.  **Notification**: An email is sent to the user confirming the deletion.

## API (high level)

- `POST /api/auth/register` — register (inactive until activation)
- `GET /api/auth/activate` — activate account (query param: token)
- `POST /api/auth/resend-activation` — resend activation email (rate limited)
- `POST /api/auth/login` — login (activated only)
- `POST /api/auth/forgot-password` — send reset email
- `POST /api/auth/reset-password/:token` — set new password
- `GET /api/auth/me` — current user (Bearer token)
- `DELETE /api/auth/me` — delete account (requires password, works for active/inactive users)
- `GET /api/files?parentId=...` — list files/folders
- `POST /api/files/folder` — create folder
- `POST /api/files/upload` — upload file (multipart)
- `GET /api/files/download/:id` — get presigned download URL
- `DELETE /api/files/:id` — delete file or folder
  Rahul - [GitHub Profile](https://github.com/rahulstox)

Project Link: [https://github.com/rahulstox/googledrive-backend](https://github.com/rahulstox/googledrive-backend)
