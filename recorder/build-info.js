'use strict';

// Identity of the code that is running. CI stamps package.json before packaging (see
// .github/workflows/windows-capture-spike.yml): the version becomes 1.x.y-capture.<run> and
// `kernBuild` records the commit. A dev checkout reports its plain version and "dev".
// The label is shown in the recorder window, sent with every status, and written by the
// native helper into each recording manifest, so "which build produced this?" is never a guess.
function readBuildInfo(pkg = require('../package.json')) {
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  const build = pkg.kernBuild && typeof pkg.kernBuild === 'object' ? pkg.kernBuild : {};
  const sha = typeof build.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(build.sha) ? build.sha.slice(0, 7).toLowerCase() : 'dev';
  const run = Number.isSafeInteger(Number(build.run)) && Number(build.run) > 0 ? Number(build.run) : null;
  const builtAt = typeof build.builtAt === 'string' ? build.builtAt : null;
  return { version, sha, run, builtAt, label: `${version}+${sha}` };
}

module.exports = { readBuildInfo };
