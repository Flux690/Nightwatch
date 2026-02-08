import { Router } from "express";
import multer from "multer";
import { uploadVideo, getVideoById, listVideos } from "../controllers/videoController.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/upload", upload.single("video"), uploadVideo);
router.get("/:id", getVideoById);
router.get("/", listVideos);

export default router;
