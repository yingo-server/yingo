/** GET /api/config — 公开配置，纯只读 */
import { handler as wrapHandler, ok } from './_lib/response.mjs';
import { loadPublicConfig } from './_lib/config.mjs';

export const handler = wrapHandler(async () => ok(await loadPublicConfig()));
