import express from "express";
import cors from "cors";
import type { AnalysisResult } from "@route-atlas/shared";

const app = express();

// TODO: Lock down CORS origin before deployment (currently allows all origins)
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  const healthCheck: { status: string; timestamp: string } = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
  res.json(healthCheck);
});

// Placeholder endpoint for future analysis feature
app.post("/api/analyze", (_req, res) => {
  const placeholder: AnalysisResult = {
    framework: "unknown",
    screens: [],
    transitions: [],
  };
  res.json(placeholder);
});

export { app };
