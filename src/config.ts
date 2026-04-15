import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.MODEL || 'claude-sonnet-4-20250514',
  maxSteps: parseInt(process.env.MAX_STEPS || '50', 10),
  viewportWidth: parseInt(process.env.VIEWPORT_WIDTH || '1280', 10),
  viewportHeight: parseInt(process.env.VIEWPORT_HEIGHT || '900', 10),
  headless: process.env.HEADLESS === 'true',
  userDataDir: process.env.USER_DATA_DIR || path.resolve(__dirname, '..', '.browser-data'),
  maxContextPairs: parseInt(process.env.MAX_CONTEXT_PAIRS || '12', 10),
  screenshotQuality: parseInt(process.env.SCREENSHOT_QUALITY || '70', 10),
};
