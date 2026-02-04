import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import passport from "passport";
import authRoutes from "./routes/authRoutes.js";
import fileRoutes from "./routes/fileRoutes.js";
import { checkS3Connection } from "./services/s3Service.js";
import mongoose from "mongoose";
import setupPassport from "./config/passport.js";

const app = express();

app.set("trust proxy", 1);
setupPassport(); // Initialize Passport strategies

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
const allowedOrigins = [
  process.env.FRONTEND_URL,
  "https://googledrive-frontend-seven.vercel.app", // Explicitly allow deployed frontend
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:3000",
].filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(passport.initialize());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { message: "Too many requests. Please try again later." },
});
app.use("/api", limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Too many attempts. Please try again later." },
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/files", fileRoutes);

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/ready", async (req, res) => {
  const mongodb =
    mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  let s3 = "ok";
  try {
    await checkS3Connection();
  } catch (err) {
    s3 = "error";
  }
  const ok = mongodb === "connected" && s3 === "ok";
  res.status(ok ? 200 : 503).json({ ok, mongodb, s3 });
});

export { app };
