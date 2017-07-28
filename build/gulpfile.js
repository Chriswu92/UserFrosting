"use strict";

// Load environment variables
require('dotenv').config({path: '../app/.env'});

/**
 * Global dependencies
 */
const gulp = require('gulp');
const fs = require('fs-extra');
const del = require('del');
const plugins = require('gulp-load-plugins')();

// Set up logging
let doILog = (process.env.UF_MODE == "dev");
let logger = (message) => {
    if (doILog) {
        console.log(message);
    }
};

const sprinklesDir = '../app/sprinkles';

// The Sprinkle load order from sprinkles.json
const sprinkles = ['core'].concat(require(`${sprinklesDir}/sprinkles.json`)['base']);

// The directory where the bundle task should place compiled assets. 
// The names of assets in bundle.result.json will be located relative to this path.
const publicAssetsDir = '../public/assets/';

// name of the bundle file
const bundleFile = 'bundle.config.json';

// Compiled bundle config file
const bundleConfigFile = `./${bundleFile}`;

/**
 * Vendor asset task
 */
gulp.task('assets-install', [ 'assets-clean' ], () => {
    "use strict";

    let mergePkg = require("@userfrosting/merge-package-dependencies");

    // See if there are any yarn packages.
    let yarnPaths = [];
    for (let sprinkle of sprinkles) {
        if (fs.existsSync(`../app/sprinkles/${sprinkle}/package.json`)) {
            yarnPaths.push(`../app/sprinkles/${sprinkle}/package.json`);
        }
    }
    if (yarnPaths.length > 0) {
        // Yes there are!

        // Generate package.json
        let yarnTemplate = {// May seem overboard, but it seems the terminal clean when logging is enabled.
            name: "uf-vendor-assets",
            description: "Auto-generated assets dependency package for project.",
            author: [],
            contributors: [],
            version: "1.0.0",
            keywords: [],
            repository: "https://github.com/userfrosting/UserFrosting.git",
            flat: true,
            bugs: "https://github.com/userfrosting/UserFrosting/issues",
            license: "UNLICENSED",
            homepage: "https://www.userfrosting.com/",
            dependencies: {},
            engines: {}
        };
        logger("\nMerging packages...\n");
        mergePkg.yarn(yarnTemplate, yarnPaths, '../app/assets/', doILog);
        logger("\nMerge complete.\n");

        // Perform installation.
        logger("Installing npm/yarn assets...");
        let execa = require("execa");
        execa.shellSync("yarn install --flat --no-lockfile", {
            cwd: "../app/assets",
            preferLocal: true,
            localDir: "./node_modules/.bin",
            stdio: "inherit"// MUST always log. Only way to see errors.
        });
    }

    // See if there are any bower packages.
    let bowerPaths = [];
    for (let sprinkle of sprinkles) {
        // bower
        if (fs.existsSync(`../app/sprinkles/${sprinkle}/bower.json`)) {
            console.warn(`DEPRECATED: Detected bower.json in ${sprinkle} Sprinkle. Support for bower (bower.json) will be removed in the future, please use npm/yarn (package.json) instead.`);
            bowerPaths.push(`../app/sprinkles/${sprinkle}/bower.json`);
        }
    }
    if (bowerPaths.length > 0) {
        // Yes there are!

        // Generate bower.json
        let bowerTemplate = {
            name: "uf-vendor-assets"
        };
        logger("\nMerging packages...\n");
        mergePkg.bower(bowerTemplate, bowerPaths, '../app/assets/', doILog);
        logger("\nMerge complete.\n");

        // Perform installation
        let execa = require("execa");
        execa.shellSync("bower install --allow-root", {
            cwd: "../app/assets",
            preferLocal: true,
            localDir: "./node_modules/.bin",
            stdio: "inherit"// MUST always log. Only way to see errors.
        });
        // Yarn is able to output its completion. Bower... not so much.
        logger("Done.\n");
    }
});


/**
 * Bundling tasks
 */

// Executes bundleing tasks according to bundle.config.json files in each Sprinkle, as per Sprinkle load order.
// Respects bundle collision rules.
gulp.task('bundle-build', () => {
    "use strict";
    let copy = require('recursive-copy');
    let merge = require('merge-array-object');
    let cleanup = (e) => {
        "use strict";
        // Delete temporary directory if exists
        fs.rmdirSync("./temp");
        // Delete created bundle.config.json file
        fs.unlinkSync(bundleConfigFile);
        // Propagate error
        throw e;
    };
    let config = {
        bundle: {},
        copy: []
    };
    sprinkles.forEach((sprinkle) => {
        "use strict";
        let location = `${sprinklesDir}/${sprinkle}/`;
        if (fs.existsSync(`${location}${bundleFile}`)) {
            let currentConfig = require(`${location}${bundleFile}`);
            // Add bundles to config, respecting collision rules.
            for (let bundleName in currentConfig.bundle) {
                // If bundle already defined, handle as per collision rules.
                if (bundleName in config.bundle) {
                    let onCollision = 'replace';
                    try {
                        onCollision = (typeof currentConfig.bundle[bundleName].options.sprinkle.onCollision !== 'undefined' ? currentConfig.bundle[bundleName].options.sprinkle.onCollision : 'replace');
                    }
                    catch (e) {

                    }
                    switch (onCollision) {
                        case 'replace':
                            config.bundle[bundleName] = currentConfig.bundle[bundleName];
                            break;
                        case 'merge':
                            // If using this collision rule, keep in mind any bundling options will also be merged.
                            // Inspect the produced 'bundle.config.json' file in the 'build' folder to ensure options are correct.
                            config.bundle[bundleName] = merge(config.bundle[bundleName], currentConfig.bundle[bundleName]);
                            break;
                        case 'ignore':
                            // Do nothing. This simply exists to prevent falling through to error catchment.
                            break;
                        case 'error':
                            cleanup(`The bundle '${bundleName}' in the Sprinkle '${sprinkle}' has been previously defined, and the bundle's 'onCollision' property is set to 'error'.`);
                        default:
                            cleanup(`Unexpected input '${onCollision}' for 'onCollision' for the bundle '${bundleName}' in the Sprinkle '${sprinkle}'.`);
                    }
                }
                // Otherwise, just add.
                else {
                    config.bundle[bundleName] = currentConfig.bundle[bundleName];
                }
            }
            // Add/merge copy files to config
            if ('copy' in currentConfig) {
                config.copy = new Set(config.copy, currentConfig.copy);
            }
        }
    });
    // Save bundle rules to bundle.config.json
    fs.writeFileSync(bundleConfigFile, JSON.stringify(config));

    // Copy vendor assets (bower, then npm)
    /** @todo Should really keep the garbage files out. A filter function can be passed to the copySync settings object. */
    let paths = [
        '../app/assets/bower_components/',
        '../app/assets/node_modules/'
    ];
    for (let path of paths) {
        fs.copySync(path, `${publicAssetsDir}vendor/`, { overwrite: true });
    }
    // Copy sprinkle assets
    paths = [];
    for (let sprinkle of sprinkles) {
        paths.push(`../app/sprinkles/${sprinkle}/assets/`);
    }
    for (let path of paths) {
        fs.copySync(path, '../public/assets/', { overwrite: true });
    }
    return;
});

// Execute gulp-bundle-assets
gulp.task('bundle', () => {
    "use strict";
    return gulp.src(bundleConfigFile)
        .pipe(plugins.ufBundleAssets({
            base: publicAssetsDir
        }))
        .pipe(plugins.ufBundleAssets.results({
            dest: './'
        }))
        .pipe(gulp.dest(publicAssetsDir));
});



/**
 * Clean up tasks
 */

gulp.task('public-clean', () => {
    "use strict";
    return del(publicAssetsDir, { force: true });
});

// Clean up temporary bundling files
gulp.task('bundle-clean', () => {
    "use strict";
    return del(bundleConfigFile, { force: true });
});

// Deletes assets fetched by assets-install
gulp.task('assets-clean', () => {
    "use strict";
    return del(['../app/assets/bower_components/', '../app/assets/node_modules/', '../app/assets/bower.json', '../app/assets/package.json'], { force: true });
});

// Deletes all generated, or acquired files.
gulp.task('clean', ['public-clean', 'bundle-clean', 'assets-clean'], () => { });