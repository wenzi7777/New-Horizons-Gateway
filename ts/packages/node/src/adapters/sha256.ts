import { createHash } from 'node:crypto';

import type { Sha256 } from '@nhgw/core';

export const nodeSha256: Sha256 = async (data) => createHash('sha256').update(data).digest('hex');
