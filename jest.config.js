const path = require('path')

module.exports = {
    rootDir: path.resolve(__dirname, './'),
    coverageDirectory: "<rootDir>/tests/coverage/",
    extensionsToTreatAsEsm: ['.ts'],
    globals: {
        'ts-jest': {
            useESM: true,
            tsconfig: {
                "target": "es2020",
                "module": "esnext",
                "lib": [
                    "es5", "es6", "esnext",
                    "dom", "webworker"
                ],
                "strict": true,
                "noImplicitReturns": true,
                "moduleResolution": "node",
                "baseUrl": "./",
                "paths": {
                    "#root/*": ["./*"],
                    "#*": ["src/*"],
                }
            }
        },
    },
    moduleFileExtensions: [
        "js",
        "ts",
        "json",
    ],
    moduleNameMapper: {
        "^#root/(.*)$": "<rootDir>/$1",
        "^#(.*)$": "<rootDir>/src/$1",
    },
    modulePaths: [
        "<rootDir>/src/",
    ],
    preset: "ts-jest/presets/js-with-ts",
    roots: [
        "<rootDir>/tests/",
    ],
    transform: {
        "^.+\\.js$": "babel-jest",
        "^.+\\.ts$": "ts-jest",
    },
    transformIgnorePatterns: [
        "node_modules/(?!(@epicurrents)/)",
    ],
    //testRegex: "(test/.*|(\\.|/)(test|spec))\\.(tsx?)$",
    testRegex: "tests.ts$",
    testEnvironment: "jsdom",
    testEnvironmentOptions: {
        browsers: [
            "chrome",
            "firefox",
            "safari"
        ],
        url: "http://localhost/"
    }
}
