import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import cookieParser from "cookie-parser";
import { isAllowedOrigin } from "./lib/origin";

const app: Express = express();
const isProduction = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
          ip: req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (isProduction) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
app.use(cors({
  origin(origin, callback) {
    callback(null, origin ? (isAllowedOrigin(origin) ? origin : false) : false);
  },
  credentials: true,
}));
app.use((request, response, next) => {
  if (!mutatingMethods.has(request.method)) {
    next();
    return;
  }

  const origin = request.get("origin");
  if (origin && !isAllowedOrigin(origin)) {
    response.status(403).json({ error: "Request origin is not allowed" });
    return;
  }

  next();
});
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(cookieParser());

app.use("/api", router);

export default app;
