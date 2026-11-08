'use strict';

/**
 * Identify tag builds, which require release credentials.
 *
 * A fork without the upstream Last.fm secrets can opt out explicitly; the
 * packaged app then ships with scrobbling unavailable instead of failing the
 * whole release.
 */
function isOfficialBuild(env = process.env) {
  return env.GITHUB_REF_TYPE === 'tag' && env.LIDRA_ALLOW_MISSING_CREDENTIALS !== '1';
}

/** Return whether both credentials exist. Throw for a partial pair or a missing required pair. */
function validateCredentialPair(env, firstName, secondName, required = false) {
  const firstPresent = typeof env[firstName] === 'string' && env[firstName].trim() !== '';
  const secondPresent = typeof env[secondName] === 'string' && env[secondName].trim() !== '';

  if (firstPresent !== secondPresent) {
    throw new Error(`${firstName} and ${secondName} must be set together.`);
  }
  if (required && !firstPresent) {
    throw new Error(`${firstName} and ${secondName} are required for tag builds.`);
  }

  return firstPresent;
}

module.exports = { isOfficialBuild, validateCredentialPair };
