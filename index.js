// Goldfish Therapy: keeps the physical state of the scene straight, remembers the story,
// and fixes continuity slips in replies. Everything lives in src/.
import { start } from './src/st/main.js';

jQuery(() => {
    start().catch(error => console.error('[Goldfish Therapy] failed to start', error));
});
