'use strict';

const { pathToFileURL } = require('node:url');
const { CallError, boundedFile, sourceManifest, fail } = require('./call-files');
const { validateDerived, uploadInventory } = require('./call-derived');
const { renderCall } = require('./call-render');
const { downloadTranscript } = require('./call-transcript');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function bind(processor, state) {
  // Owner and storage origin are pinned once, before any remote object is created,
  // and never allowed to silently change across Kern installations.
  const identity = await processor.http.identity(state.origin, { signal: processor.abort.signal });
  if (state.ownerId && state.ownerId !== identity.ownerId) {
    throw new CallError('origin-changed', 'This call belongs to another Kern account. Cloud processing is paused.');
  }
  if (state.storageOrigin && identity.storageOrigin && state.storageOrigin !== identity.storageOrigin) {
    throw new CallError('origin-changed', 'Kern storage changed. Cloud processing is paused.');
  }
  state.ownerId = identity.ownerId;
  state.storageOrigin = identity.storageOrigin || state.storageOrigin || null;
  await processor.save(state);
}

async function processCall(processor, state) {
  const { store, http } = processor;
  const signal = processor.abort.signal;
  const id = state.sessionId, dir = await store.directory(id);
  if (state.cloudHold && !state.preparePending) return;
  if (state.remoteId && state.uploadFinalized && !state.preparePending && !state.explicitRetry) {
    if (state.origin !== http.origin()) throw new CallError('origin-changed', 'Kern connection changed. Cloud synchronization is paused.');
    const api = (route, options = {}) => http.api(state.origin, route, { ...options, signal, ownerId: state.ownerId });
    await pollCall(processor, state, api, `/api/calls/${state.remoteId}`);
    return;
  }
  let validated;
  state.state = 'preparing'; state.error = null;
  await processor.save(state);
  try { validated = await validateDerived(dir, id, { signal }); }
  catch (error) {
    if (signal.aborted) throw new CallError('cancelled', 'Processing paused.');
    await sourceManifest(dir, id, signal);
    await renderCall(processor.helperPath, dir, { signal, spawnProcess: processor.spawnProcess });
    validated = await validateDerived(dir, id, { signal });
  }
  if (state.remoteId && state.fingerprint !== validated.fingerprint) {
    throw new CallError('conflict', 'Recording changed after upload. Existing cloud files were not overwritten.');
  }
  state.fingerprint = validated.fingerprint;
  state.playbackReady = true;
  state.playbackUrl = pathToFileURL(validated.playbackFile).toString();
  state.preparePending = false;
  state.warnings = validated.derived.warnings;
  state.state = 'ready'; state.progress = 1;
  await processor.save(state);
  if (!state.requested || !state.consent || state.cloudHold) return;
  if (!state.origin || state.origin !== http.origin()) throw new CallError('origin-changed', 'Kern connection changed. Cloud upload is paused.');
  await bind(processor, state);
  const inventory = await uploadInventory(dir, id, validated, signal);
  state.durationMs = inventory.sealed.durationMs;
  const api = (route, options = {}) => http.api(state.origin, route, { ...options, signal, ownerId: state.ownerId });
  if (!state.remoteId) {
    const result = await api('/api/calls', { method: 'POST', body: inventory.sealed });
    if (!UUID.test(result.id)) fail('protocol', 'Kern returned an invalid call identity.');
    state.remoteId = result.id;
    // Persist remote identity before requesting any upload capabilities.
    await processor.save(state);
  }
  const prefix = `/api/calls/${state.remoteId}`;
  let status = await api(prefix);
  if (status.state === 'uploading') {
    state.state = 'uploading'; state.progress = 0;
    await processor.save(state);
    for (const file of inventory.files) {
      signal.throwIfAborted();
      if (state.uploaded.includes(file.object.id)) continue;
      const permission = await api(`${prefix}/upload`, { method: 'POST', body: { objectId: file.object.id } });
      const bytes = await boundedFile(dir, file.relativePath, file.object, signal);
      try { await http.upload(permission.signedUrl, bytes, { signal, storageOrigin: state.storageOrigin }); }
      catch (error) {
        // Lost acknowledgements may leave an immutable object already stored. Final validation owns bytes/hash.
        if (error.code !== 'conflict') throw error;
      }
      state.uploaded.push(file.object.id);
      state.progress = state.uploaded.length / inventory.files.length;
      await processor.save(state);
    }
    if ((await sourceManifest(dir, id, signal)).fingerprint !== state.fingerprint) {
      throw new CallError('conflict', 'Recording changed during upload. Cloud processing stopped safely.');
    }
    status = await api(`${prefix}/finalize`, { method: 'POST' });
  }
  state.uploadFinalized = true;
  state.explicitRetry = false;
  await pollCall(processor, state, api, prefix, status);
}
async function pollCall(processor, state, api, prefix, status = null) {
  status ||= await api(prefix);
  if (status.state === 'complete') {
    state.transcript = await downloadTranscript(api, prefix, state.durationMs);
    state.state = 'complete'; state.progress = 1;
    state.requested = false; state.retryCount = 0; state.nextAttemptAt = 0;
    await processor.save(state); return;
  }
  if (['deleting', 'deleted'].includes(status.state)) throw new CallError('deleted', 'This cloud call was deleted. Local audio is still available.');
  if (status.state === 'failed') throw new CallError('cloud-failed', 'Cloud transcription failed. Retry explicitly. Local audio is safe.');
  if (!['validating', 'queued', 'transcribing'].includes(status.state)) fail('protocol', 'Kern returned an invalid call state.');
  state.state = 'transcribing'; state.progress = 0;
  state.retryCount = 0; state.nextAttemptAt = Date.now() + 5000;
  await processor.save(state);
  processor.schedule(state.sessionId, 5000);
}
module.exports = { processCall };
