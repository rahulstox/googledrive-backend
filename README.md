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
   - `JWT_SECRET`, `JWT_REFRESH_SECRET`
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_BUCKET_NAME`
   - `SMTP_*` for activation and password-reset emails
   - `FRONTEND_URL` for CORS and email links
2. `npm install`
3. `npm run dev` (or `npm start`)

See project root `AWS_S3_SETUP_AND_REQUIREMENTS.md` for S3 and IAM setup.

## API (high level)

- `POST /api/auth/register` — register (inactive until activation)
- `GET /api/auth/activate/:token` — activate account
- `POST /api/auth/login` — login (activated only)
- `POST /api/auth/forgot-password` — send reset email
- `POST /api/auth/reset-password/:token` — set new password
- `GET /api/auth/me` — current user (Bearer token)
- `GET /api/files?parentId=...` — list files/folders
- `POST /api/files/folder` — create folder
- `POST /api/files/upload` — upload file (multipart)
- `GET /api/files/download/:id` — get presigned download URL
- `DELETE /api/files/:id` — delete file or folder
