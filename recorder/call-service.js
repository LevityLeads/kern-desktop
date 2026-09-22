'use strict';

const fs = require('node:fs');
const path = require('node:path');
const catalog = require('./session-catalog');
const { isActiveState } = require('./protocol');
const { callSummary, callView } = require('./call-view-model');
const { toMarkdown, toPlainText } = require('./transcript-model');
const { readJsonFile } = require('./safe-fs');

// Read side of the recorder window: the calls list, one call's view, copy and diagnostics.
// Summaries are cached per folder and only rebuilt when a file in it changes, so a list refresh
// never re-parses every stored transcript.
class CallService {
  constructor({ root, pipeline, supervisor }) {
    this.root = root;
    this.pipeline = pipeline;
    this.supervisor = supervisor;
    this.summaries = new Map();
  }

  liveFor(sessionId) {
    const status = this.supervisor.status;
    return status.sessionId === sessionId && isActiveState(status.state) ? status : null;
  }

  async stamp(sessionId) {
    const dir = await catalog.sessionDir(this.root, sessionId);
    const parts = await Promise.all(Object.values(catalog.FILES).map(name =>
      fs.promises.stat(path.join(dir, name)).then(s => `${s.mtimeMs}:${s.size}`, () => '-')));
    return parts.join('|');
  }

  async gather(sessionId) {
    const kind = await catalog.sessionKind(this.root, sessionId);
    if (kind === 'none') return null;
    if (kind === 'v1') return { sessionId, kind, legacy: await catalog.readLegacy(this.root, sessionId) };
    const session = await catalog.readSession(this.root, sessionId).catch(() => null);
    let state = null;
    let damage = this.pipeline.damage(sessionId);
    try { state = await this.pipeline.store.load(sessionId); }
    catch (error) { damage ||= { code: 'invalid-state', message: error.message, retry: false }; }
    return { sessionId, kind, session, state, damage, tail: this.pipeline.tail(sessionId), live: this.liveFor(sessionId) };
  }

  async summary(sessionId) {
    const live = this.liveFor(sessionId);
    const stamp = live ? null : await this.stamp(sessionId);
    const cached = this.summaries.get(sessionId);
    if (stamp && !this.pipeline.damage(sessionId) && cached?.stamp === stamp) return cached.summary;
    const input = await this.gather(sessionId);
    const summary = input ? callSummary(input) : null;
    if (stamp) this.summaries.set(sessionId, { stamp, summary });
    return summary;
  }

  async list() {
    const ids = await catalog.listSessionIds(this.root);
    const summaries = await Promise.all(ids.map(id => this.summary(id).catch(() => null)));
    for (const id of this.summaries.keys()) if (!ids.includes(id)) this.summaries.delete(id);
    return summaries.filter(Boolean)
      .sort((a, b) => String(b.startedAtUtc || '').localeCompare(String(a.startedAtUtc || '')));
  }

  async get(sessionId) {
    const input = await this.gather(sessionId);
    if (!input) throw new Error('This call no longer exists.');
    return callView(input);
  }

  heading(view) {
    const date = view.startedAtUtc ? new Date(view.startedAtUtc).toLocaleString() : 'Call';
    const minutes = Math.max(1, Math.round(view.durationMs / 60000));
    return { title: view.title || date, subtitle: `${view.title ? `${date} · ` : ''}${minutes} min` };
  }

  async transcriptText(sessionId, format) {
    const view = await this.get(sessionId);
    if (!view.items.length) throw new Error('There is no transcript to copy yet.');
    const { title, subtitle } = this.heading(view);
    return format === 'markdown'
      ? toMarkdown(view.items, { title, subtitle })
      : toPlainText(view.items, { heading: `${title}\n${subtitle}` });
  }

  // Support bundle: the helper's session.json and this app's call.json (transcript text left
  // out), plus the build and recorder status. No audio, no transcript content.
  async diagnostics(sessionId) {
    const { levels, ...status } = this.supervisor.snapshot();
    const report = { build: status.build, recorder: status };
    if (sessionId) {
      const dir = await catalog.sessionDir(this.root, sessionId);
      const read = name => readJsonFile(dir, name, 1024 * 1024 * 16).catch(error => ({ unreadable: error.code || error.message }));
      const call = await read(catalog.FILES.CALL);
      if (call?.transcript?.windows) call.transcript = { windows: call.transcript.windows.length };
      report.session = await read(catalog.FILES.SESSION);
      report.call = call;
      report.audioFrames = await catalog.audioFrames(this.root, sessionId).catch(() => null);
      report.pipelineError = this.pipeline.damage(sessionId);
    }
    return JSON.stringify(report, null, 2);
  }

  // The Kern thread holding this call's summary, if Kern has posted one.
  async summaryUrl(sessionId) {
    const state = await this.pipeline.store.load(sessionId);
    const url = state?.cloud?.kernThreadUrl;
    if (!url) throw new Error('Kern has not posted a summary for this call yet.');
    return { url, origin: state.origin };
  }
}

module.exports = { CallService };
