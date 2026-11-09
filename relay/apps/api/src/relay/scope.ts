import { RelayStoreError } from '../../../../packages/relay-storage-postgres/src/index.js';
import type { RelayAuth } from './auth.js';

export function authorizeBranch(auth: RelayAuth, branchId: string): void {
  if (auth.user.role !== 'organization_admin' && auth.user.branchId !== branchId) throw new RelayStoreError('branch_forbidden', 'This branch is not available to your account', 403);
}
