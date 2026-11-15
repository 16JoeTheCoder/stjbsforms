import { Hono } from "hono";
import { requireRole, sameOrigin, type AppEnv } from "./auth";
import { ApiError, errorResponse } from "./lib/http";
import { publicRoutes } from "./routes/public";
import { reviewRoutes } from "./routes/review";
import { adminNotes } from "./routes/admin-notes";
import { adminManage } from "./routes/admin-manage";
import type { Me } from "../shared/types";

const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("x-frame-options", "DENY");
  h.set("cross-origin-resource-policy", "same-origin");
  if (!h.has("cache-control")) h.set("cache-control", "no-store");
  // No CORS headers are ever emitted: the API is same-origin only.
});

app.use("/api/*", sameOrigin);

app.route("/api/public", publicRoutes);

app.get("/api/me", requireRole("admin", "reviewer"), (c) => {
  const u = c.get("user");
  const body: Me = { id: u.id, email: u.email, role: u.role, isOwner: u.isOwner, logoutUrl: "/cdn-cgi/access/logout" };
  return c.json(body);
});

app.route("/api/review", reviewRoutes);

const admin = new Hono<AppEnv>();
admin.use("*", requireRole("admin"));
admin.route("/", adminNotes);
admin.route("/", adminManage);
app.route("/api/admin", admin);

app.all("/api/*", () => {
  throw new ApiError(404, "NOT_FOUND", "Not found");
});

app.onError((err) => errorResponse(err));

// Anything not under /api is served by Workers Static Assets (SPA fallback).
app.all("*", (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound()));

export default app;
