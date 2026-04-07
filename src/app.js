import express from "express";
import cors from "cors";
import routes from "./routes/index.js";
import { notFound } from "./middlewares/notFound.js";
import { globalError } from "./middlewares/globalError.js";

const app = express();

app.use(cors());
app.use(
  "/api/v1/billing/stripe/webhook",
  express.raw({ type: "application/json" })
);
app.use(express.json());

app.get("/", (_req, res) =>
  res.json({
    status: "success",
    message: "API is running",
    docs: "/api/v1",
    health: "/health",
  })
);

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/v1", routes);

app.get("/api/v1", (_req, res) =>
  res.json({
    status: "success",
    message: "API v1 base route",
    endpoints: {
      auth: "/api/v1/auth",
      users: "/api/v1/users",
    },
  })
);

app.use(notFound);
app.use(globalError);

export default app;
