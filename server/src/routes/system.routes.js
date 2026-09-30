import { Router } from 'express';
import { health, models } from '../controllers/system.controller.js';

const router = Router();

router.get('/health', health);
router.get('/models', models);

export default router;
