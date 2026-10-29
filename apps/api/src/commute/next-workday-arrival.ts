/**
 * The arrival reference point of the public-transport Commute_Time: 09:00 on the next working day
 * (8.1).
 *
 * A transit duration is only meaningful relative to a timetable, so 8.1 fixes one. The value goes
 * into {@link TravelDurationRequest.arriveBy}, which the Routing_Provider turns into an
 * arrival-time preference. Everything about it is a calendar statement, which is why it lives in
 * its own module rather than inside the Commute_Service: the Commute_Service passes it on, the
 * property test of task 13.7 drives it directly, and neither of them should have to construct a
 * service to ask what the next working day is.
 *
 * ## Two decisions this module fixes
 *
 * **"Strictly after" is read on the instant, not on the calendar day.** The result is the earliest
 * working-day 09:00 that lies after `now`: for a Monday 08:59 that is the same Monday at 09:00, for
 * a Monday at exactly 09:00:00.000 it is Tuesday. The oracle of Property 17 is what settles the
 * reading — it asks that no working day lie between the input and the result, and skipping a Monday
 * morning that is still three hours away would put one there. It is also the better query: the
 * nearest rush hour is the one whose timetable data is most likely to still be valid.
 *
 * **"Local time" is the time zone of the process.** The Job_Tool runs on the user's own machine in
 * the zone the user lives in, which is the same assumption `parsePublicationDate` already makes for
 * a bare ISO date. So the hour is set through `Date.prototype.setHours`, which resolves 09:00
 * against the host zone including its daylight-saving rules. In Europe/Berlin both transitions
 * happen between 02:00 and 03:00 local, so 09:00 exists on every calendar day and the result's
 * local time is always exactly 09:00:00.000. A zone that moved its clocks across 09:00 would get
 * the instant the platform substitutes for the non-existent local time; that is a deliberate
 * non-concern rather than an oversight.
 *
 * No date library, by the precedent of `parsePublicationDate`: the whole of the calendar arithmetic
 * below is `setDate` and `setHours`, both of which already move over the calendar rather than over a
 * fixed number of milliseconds. Adding 24 hours of milliseconds is the mistake this module must not
 * make — on a transition day it lands at 08:00 or 10:00 — and a library would not prevent it any
 * more cheaply than `setDate` does.
 *
 * Requirements: 8.1.
 */

/** The hour of the arrival reference point in local time (8.1). */
export const TRANSIT_ARRIVAL_HOUR = 9;

/** Monday, as `Date.prototype.getDay` numbers the days. */
const MONDAY = 1;

/** Friday. Together with {@link MONDAY} this is the "Monday to Friday" of 8.1. */
const FRIDAY = 5;

/**
 * The arrival reference point for the public-transport Commute_Time (8.1).
 *
 * @param now The instant the determination is made at, normally `new Date()`. A parameter rather
 *   than a clock read inside, so a Scrape_Run and its tests are reproducible from their inputs.
 * @returns The earliest instant strictly after `now` that falls on a Monday to Friday at 09:00
 *   local time. Never equal to `now`, never in the past.
 * @throws RangeError If `now` carries no valid time value. There is no arrival reference point for
 *   an `Invalid Date`, and silently answering with one derived from the current clock would hide the
 *   caller's bug inside a plausible-looking Commute_Time.
 */
export const nextWorkdayArrival = (now: Date): Date => {
  const reference = now.getTime();

  if (!Number.isFinite(reference)) {
    throw new RangeError('nextWorkdayArrival requires a Date with a valid time value.');
  }

  const arrival = atArrivalHour(new Date(reference));

  if (arrival.getTime() <= reference) {
    // 09:00 of the input's own day has already passed, or is the input itself. "Strictly after"
    // forbids both.
    advanceOneDay(arrival);
  }

  // At most two days are skipped, because Saturday and Sunday are the only non-working days and
  // they are adjacent. The loop therefore runs three times at worst.
  while (!isWorkingDay(arrival)) {
    advanceOneDay(arrival);
  }

  return arrival;
};

/** Whether a date falls on a Monday to Friday (8.1). */
const isWorkingDay = (value: Date): boolean => {
  const weekday = value.getDay();

  return weekday >= MONDAY && weekday <= FRIDAY;
};

/** Moves the given date to 09:00:00.000 local time of its own calendar day. */
const atArrivalHour = (value: Date): Date => {
  value.setHours(TRANSIT_ARRIVAL_HOUR, 0, 0, 0);

  return value;
};

/**
 * Moves the given date to 09:00 local time of the following calendar day.
 *
 * `setDate` crosses month and year ends on its own — day 32 of March is 1 April — so no bounds
 * arithmetic is needed here. The hour is set again afterwards because a day that changes its UTC
 * offset is 23 or 25 hours long: `setDate` keeps the wall-clock time in most zones, but setting it
 * explicitly is what makes the 09:00 promise independent of that detail.
 */
const advanceOneDay = (value: Date): void => {
  value.setDate(value.getDate() + 1);
  atArrivalHour(value);
};
