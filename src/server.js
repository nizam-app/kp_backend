import { createServer } from "http";
import app from "./app.js";
import { env } from "./config/env.js";
import { connectDB } from "./config/db.js";
import { initRealtimeServer } from "./realtime/socket.js";

let server;

const start = async () => {
  await connectDB();

  const httpServer = createServer(app);
  initRealtimeServer(httpServer);

  // Cloud hosts (Render, etc.) require listening on 0.0.0.0 and their injected PORT.
  const host = env.NODE_ENV === "production" ? "0.0.0.0" : env.HOST;
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
