const path = require('path')
const TerserPlugin = require('terser-webpack-plugin')
require('dotenv').config()

const ASSET_PATH = process.env.ASSET_PATH || '/edf-reader/'

module.exports = {
    mode: 'production',
    entry: {
        'edf-reader': { import: path.join(__dirname, 'src', 'index.ts') },
        // The reader worker (edf.worker) is auto-emitted from the `new Worker(new URL(...))` reference in EdfImporter.
        // The writer worker has no such reference (the exporter's worker is injected by the host), so it needs an
        // explicit entry to be bundled, the same way core builds its workers.
        'edf.writer.worker': { import: path.join(__dirname, 'src', 'workers', 'edf.writer.worker.ts') },
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: {
                    loader: 'ts-loader',
                    options: {
                        // Suppress declaration-file emit during the webpack pass.
                        // Full type-checking and .d.ts generation are handled by build:tsc.
                        transpileOnly: true,
                    },
                },
                exclude: '/node_modules/',
            },
        ],
    },
    optimization: {
        minimize: true,
        minimizer: [
            new TerserPlugin(),
        ],
        splitChunks: false,
    },
    output: {
        path: path.resolve(__dirname, 'umd'),
        publicPath: ASSET_PATH,
        library: 'EpiCEdfReader',
        libraryTarget: 'umd',
    },
    resolve: {
        extensions: ['.ts', '.js', '.json'],
        alias: {
            '#root': path.resolve(__dirname, './'),
            '#edf': path.resolve(__dirname, 'src', 'edf'),
            '#types': path.resolve(__dirname, 'src', 'types'),
            '#util': path.resolve(__dirname, 'src', 'util'),
        },
        symlinks: true
    },
}
