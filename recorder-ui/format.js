'use strict';
window.recorderFormat = Object.freeze({
  duration(milliseconds) {
    const total = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
  },
  bytes(bytes) {
    if (!Number.isFinite(bytes)) return 'Disk space unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Math.max(0, bytes);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
  },
  error(value) {
    if (typeof value === 'string') return value;
    return value?.message || value?.code || 'Something went wrong. Please retry.';
  },
});
