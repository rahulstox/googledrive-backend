import "dotenv/config";
import { validateEnv } from "./config/env.js";
import { connectDB } from "./config/db.js";
import { app } from "./app.js";
import { startCronJobs } from "./services/cronService.js";

validateEnv();

// Wrap in async IIFE to handle top-level await if needed, but modern Node supports it.
// However, better to keep it simple.
await connectDB();
startCronJobs();

const PORT = parseInt(process.env.PORT, 10) || 5000;

const server = app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error("To fix: close the other terminal running the backend.");
    console.error(
      "Or find and kill the process: netstat -ano | findstr :5000  then  taskkill /PID <pid> /F\n"
    );
    process.exit(1);
  }
  throw err;
});
