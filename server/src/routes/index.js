import { Router } from 'express';
import detectionRoutes from './detection.routes.js';
import filterRoutes from './filter.routes.js';
import missionRoutes from './mission.routes.js';
import scanRoutes from './scan.routes.js';
import systemRoutes from './system.routes.js';
import uploadRoutes from './upload.routes.js';

const router = Router();

router.use('/', systemRoutes);          // /api/health, /api/models
router.use('/missions', missionRoutes);
router.use('/scans', scanRoutes);
router.use('/detections', detectionRoutes);
router.use('/filter', filterRoutes);
router.use('/uploads', uploadRoutes);

export default router;
