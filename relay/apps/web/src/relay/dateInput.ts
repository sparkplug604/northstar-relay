/** An unchanged source timestamp keeps its original instant, including an explicit
 * offset during a repeated daylight-saving hour and sub-minute precision. */
export function localDateInput(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
}
export function reviewedTimestamp(value: string, original: string | undefined): string {
  if (original && Number.isFinite(Date.parse(original)) && Date.parse(`${value}Z`) === Date.parse(`${localDateInput(original)}Z`)) return original;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("invalid_timestamp");
  return timestamp.toISOString();
}
