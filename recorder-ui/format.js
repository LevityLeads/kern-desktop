'use strict';

window.recorderFormat = Object.freeze({
  // 12:34, or 1:02:03 past the hour.
  clock(milliseconds) {
    const total = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  },
  minutes(milliseconds) {
    const minutes = Math.round((Number(milliseconds) || 0) / 60000);
    return minutes < 1 ? 'under a minute' : `${minutes} min`;
  },
  date(iso) {
    const date = iso ? new Date(iso) : null;
    if (!date || Number.isNaN(date.getTime())) return 'Unknown date';
    return date.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  },
  // IPC rejections arrive as "Error invoking remote method '...': Error: <message>".
  error(value) {
    const raw = typeof value === 'string' ? value : value?.message || 'Something went wrong. Please try again.';
    return raw.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');
  },
});
