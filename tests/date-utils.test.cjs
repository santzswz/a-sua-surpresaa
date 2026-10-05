const test = require('node:test');
const assert = require('node:assert/strict');
const dates = require('../assets/js/date-utils.js');

test('birthday changes at Brazil midnight and rolls into the next year', () => {
  const before = dates.birthday(new Date('2026-10-15T02:59:59Z'));
  assert.equal(before.isBirthday, false);
  assert.equal(before.seconds, 1);
  assert.equal(before.year, 2026);
  const birthday = dates.birthday(new Date('2026-10-15T03:00:00Z'));
  assert.equal(birthday.isBirthday, true);
  assert.deepEqual([birthday.days, birthday.hours, birthday.minutes, birthday.seconds], [0, 0, 0, 0]);
  const after = dates.birthday(new Date('2026-10-16T03:00:00Z'));
  assert.equal(after.isBirthday, false);
  assert.equal(after.year, 2027);
  assert.equal(after.target.toISOString(), '2027-10-15T03:00:00.000Z');
});
test('relationship duration respects the exact original hour and cannot go negative', () => {
  const early = dates.elapsed(dates.STORY_START, new Date('2025-05-08T22:59:59Z'));
  assert.deepEqual(early, { days: 0, hours: 0, minutes: 0, seconds: 0, calendar: { years: 0, months: 0, days: 0 } });
  assert.deepEqual(dates.calendarDifference(dates.STORY_START, new Date('2025-06-08T22:59:59Z')),
    { years: 0, months: 0, days: 30 });
  assert.deepEqual(dates.calendarDifference(dates.STORY_START, new Date('2025-06-08T23:00:00Z')),
    { years: 0, months: 1, days: 0 });
  assert.equal(dates.STORY_START.toISOString(), '2025-05-08T23:00:00.000Z');
});
test('calendar months clamp to short months without negative days', () => {
  const january = new Date('2025-01-31T20:00:00-03:00');
  assert.deepEqual(dates.calendarDifference(january, new Date('2025-02-28T20:00:00-03:00')),
    { years: 0, months: 1, days: 0 });
  assert.deepEqual(dates.calendarDifference(january, new Date('2025-03-01T20:00:00-03:00')),
    { years: 0, months: 1, days: 1 });
  assert.deepEqual(dates.calendarDifference(new Date('2024-02-29T20:00:00-03:00'), new Date('2025-02-28T20:00:00-03:00')),
    { years: 1, months: 0, days: 0 });
});
