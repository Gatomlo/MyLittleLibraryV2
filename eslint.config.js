// Verification statique : npm run lint. Regles volontairement sobres : les erreurs
// reelles (variable inconnue, import oublie, code mort), pas le style.
const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-useless-escape': 'off',
  'no-control-regex': 'off',
  'no-misleading-character-class': 'off',
};

module.exports = [
  { ignores: ['node_modules/', 'data/', 'public/vendor/'] },
  {
    // Serveur, scripts et tests (CommonJS, Node).
    files: ['server.js', 'eslint.config.js', 'lib/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: globals.node },
    rules,
  },
  {
    // Interface : modules ES du navigateur.
    files: ['public/app/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.browser },
    rules,
  },
  {
    // Scripts classiques du navigateur : widget WordPress, service worker.
    files: ['public/embed.js', 'public/sw.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: { ...globals.browser, ...globals.serviceworker } },
    rules,
  },
];
