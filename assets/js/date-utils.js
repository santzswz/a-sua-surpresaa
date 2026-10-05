(function (root, factory) {
  const dates = factory();
  if (typeof module === 'object' && module.exports) module.exports = dates;
  else root.SurpriseDates = dates;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const OFFSET = -3 * 3600000;
  const STORY_START = new Date('2025-05-08T20:00:00-03:00');

  // The dates in this story belong to Brazil, even when someone visits abroad.
  function parts(date) {
    const shifted = new Date(date.getTime() + OFFSET);
    return {
      year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds(),
      millisecond: shifted.getUTCMilliseconds()
    };
  }
  function atBrazilTime(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
    return new Date(Date.UTC(year, month, day, hour, minute, second, millisecond) - OFFSET);
  }
  function duration(milliseconds) {
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    return { days: Math.floor(seconds / 86400), hours: Math.floor(seconds / 3600) % 24,
      minutes: Math.floor(seconds / 60) % 60, seconds: seconds % 60 };
  }
  function birthday(now = new Date()) {
    const local = parts(now);
    const isBirthday = local.month === 9 && local.day === 15;
    const year = local.month > 9 || (local.month === 9 && local.day > 15) ? local.year + 1 : local.year;
    const target = atBrazilTime(year, 9, 15);
    return { isBirthday, year, currentYear: local.year, target, ...duration(target - now) };
  }
  function anniversary(from, totalMonths) {
    const start = parts(from);
    const first = new Date(Date.UTC(start.year, start.month + totalMonths, 1));
    const year = first.getUTCFullYear();
    const month = first.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return atBrazilTime(year, month, Math.min(start.day, lastDay), start.hour,
      start.minute, start.second, start.millisecond);
  }
  function calendarDifference(from, to) {
    if (to <= from) return { years: 0, months: 0, days: 0 };
    const start = parts(from);
    const end = parts(to);
    let totalMonths = (end.year - start.year) * 12 + end.month - start.month;
    if (anniversary(from, totalMonths) > to) totalMonths -= 1;
    return { years: Math.floor(totalMonths / 12), months: totalMonths % 12,
      days: Math.floor((to - anniversary(from, totalMonths)) / DAY) };
  }
  function elapsed(from, now = new Date()) {
    return { ...duration(now - from), calendar: calendarDifference(from, now) };
  }
  return { STORY_START, parts, atBrazilTime, duration, birthday, calendarDifference, elapsed };
});
