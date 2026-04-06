import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "./server.js";

describe("Express endpoints", () => {
  it("GET /api/health returns 200 with status ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
  });

  it("POST /api/analyze returns 200 with placeholder result", async () => {
    const res = await request(app).post("/api/analyze");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("framework", "unknown");
    expect(res.body).toHaveProperty("screens");
    expect(res.body).toHaveProperty("transitions");
  });
});
