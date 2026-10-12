// ------------------------------------------------------------------
// Native context menu for editable fields (spelling + clipboard).
//
// Only editable targets get a menu here. For everything else the web
// app draws its own, so we stay out of the way.
// ------------------------------------------------------------------
const { BrowserWindow, Menu } = require('electron');

/**
 * Build the menu template for a context-menu event on an editable
 * field. Pure data, no side effects until an item is clicked.
 */
function buildEditTemplate(webContents, params) {
  const flags = params.editFlags || {};
  const template = [];

  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions || [];
    if (suggestions.length) {
      for (const suggestion of suggestions) {
        template.push({
          label: suggestion,
          click: () => webContents.replaceMisspelling(suggestion),
        });
      }
    } else {
      template.push({ label: 'No suggestions', enabled: false });
    }
    template.push({
      label: 'Add to dictionary',
      click: () => webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    template.push({ type: 'separator' });
  }

  template.push(
    { role: 'cut', enabled: !!flags.canCut },
    { role: 'copy', enabled: !!flags.canCopy },
    { role: 'paste', enabled: !!flags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', enabled: !!flags.canSelectAll }
  );

  return template;
}

/** Show the native edit menu on `webContents` for right-clicks in editable fields. */
function attachEditMenu(webContents) {
  webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return;
    const menu = Menu.buildFromTemplate(buildEditTemplate(webContents, params));
    menu.popup({ window: BrowserWindow.fromWebContents(webContents) || undefined });
  });
}

module.exports = { attachEditMenu, buildEditTemplate };
