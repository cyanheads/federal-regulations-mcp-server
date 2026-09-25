/**
 * @fileoverview "Today" for Federal Register comment periods. A comment period
 * runs through 11:59 PM Eastern on the close date the document prints —
 * Regulations.gov encodes the FR close date 2023-05-30 as
 * `2023-05-31T03:59:59Z` — so whether a period is open is decided on the
 * Eastern calendar, not the UTC one. The eCFR tools keep their own UTC `today()`.
 * @module services/federal-register/comment-period
 */

/** Formats an instant as its `YYYY-MM-DD` date in Eastern time (`en-CA` writes ISO order). */
const easternDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's date in `America/New_York` as `YYYY-MM-DD`, following daylight saving time. */
export function easternToday(): string {
  return easternDate.format(new Date());
}

/**
 * Whether a comment period is open on `today` (an Eastern `YYYY-MM-DD`): true
 * through the close day itself, false after it, null when the document prints
 * no close date — "unknown", not "closed".
 */
export function commentPeriodOpen(commentsCloseOn: string | null, today: string): boolean | null {
  return commentsCloseOn === null ? null : commentsCloseOn >= today;
}
