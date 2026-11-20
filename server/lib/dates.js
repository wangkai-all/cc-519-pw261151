'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) throw new Error(`invalid ISO date: ${value}`);
    return m[1];
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  throw new Error(`invalid date: ${String(value)}`);
}

function parse(iso) {
  return new Date(`${toIso(iso)}T00:00:00Z`);
}

function addDays(iso, days) {
  return new Date(parse(iso).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function diffDays(fromIso, toIsoDate) {
  return Math.round((parse(toIsoDate) - parse(fromIso)) / DAY_MS);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function inRange(iso, from, to) {
  if (from && iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

function daysBetweenInclusive(from, to) {
  return Math.max(0, diffDays(from, to));
}

function eachDay(from, to) {
  const days = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < 3660) {
    days.push(cur);
    cur = addDays(cur, 1);
    guard += 1;
  }
  return days;
}

function monthKey(iso) {
  return iso.slice(0, 7);
}

module.exports = {
  DAY_MS,
  toIso,
  parse,
  addDays,
  diffDays,
  todayIso,
  inRange,
  daysBetweenInclusive,
  eachDay,
  monthKey,
};
