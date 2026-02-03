# Drive Backend

Node.js/Express backend for the Drive application. Handles authentication, file management, and S3 interactions.

## Features

- **Authentication**:
  - JWT-based Auth with Access Tokens.
  - Secure Password Hashing (Bcrypt).
  - Email Activation Flow (Nodemailer).
  - Secure Forgot/Reset Password flows (Token-based).
- **File System**:
  - **Storage**: Private AWS S3 Bucket.
  - **Uploads**: Multipart/form-data support (Multer) with streaming directly to S3.
  - **Downloads**: Secure Presigned URLs (Time-limited access).
  - **Organization**: Recursive folder structures, Soft Delete (Trash), and Restoration.
- **Security**:
  - Helmet (Headers), CORS, Rate Limiting.
  - Input Validation (Express Validator).
  - Ownership checks on all resources.

## Tech Stack

- **Runtime**: Node.js (ES Modules)
- **Framework**: Express.js
- **Database**: MongoDB Atlas (Mongoose ODM)
- **Storage**: AWS S3 SDK v3
- **Tools**: `multer-s3`, `nodemailer`, `node-cron`

## Setup & Installation

### 1. Prerequisites
- Node.js (v16+)
- MongoDB Connection String (Atlas or Local)
- AWS S3 Bucket (Private) & IAM Credentials

### 2. Install Dependencies
```bash
npm install
```

### 3. Environment Configuration
Create a `.env` file in the root directory:

```env
PORT=5000
NODE_ENV=development
FRONTEND_URL=http://localhost:5173

# Database
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/drive

# JWT
JWT_SECRET=your_super_secret_key_min_32_chars
JWT_EXPIRES_IN=7d

# AWS S3
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1
S3_BUCKET_NAME=your-bucket-name

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password
EMAIL_FROM=noreply@drive.com
```

### 4. Run Server
- **Development**:
  ```bash
  npm run dev
  ```
- **Production**:
  ```bash
  npm start
  ```

## API Documentation

The API runs at `/api` (e.g., `http://localhost:5000/api`).

- **Auth**: `/auth/register`, `/auth/login`, `/auth/activate/:token`, `/auth/forgot-password`
- **Files**: `/files`, `/files/upload`, `/files/folder`, `/files/download/:id`, `/files/trash`

## Testing

Run unit and integration tests:
```bash
npm test
```
