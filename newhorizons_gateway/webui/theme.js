// Light or dark, the same way the Desktop app does it (frontend/src/lib/
// theme.tsx + sunTimes.ts): "auto" follows sunrise and sunset at the lab,
// "light"/"dark" are fixed; the choice is remembered per browser. The
// <head> of index.html already applied the last theme before first paint.
(function () {
  "use strict";

  // The lab: Aizu-Wakamatsu, Fukushima.
  const LAB_LOCATION = { latitude: 37.5236, longitude: 139.9381 };
  // Official sunrise/sunset: the sun's centre 50' below the horizon.
  const ZENITH = 90.833;
  const MODE_KEY = "nh-theme-mode";
  const LAST_THEME_KEY = "nh-theme-last";
  const MODES = ["auto", "light", "dark"];

  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const wrap = (value, range) => ((value % range) + range) % range;

  function dayOfYear(date) {
    const start = Date.UTC(date.getFullYear(), 0, 0);
    const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((today - start) / 86400000);
  }

  // Sunrise (rising) or sunset on `date`'s local day, or null on polar
  // day/night. The usual almanac algorithm, accurate to a minute or two.
  function sunEvent(date, rising, location) {
    const { latitude, longitude } = location || LAB_LOCATION;
    const lngHour = longitude / 15;
    const t = dayOfYear(date) + ((rising ? 6 : 18) - lngHour) / 24;
    const meanAnomaly = 0.9856 * t - 3.289;
    const trueLongitude = wrap(
      meanAnomaly + 1.916 * Math.sin(rad(meanAnomaly)) + 0.02 * Math.sin(rad(2 * meanAnomaly)) + 282.634,
      360,
    );
    let rightAscension = wrap(deg(Math.atan(0.91764 * Math.tan(rad(trueLongitude)))), 360);
    rightAscension += Math.floor(trueLongitude / 90) * 90 - Math.floor(rightAscension / 90) * 90;
    rightAscension /= 15;
    const sinDec = 0.39782 * Math.sin(rad(trueLongitude));
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosHour = (Math.cos(rad(ZENITH)) - sinDec * Math.sin(rad(latitude))) / (cosDec * Math.cos(rad(latitude)));
    if (cosHour > 1 || cosHour < -1) return null;
    const hourAngle = (rising ? 360 - deg(Math.acos(cosHour)) : deg(Math.acos(cosHour))) / 15;
    const localMeanTime = hourAngle + rightAscension - 0.06571 * t - 6.622;
    const utcHours = wrap(localMeanTime - lngHour, 24);
    // UTC hours can land on the neighbouring local day: pull them back in.
    const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    let when = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + utcHours * 3600000;
    while (when < localMidnight) when += 86400000;
    while (when >= localMidnight + 86400000) when -= 86400000;
    return new Date(when);
  }

  // Whether it is daytime at `now`, and when that next changes -- the
  // Desktop's daylightAt() (sunTimes.ts).
  function daylightAt(now) {
    const sunrise = sunEvent(now, true);
    const sunset = sunEvent(now, false);
    if (!sunrise || !sunset) return { day: true, nextChange: null };
    if (now < sunrise) return { day: false, nextChange: sunrise };
    if (now < sunset) return { day: true, nextChange: sunset };
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { day: false, nextChange: sunEvent(tomorrow, true) };
  }

  function isDaytime(now) {
    return daylightAt(now).day;
  }

  function readMode() {
    try {
      const stored = window.localStorage.getItem(MODE_KEY);
      return MODES.includes(stored) ? stored : "auto";
    } catch (error) {
      return "auto";
    }
  }

  let mode = readMode();
  let listener = null;
  let fadeTimer = 0;

  function resolvedTheme() {
    if (mode === "light" || mode === "dark") return mode;
    return isDaytime(new Date()) ? "light" : "dark";
  }

  function apply() {
    const root = document.documentElement;
    const theme = resolvedTheme();
    if (root.dataset.theme !== theme) {
      // Ease the swap so a whole screen does not flash white to black.
      root.classList.add("theme-fading");
      root.dataset.theme = theme;
      window.clearTimeout(fadeTimer);
      fadeTimer = window.setTimeout(() => root.classList.remove("theme-fading"), 400);
      try {
        window.localStorage.setItem(LAST_THEME_KEY, theme);
      } catch (error) {
        // Storage may be unavailable; the next first paint is then light.
      }
    }
    if (listener) listener(mode, theme);
  }

  function cycle() {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch (error) {
      // Private windows may refuse storage; the choice lasts this visit.
    }
    apply();
  }

  window.NHGTheme = {
    // `onChange(mode, theme)` runs now and after every change.
    start(onChange) {
      listener = onChange;
      apply();
      // Once a minute: catches sunrise/sunset, and a laptop waking up.
      window.setInterval(apply, 60000);
    },
    cycle,
    mode: () => mode,
    theme: resolvedTheme,
    // When Auto next switches, or null outside Auto.
    nextChange: () => (mode === "auto" ? daylightAt(new Date()).nextChange : null),
    sunEvent,
  };
})();
