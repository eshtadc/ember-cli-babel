/* eslint-env node */
'use strict';

const VersionChecker = require('ember-cli-version-checker');
const clone = require('clone');
const path = require('path');

let count = 0;

function addBaseDir(Plugin) {
  let type = typeof Plugin;

  if (type === 'function' && !Plugin.baseDir) {
    Plugin.baseDir = () => __dirname;
  } else if (type === 'object' && Plugin !== null && Plugin.default) {
    addBaseDir(Plugin.default);
  }
}

module.exports = {
  name: 'ember-cli-babel',
  configKey: 'ember-cli-babel',

  init: function() {
    this._super.init && this._super.init.apply(this, arguments);

    let checker = new VersionChecker(this);
    let dep = this.emberCLIChecker = checker.for('ember-cli', 'npm');

    this._shouldShowBabelDeprecations = !dep.lt('2.11.0-beta.2');
  },

  buildBabelOptions(_config) {
    let config = _config || this._getAddonOptions();

    return this._getBabelOptions(config);
  },

  _debugTree() {
    if (!this._cachedDebugTree) {
      this._cachedDebugTree = require('broccoli-debug').buildDebugCallback(`ember-cli-babel:${this._parentName()}`);
    }

    return this._cachedDebugTree.apply(null, arguments);
  },

  transpileTree(inputTree, config) {
    let description = `000${++count}`.slice(-3);
    let postDebugTree = this._debugTree(inputTree, `${description}:input`);

    let BabelTranspiler = require('broccoli-babel-transpiler');
    let output = new BabelTranspiler(postDebugTree, this.buildBabelOptions(config));

    return this._debugTree(output, `${description}:output`);
  },

  setupPreprocessorRegistry: function(type, registry) {
    registry.add('js', {
      name: 'ember-cli-babel',
      ext: 'js',
      toTree: (tree) => this.transpileTree(tree)
    });
  },

  _shouldIncludePolyfill: function() {
    let addonOptions = this._getAddonOptions();
    let babelOptions = addonOptions.babel;
    let customOptions = addonOptions['ember-cli-babel'];

    if (this._shouldShowBabelDeprecations && !this._polyfillDeprecationPrinted &&
      babelOptions && 'includePolyfill' in babelOptions) {

      this._polyfillDeprecationPrinted = true;

      // we can use writeDeprecateLine() here because the warning will only be shown on newer Ember CLIs
      this.ui.writeDeprecateLine(
        'Putting the "includePolyfill" option in "babel" is deprecated, please put it in "ember-cli-babel" instead.');
    }

    if (customOptions && 'includePolyfill' in customOptions) {
      return customOptions.includePolyfill === true;
    } else if (babelOptions && 'includePolyfill' in babelOptions) {
      return babelOptions.includePolyfill === true;
    } else {
      return false;
    }
  },

  _importPolyfill: function(app) {
    let polyfillPath = 'vendor/ember-cli-babel/polyfill.js';

    if (this.import) {  // support for ember-cli >= 2.7
      this.import(polyfillPath, { prepend: true });
    } else if (app.import) { // support ember-cli < 2.7
      app.import(polyfillPath, { prepend: true });
    } else {
      console.warn('Please run: ember install ember-cli-import-polyfill');
    }
  },

  _requiredPolyfills() {
    const parseTargets = require('babel-preset-env/').getTargets;
    const builtInsList = require('babel-preset-env/data/built-ins');
    const defaultWebIncludes = require('babel-preset-env/lib/default-includes').defaultWebIncludes;
    const normalizeOptions = require('babel-preset-env/lib/normalize-options').default;

    let config = this._getAddonOptions();
    let addonProvidedConfig = this._getAddonProvidedConfig(config);
    let presetOptions = this._getPresetEnvOptions(addonProvidedConfig);
    let validatedOptions = normalizeOptions(presetOptions);
    let targets = parseTargets(validatedOptions.targets);

    let polyfillTargets = Object.assign({}, targets);
    delete polyfillTargets.uglify;

    let polyfills = Object.keys(builtInsList)
        .concat(defaultWebIncludes)
        .filter((item) => {
          let isDefault = defaultWebIncludes.indexOf(item) >= 0;
          let notExcluded = validatedOptions.exclude.indexOf(item) === -1;

          if (isDefault) { return notExcluded; }

          let isRequired = this.isPluginRequired(builtInsList[item]);

          return isRequired && notExcluded;
        })
        .concat(validatedOptions.include);

    return polyfills;
  },

  treeForVendor: function() {
    if (!this._shouldIncludePolyfill()) { return; }

    const MergeTrees = require('broccoli-merge-trees');
    const UnwatchedDir = require('broccoli-source').UnwatchedDir;
    const CreateFile = require('broccoli-file-creator');
    const Rollup = require('broccoli-rollup');


    let requiredPolyfills = this._requiredPolyfills();
    let polyFillImports = requiredPolyfills
        .map(module => `import "./${module}"`)
        .join('\n');
    let entryPointContents = `;
if (global._includedPolyfill) {
  throw new Error("only one instance of ember-cli-babel can have \`includePolyfill\` set");
}
global._includedPolyfill = true;
${polyFillImports}`;

    let entryPointTree = new CreateFile('index.js', entryPointContents);

    // Find babel-core's browser polyfill and use its directory as our vendor tree
    let coreJSDir = path.dirname(require.resolve('core-js/package'));
    let coreJSModulesDir = path.join(coreJSDir, 'modules');
    let coreJSModulesTree = new UnwatchedDir(coreJSModulesDir);
    let combinedTree = new MergeTrees([coreJSModulesTree, entryPointTree]);

    const resolve = require('rollup-plugin-node-resolve');
    const commonjs = require('rollup-plugin-commonjs');

    let outputTree = new Rollup(combinedTree, {
      rollup: {
        plugins: [
          resolve({ main: true }),
          commonjs()
        ],
        format: 'umd',
        entry: 'index.js',
        dest: 'ember-cli-babel/polyfill.js',
        sourceMap: false
      }
    });

    return outputTree;
  },

  included: function(app) {
    this._super.included.apply(this, arguments);
    this.app = app;

    if (this._shouldIncludePolyfill()) {
      this._importPolyfill(app);
    }
  },

  isPluginRequired(plugin) {
    let targets = this._getTargets();

    // if no targets are setup, assume that all plugins are required
    if (!targets) { return true; }

    const isPluginRequired = require('babel-preset-env').isPluginRequired;

    if (typeof plugin === 'string') {
      const pluginList = require('babel-preset-env/data/plugins');
      plugin = pluginList[plugin];
    }

    return isPluginRequired(targets, plugin);
  },

  _getAddonOptions: function() {
    return (this.parent && this.parent.options) || (this.app && this.app.options) || {};
  },

  _parentName() {
    let parentName;

    if (this.parent) {
      if (typeof this.parent.name === 'function') {
        parentName = this.parent.name();
      } else {
        parentName = this.parent.name;
      }
    }

    return parentName;
  },

  _getAddonProvidedConfig(addonOptions) {
    let babelOptions = clone(addonOptions.babel || {});

    // used only to support using ember-cli-babel@6 at the
    // top level (app or addon during development) on ember-cli
    // older than 2.13
    //
    // without this, we mutate the same shared `options.babel.plugins`
    // that is used to transpile internally (via `_prunedBabelOptions`
    // in older ember-cli versions)
    let babel6Options = clone(addonOptions.babel6 || {});

    let options;
    // options.modules is set only for things assuming babel@5 usage
    if (babelOptions.modules) {
      // using babel@5 configuration with babel@6
      // without overriding here we would trigger
      // an error
      options = Object.assign({}, babel6Options);
    } else {
      // shallow merge both babelOptions and babel6Options
      // (plugins/postTransformPlugins are handled separately)
      options = Object.assign({}, babelOptions, babel6Options);
    }

    let plugins = [].concat(babelOptions.plugins, babel6Options.plugins).filter(Boolean);
    let postTransformPlugins = [].concat(babelOptions.postTransformPlugins, babel6Options.postTransformPlugins).filter(Boolean);

    return {
      options,
      plugins,
      postTransformPlugins
    };
  },

  _getBabelOptions(config) {
    let addonProvidedConfig = this._getAddonProvidedConfig(config);
    let shouldCompileModules = this._shouldCompileModules(config);

    let providedAnnotation = config['ember-cli-babel'] && config['ember-cli-babel'].annotation;

    let sourceMaps = false;
    if (config.babel && 'sourceMaps' in config.babel) {
      sourceMaps = config.babel.sourceMaps;
    }

    let options = {
      annotation: providedAnnotation || `Babel: ${this._parentName()}`,
      sourceMaps
    };

    let userPlugins = addonProvidedConfig.plugins;
    let userPostTransformPlugins = addonProvidedConfig.postTransformPlugins;

    options.plugins = [].concat(
      userPlugins,
      this._getDebugMacroPlugins(config),
      this._getEmberModulesAPIPolyfill(config),
      shouldCompileModules && this._getModulesPlugin(),
      this._getPresetEnvPlugins(addonProvidedConfig),
      userPostTransformPlugins
    ).filter(Boolean);

    if (shouldCompileModules) {
      options.moduleIds = true;
      options.resolveModuleSource = require('amd-name-resolver').moduleResolve;
    }

    options.highlightCode = false;
    options.babelrc = false;

    return options;
  },

  _getDebugMacroPlugins(config) {
    let addonOptions = config['ember-cli-babel'] || {};

    if (addonOptions.disableDebugTooling) { return; }

    const DebugMacros = require('babel-plugin-debug-macros').default;
    const isProduction = process.env.EMBER_ENV === 'production';

    let options = {
      envFlags: {
        source: '@glimmer/env',
        flags: { DEBUG: !isProduction, CI: !!process.env.CI }
      },

      externalizeHelpers: {
        global: 'Ember'
      },

      debugTools: {
        source: '@ember/debug',
        assertPredicateIndex: 1
      }
    };

    return [[DebugMacros, options]];
  },

  _getEmberModulesAPIPolyfill(config) {
    let addonOptions = config['ember-cli-babel'] || {};

    if (addonOptions.disableEmberModulesAPIPolyfill) { return; }

    if (this._emberVersionRequiresModulesAPIPolyfill()) {
      const ModulesAPIPolyfill = require('babel-plugin-ember-modules-api-polyfill');

      return [[ModulesAPIPolyfill, { blacklist: { '@ember/debug': ['assert', 'deprecate', 'warn']} }]];
    }
  },

  _getPresetEnvOptions(config) {
    let options = config.options;

    let targets = this._getTargets();
    let browsers = targets && targets.browsers;
    let presetOptions = Object.assign({}, options, {
      modules: false,
      targets
    });

    return presetOptions;
  },

  _getPresetEnvPlugins(config) {
    let presetOptions = this._getPresetEnvOptions(config);
    let presetEnvPlugins = this._presetEnv(null, presetOptions).plugins;

    presetEnvPlugins.forEach(function(pluginArray) {
      let Plugin = pluginArray[0];
      addBaseDir(Plugin);
    });

    return presetEnvPlugins;
  },

  _presetEnv() {
    const presetEnv = require('babel-preset-env').default;

    return presetEnv.apply(null, arguments);
  },

  _getTargets() {
    let targets = this.project && this.project.targets && this.project.targets;

    let parser = require('babel-preset-env/lib/targets-parser').default;
    if (typeof targets === 'object' && targets !== null) {
      return parser(targets);
    } else {
      return targets;
    }
  },

  _getModulesPlugin() {
    const ModulesTransform = require('babel-plugin-transform-es2015-modules-amd');

    addBaseDir(ModulesTransform);

    return [
      [ModulesTransform, { noInterop: true }],
    ];
  },

  /*
   * Used to discover if the addon's current configuration will compile modules
   * or not.
   *
   * @public
   * @method shouldCompileModules
   */
  shouldCompileModules() {
    return this._shouldCompileModules(this._getAddonOptions());
  },

  // will use any provided configuration
  _shouldCompileModules(options) {
    let addonOptions = options['ember-cli-babel'];
    let babelOptions = options.babel;

    if (addonOptions && 'compileModules' in addonOptions) {
      return addonOptions.compileModules;
    } else if (babelOptions && 'compileModules' in babelOptions) {
      if (this._shouldShowBabelDeprecations && !this._compileModulesDeprecationPrinted) {
        this._compileModulesDeprecationPrinted = true;
        // we can use writeDeprecateLine() here because the warning will only be shown on newer Ember CLIs
        this.ui.writeDeprecateLine('Putting the "compileModules" option in "babel" is deprecated, please put it in "ember-cli-babel" instead.');
      }

      return babelOptions.compileModules;
    } else {
      return this.emberCLIChecker.gt('2.12.0-alpha.1');
    }
  },

  _emberVersionRequiresModulesAPIPolyfill() {
    // once a version of Ember ships with the
    // emberjs/rfcs#176 modules natively this will
    // be updated to detect that and return false
    return true;
  }
};
