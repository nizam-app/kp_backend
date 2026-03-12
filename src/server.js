import app from "./app.js";
import { env } from "./config/env.js";
import { connectDB } from "./config/db.js";

let server;

const start = async () => {
  await connectDB();

  server = app.listen(env.PORT, env.HOST, () => {
    console.log(`Server running on ${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
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
