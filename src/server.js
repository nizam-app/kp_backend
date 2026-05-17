import { createServer } from "http";
// Load `.env` before `app` so optional modules (e.g. Cloudinary) see process.env at import time.
import { env } from "./config/env.js";
import app from "./app.js";
import { connectDB } from "./config/db.js";
import { initRealtimeServer } from "./realtime/socket.js";

let server;

const start = async () => {
  await connectDB();

  const httpServer = createServer(app);
  initRealtimeServer(httpServer);

  // Prefer explicit HOST if set (even in production). Defaults to 0.0.0.0 for LAN access.
  const host = `${env.HOST || ""}`.trim() || "0.0.0.0";
  server = httpServer.listen(env.PORT, host, () => {
    console.log(`Server running on ${host}:${env.PORT} (${env.NODE_ENV})`);
  });
};

start();

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
  if (server) server.close(() => process.exit(1));
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  if (server) server.close(() => process.exit(1));
  process.exit(1);
});
