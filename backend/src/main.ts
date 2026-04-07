import { createApp } from "./server.js";
import { CopilotClientManager } from "./analysis/copilot-client.js";
import { JobManager } from "./analyze/job-manager.js";

const PORT = process.env["PORT"] ?? 3000;

const app = createApp({
  clientManager: new CopilotClientManager(),
  jobManager: new JobManager(),
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
