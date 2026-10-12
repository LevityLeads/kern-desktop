const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// edit-menu.js requires 'electron', which only exists inside Electron.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { BrowserWindow: { fromWebContents: () => null }, Menu: { buildFromTemplate: (t) => ({ t, popup() {} }) } };
  return origLoad.call(this, request, ...rest);
};
const { buildEditTemplate, attachEditMenu } = require('../edit-menu');
Module._load = origLoad;

const allFlags = { canCut: true, canCopy: false, canPaste: true, canSelectAll: true };

test('plain editable field: cut/copy/paste/select all with enabled state from editFlags', () => {
  const t = buildEditTemplate({}, { isEditable: true, editFlags: allFlags });
  assert.deepEqual(t.map((i) => i.role || i.type), ['cut', 'copy', 'paste', 'separator', 'selectAll']);
  assert.deepEqual(t.filter((i) => i.role).map((i) => i.enabled), [true, false, true, true]);
});

test('misspelled word: suggestions, add to dictionary, then clipboard items', () => {
  const calls = [];
  const wc = { replaceMisspelling: (s) => calls.push(['replace', s]), session: { addWordToSpellCheckerDictionary: (w) => calls.push(['add', w]) } };
  const t = buildEditTemplate(wc, { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], editFlags: allFlags });
  assert.deepEqual(t.slice(0, 4).map((i) => i.label || i.type), ['the', 'ten', 'Add to dictionary', 'separator']);
  t[0].click();
  t[2].click();
  assert.deepEqual(calls, [['replace', 'the'], ['add', 'teh']]);
});

test('misspelled word with no suggestions shows a disabled placeholder', () => {
  const t = buildEditTemplate({}, { isEditable: true, misspelledWord: 'zzqx', dictionarySuggestions: [], editFlags: allFlags });
  assert.equal(t[0].label, 'No suggestions');
  assert.equal(t[0].enabled, false);
  assert.equal(t[1].label, 'Add to dictionary');
});

test('attachEditMenu ignores non-editable targets', () => {
  let handler;
  let popped = 0;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { BrowserWindow: { fromWebContents: () => null }, Menu: { buildFromTemplate: () => ({ popup: () => popped++ }) } };
    return origLoad.call(this, request, ...rest);
  };
  delete require.cache[require.resolve('../edit-menu')];
  const fresh = require('../edit-menu');
  Module._load = origLoad;

  fresh.attachEditMenu({ on: (name, h) => { assert.equal(name, 'context-menu'); handler = h; } });
  handler({}, { isEditable: false, editFlags: allFlags });
  assert.equal(popped, 0);
  handler({}, { isEditable: true, editFlags: allFlags });
  assert.equal(popped, 1);
});
