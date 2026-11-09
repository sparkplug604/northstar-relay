/** Approved owner policy. Infrastructure expiry still requires deployment evidence. */
export const MAX_BACKUP_RETENTION_DAYS = 30;
export const MAX_ACTIVE_AUDIT_YEARS = 7;

export function backupDeletionDeadline(cancelledAt: string, days = MAX_BACKUP_RETENTION_DAYS): string {
  if (!Number.isInteger(days) || days < 1 || days > MAX_BACKUP_RETENTION_DAYS) {
    throw new Error("Backup retention must be between 1 and 30 days");
  }
  const timestamp = Date.parse(cancelledAt);
  if (!Number.isFinite(timestamp)) throw new Error("Cancellation time must be valid");
  return new Date(timestamp + days * 86_400_000).toISOString();
}

export function mustBlockRestoredTenant(tenantId: string, deletedTenantIds: ReadonlySet<string>): boolean {
  return deletedTenantIds.has(tenantId);
}
