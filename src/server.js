import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { validateEnv } from './config/env.js';
import { connectDB } from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import fileRoutes from './routes/fileRoutes.js';
import { checkS3Connection } from './services/s3Service.js';

validateEnv();
await connectDB();

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { message: 'Too many requests. Please try again later.' },
});
app.use('/api', limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: 'Too many attempts. Please try again later.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/ready', async (req, res) => {
  const mongodb = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
  let s3 = 'ok';
  try {
    await checkS3Connection();
  } catch (err) {
    s3 = 'error';
  }
  const ok = mongodb === 'connected' && s3 === 'ok';
  res.status(ok ? 200 : 503).json({ ok, mongodb, s3 });
});

const PORT = parseInt(process.env.PORT, 10) || 5000;

const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error('To fix: close the other terminal running the backend.');
    console.error('Or find and kill the process: netstat -ano | findstr :5000  then  taskkill /PID <pid> /F\n');
    process.exit(1);
  }
  throw err;
});
