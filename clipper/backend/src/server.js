import express from "express";
import cors from "cors";
import videoRoutes from "./routes/videoRoutes.js";
import { log } from "./utils/log.js";
import { startOrphanRecovery } from "./orphanRecovery.js";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.use("/api/videos", videoRoutes);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  log("info", { event: "server_started", port: PORT });
  startOrphanRecovery();
});
